import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { KeyPair } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
} from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import { validateCitySeed, type ChainPlotV2 } from "@estate/shared";
import { z } from "zod";
import { ChainReader } from "../apps/web/src/chain-reader.js";
import { readActiveVersion2Release } from "./testnet-v2-release-context.js";

const mode = process.argv[2];
if (mode !== "--plan" && mode !== "--apply" && mode !== "--verify")
  throw new Error("Pass --plan, --apply or --verify");

const root = resolve(import.meta.dirname, "..");
const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
) as {
  network: string;
  contractId: string;
  wasmSha256: string;
  citySeedVersion: number;
};
assert.equal(deployment.network, "testnet");
const seed = validateCitySeed(
  JSON.parse(
    readFileSync(resolve(root, "contracts/estate/seed-v2.json"), "utf8"),
  ),
);
assert.equal(seed.version, 2);

type Credential = {
  account_id: string;
  public_key: string;
  secret_key: `ed25519:${string}`;
  path: string;
};
function credential(name: "DRIVER"): Credential {
  const path = process.env[`ESTATE_${name}_KEY_FILE`];
  if (!path || !path.startsWith("/"))
    throw new Error(`Set ESTATE_${name}_KEY_FILE to a private absolute path`);
  const actual = realpathSync(path);
  if (actual.startsWith(`${root}/`))
    throw new Error(`${name} credential must stay outside the repository`);
  if ((statSync(actual).mode & 0o077) !== 0)
    throw new Error(`${name} credential must be private`);
  const value = JSON.parse(readFileSync(actual, "utf8")) as Omit<
    Credential,
    "path"
  >;
  assert.match(value.account_id, /^[a-z0-9._-]+\.testnet$/);
  assert.equal(
    KeyPair.fromString(value.secret_key).getPublicKey().toString(),
    value.public_key,
  );
  return { ...value, path: actual };
}

type Pending = {
  accountId: string;
  method: string;
  label: string;
  hash: string;
  signedBase64: string;
};
type Transaction = {
  accountId: string;
  method: string;
  label: string;
  hash: string;
};
type WidthStep = {
  units: 1 | 2 | 3;
  plotId: string;
  slot: number;
  carId: number;
  balanceBefore: string;
  durabilityBefore: number;
  sessionId: number | null;
  balanceAfter: string | null;
  completed: boolean;
};
type Journal = {
  contractId: string;
  releaseRecord: string;
  driverId: string;
  parkDurabilityCost: number;
  pending: Pending | null;
  transactions: Transaction[];
  steps: WidthStep[];
  completed: boolean;
};

const reader = new ChainReader(deployment.contractId);
const recordPath = process.argv[3];
if (!recordPath || !recordPath.startsWith("/"))
  throw new Error("Pass an absolute version-2 release-record path");
const release = JSON.parse(readFileSync(recordPath, "utf8")) as {
  contractId: string;
  status: string;
  reopenedAtMs?: number;
};
assert.equal(release.contractId, deployment.contractId);

async function requireActiveCity() {
  assert.equal(
    await reader.cityVersion(),
    2,
    "Version-2 city has not been deployed",
  );
  assert.equal(
    await reader.view("is_paused", {}, z.boolean()),
    false,
    "City remains paused",
  );
  readActiveVersion2Release(root, recordPath, deployment);
}

function assertSeedGeometry(plots: ChainPlotV2[]): void {
  assert.equal(plots.length, seed.plots.length);
  const byId = new Map(plots.map((view) => [view.plot.id, view.plot]));
  for (const expected of seed.plots) {
    const actual = byId.get(expected.id);
    assert(actual, `Missing ${expected.id}`);
    assert.equal(actual.road_id, expected.roadId);
    assert.equal(actual.side, expected.side);
    assert.equal(actual.index, expected.index);
    assert.equal(actual.frontage_units, expected.frontageUnits);
    assert.equal(actual.corner, expected.corner);
  }
}

async function openStepTargets(): Promise<
  Array<{ units: 1 | 2 | 3; plotId: string; slot: number }>
> {
  const plots = await reader.plots();
  assert(plots.every((view) => "frontage_units" in view.plot));
  const variable = plots as ChainPlotV2[];
  assertSeedGeometry(variable);
  const targets: Array<{ units: 1 | 2 | 3; plotId: string; slot: number }> = [];
  for (const units of [1, 2, 3] as const) {
    const candidates = variable.filter(
      (view) =>
        view.plot.frontage_units === units &&
        view.plot.owner === null &&
        view.effective_rule.kind === "Free" &&
        view.plot.pending_rule === null,
    );
    let chosen: (typeof targets)[number] | undefined;
    for (const view of candidates) {
      const street = await reader.streetSide(view.plot.road_id, view.plot.side);
      const entry = street.plots.find(
        (item) => item.plot.plot.id === view.plot.id,
      );
      assert(entry);
      assert.equal(entry.slots.length, units);
      if (entry.slots[units - 1] === null) {
        chosen = { units, plotId: view.plot.id, slot: units - 1 };
        break;
      }
    }
    assert(chosen, `No empty public ${units}-unit Free plot`);
    targets.push(chosen);
  }
  return targets;
}

function save(path: string, state: Journal) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

async function confirmPending(state: Journal, path: string) {
  const pending = state.pending;
  if (!pending) return;
  let outcome = await reader.transactionStatus(pending.hash, pending.accountId);
  if (outcome === "unknown") {
    try {
      outcome = await reader.sendSignedTransaction(pending.signedBase64);
    } catch {
      // Reconcile the same signed bytes and hash after a lost RPC response.
    }
  }
  for (
    let attempt = 0;
    (outcome === "unknown" || outcome === "pending") && attempt < 8;
    attempt++
  ) {
    await new Promise((done) => setTimeout(done, 1_000));
    outcome = await reader.transactionStatus(pending.hash, pending.accountId);
  }
  if (outcome === "failure") {
    state.pending = null;
    save(path, state);
    throw new Error(`${pending.method} transaction ${pending.hash} failed`);
  }
  if (outcome !== "success")
    throw new Error(`${pending.method} transaction ${pending.hash} is pending`);
  state.transactions.push({
    accountId: pending.accountId,
    method: pending.method,
    label: pending.label,
    hash: pending.hash,
  });
  state.pending = null;
  save(path, state);
}

async function submit(
  state: Journal,
  path: string,
  signer: Credential,
  method: "park" | "collect",
  label: string,
  args: Record<string, unknown>,
) {
  assert.equal(state.pending, null);
  const access = await reader.accessKey(signer.account_id, signer.public_key);
  const transaction = createTransaction(
    signer.account_id,
    KeyPair.fromString(signer.secret_key).getPublicKey(),
    deployment.contractId,
    access.nonce + 1n,
    [actionCreators.functionCall(method, args, 60n * 10n ** 12n, 0n)],
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    signer.secret_key,
  ).signTransaction(transaction);
  state.pending = {
    accountId: signer.account_id,
    method,
    label,
    hash: baseEncode(hashBytes),
    signedBase64: Buffer.from(encodeTransaction(signed)).toString("base64"),
  };
  save(path, state);
  await confirmPending(state, path);
}

async function checkStep(step: WidthStep, driverId: string) {
  const view = await reader.plot(step.plotId);
  assert(view && "frontage_units" in view.plot);
  assert.equal(view.plot.frontage_units, step.units);
  assert.equal(view.plot.owner, null);
  assert.equal(view.effective_rule.kind, "Free");
  const street = await reader.streetSide(view.plot.road_id, view.plot.side);
  const entry = street.plots.find((item) => item.plot.plot.id === step.plotId);
  assert(entry);
  assert.equal(entry.slots.length, step.units);
  const session = entry.slots[step.slot];
  if (step.sessionId === null)
    assert.equal(session, null, "Chosen curb is occupied");
  else if (!step.completed) {
    assert(session);
    assert.equal(session.id, step.sessionId);
    assert.equal(session.driver, driverId);
    assert.equal(session.legal, true);
    assert.equal(session.slot, step.units - 1);
  } else assert.equal(session, null, "Collected curb is still occupied");
}

async function main() {
  const version = await reader.cityVersion();
  if (mode === "--plan" && (version !== 2 || release.status !== "active")) {
    console.log(
      JSON.stringify(
        {
          status: "waiting_for_active_version_2",
          cityVersion: version,
          releaseStatus: release.status,
        },
        null,
        2,
      ),
    );
    return;
  }
  await requireActiveCity();
  const parkDurabilityCost = (
    await reader.view(
      "get_config",
      {},
      z.object({ park_durability_cost: z.number().int().positive() }),
    )
  ).park_durability_cost;
  if (mode === "--plan") {
    console.log(
      JSON.stringify(
        {
          contractId: deployment.contractId,
          releaseRecord: recordPath,
          targets: await openStepTargets(),
          action: "park and collect on the last curb of each plot width",
          parkDurabilityCost,
        },
        null,
        2,
      ),
    );
    return;
  }
  const driver = credential("DRIVER");
  const journalPath = resolve(
    dirname(driver.path),
    "variable-width-journey-journal.json",
  );
  let state: Journal;
  if (existsSync(journalPath)) {
    state = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    assert.equal(state.contractId, deployment.contractId);
    assert.equal(state.releaseRecord, realpathSync(recordPath));
    assert.equal(state.driverId, driver.account_id);
    assert.equal(state.parkDurabilityCost, parkDurabilityCost);
  } else {
    if (mode === "--verify")
      throw new Error("No variable-width journey journal");
    const player = await reader.player(driver.account_id);
    assert(player.account, "Driver must be registered before the journey");
    assert.equal(
      player.active_session,
      null,
      "Driver has an active parking session",
    );
    const car = player.cars.find(
      (item) => item.durability >= 3 * parkDurabilityCost,
    );
    assert(car, "Driver needs a car with enough durability for three parks");
    const targets = await openStepTargets();
    state = {
      contractId: deployment.contractId,
      releaseRecord: realpathSync(recordPath),
      driverId: driver.account_id,
      parkDurabilityCost,
      pending: null,
      transactions: [],
      steps: targets.map((target) => ({
        ...target,
        carId: car.id,
        balanceBefore: "",
        durabilityBefore: 0,
        sessionId: null,
        balanceAfter: null,
        completed: false,
      })),
      completed: false,
    };
    save(journalPath, state);
  }
  if (mode === "--apply") await confirmPending(state, journalPath);
  if (mode === "--verify") {
    assert(state.completed, "Journey has not completed");
    assert.equal(state.steps.length, 3);
    for (const step of state.steps) {
      assert(step.completed);
      assert(BigInt(step.balanceAfter!) > BigInt(step.balanceBefore));
      await checkStep(step, driver.account_id);
    }
    for (const tx of state.transactions)
      assert.equal(
        await reader.transactionStatus(tx.hash, tx.accountId),
        "success",
      );
    console.log(
      JSON.stringify({
        status: "verified",
        widths: state.steps.map((step) => step.units),
        transactions: state.transactions.length,
      }),
    );
    return;
  }
  for (const step of state.steps) {
    if (step.completed) continue;
    const player = await reader.player(driver.account_id);
    assert(player.account);
    if (step.sessionId === null) {
      if (step.balanceBefore === "") {
        assert.equal(
          player.active_session,
          null,
          "Driver is parked outside this journey",
        );
        const car = player.cars.find((item) => item.id === step.carId);
        assert(
          car && car.durability >= parkDurabilityCost,
          "Journey car needs repair",
        );
        step.balanceBefore = player.account.balance;
        step.durabilityBefore = car.durability;
        save(journalPath, state);
      }
      if (!state.transactions.some((tx) => tx.label === `park:${step.units}`)) {
        await checkStep(step, driver.account_id);
        await submit(state, journalPath, driver, "park", `park:${step.units}`, {
          car_id: step.carId,
          plot_id: step.plotId,
          slot: step.slot,
        });
      }
      const afterPark = await reader.player(driver.account_id);
      assert(afterPark.active_session && afterPark.account);
      assert.equal(afterPark.active_session.location_id, step.plotId);
      assert.equal(afterPark.active_session.slot, step.slot);
      assert.equal(afterPark.active_session.legal, true);
      assert.equal(
        afterPark.cars.find((item) => item.id === step.carId)?.durability,
        step.durabilityBefore - parkDurabilityCost,
      );
      step.sessionId = afterPark.active_session.id;
      save(journalPath, state);
    }
    const alreadyCollected = state.transactions.some(
      (tx) => tx.label === `collect:${step.units}`,
    );
    if (!alreadyCollected) {
      await checkStep(step, driver.account_id);
      await new Promise((done) => setTimeout(done, 2_200));
      await submit(
        state,
        journalPath,
        driver,
        "collect",
        `collect:${step.units}`,
        { expected_session_id: step.sessionId },
      );
    }
    const after = await reader.player(driver.account_id);
    assert(after.account);
    assert.equal(after.active_session, null);
    assert(
      BigInt(after.account.balance) > BigInt(step.balanceBefore),
      "Collect paid no coins",
    );
    step.balanceAfter = after.account.balance;
    step.completed = true;
    save(journalPath, state);
    await checkStep(step, driver.account_id);
  }
  state.completed = true;
  save(journalPath, state);
  const evidence = {
    network: "testnet",
    contractId: state.contractId,
    releaseRecord: state.releaseRecord,
    driverId: state.driverId,
    widths: state.steps.map(
      ({ units, plotId, slot, sessionId, balanceBefore, balanceAfter }) => ({
        units,
        plotId,
        slot,
        sessionId,
        balanceBefore,
        balanceAfter,
      }),
    ),
    transactions: state.transactions,
    verifiedAt: new Date().toISOString(),
  };
  writeFileSync(
    resolve(root, "deployments/testnet-variable-width-journey.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));
}

await main();
