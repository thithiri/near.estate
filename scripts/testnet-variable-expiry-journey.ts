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
import { type ChainPlotV2, type ChainSession } from "@estate/shared";
import { z } from "zod";
import { ChainReader } from "../apps/web/src/chain-reader.js";
import { readActiveVersion2Release } from "./testnet-v2-release-context.js";

const mode = process.argv[2];
if (mode !== "--plan" && mode !== "--apply" && mode !== "--verify")
  throw new Error("Pass --plan, --apply or --verify");
const recordPath = process.argv[3];
if (!recordPath || !recordPath.startsWith("/"))
  throw new Error("Pass an absolute version-2 release-record path");

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
const release = JSON.parse(readFileSync(recordPath, "utf8")) as {
  contractId: string;
  status: string;
};
assert.equal(release.contractId, deployment.contractId);
const reader = new ChainReader(deployment.contractId);

type Credential = {
  account_id: string;
  public_key: string;
  secret_key: `ed25519:${string}`;
  path: string;
};
type Call = {
  actor: string;
  method: "park" | "settle_expired" | "collect";
  hash: string;
  signedBase64: string;
};
type Receipt = Pick<Call, "actor" | "method" | "hash">;
type Journal = {
  contractId: string;
  releaseRecord: string;
  firstDriverId: string;
  secondDriverId: string;
  plotId: string;
  roadId: ChainPlotV2["plot"]["road_id"];
  side: ChainPlotV2["plot"]["side"];
  slot: number;
  firstCarId: number;
  secondCarId: number;
  firstBalanceBefore: string;
  secondBalanceBefore: string;
  sessionId: number | null;
  expiresAt: number | null;
  expectedFirstPayout: string | null;
  secondSessionId: number | null;
  firstBalanceAfter: string | null;
  secondBalanceAfter: string | null;
  pending: Call | null;
  transactions: Receipt[];
  completed: boolean;
};

function credential(name: "OWNER" | "DRIVER"): Credential {
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

function save(path: string, state: Journal) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

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

async function target() {
  const plots = await reader.plots();
  assert(plots.every((view) => "frontage_units" in view.plot));
  const candidates = (plots as ChainPlotV2[]).filter(
    (view) =>
      view.plot.frontage_units === 1 &&
      view.plot.owner === null &&
      view.effective_rule.kind === "Free" &&
      view.plot.pending_rule === null,
  );
  for (const view of candidates) {
    const street = await reader.streetSide(view.plot.road_id, view.plot.side);
    const entry = street.plots.find(
      (item) => item.plot.plot.id === view.plot.id,
    );
    assert(entry && entry.slots.length === 1);
    if (entry.slots[0] === null)
      return {
        plotId: view.plot.id,
        roadId: view.plot.road_id,
        side: view.plot.side,
        slot: 0,
      };
  }
  throw new Error("No empty public one-unit Free curb");
}

async function curb(state: Journal) {
  const street = await reader.streetSide(state.roadId, state.side);
  const entry = street.plots.find((item) => item.plot.plot.id === state.plotId);
  assert(entry && entry.slots.length === 1, "One-unit curb changed");
  assert.equal(entry.plot.plot.owner, null, "Curb acquired during journey");
  assert.equal(entry.plot.effective_rule.kind, "Free");
  return entry.slots[0];
}

function cappedPayout(session: ChainSession): bigint {
  const terms = session.terms;
  assert.equal(session.legal, true);
  assert.equal(terms.meter_rate_per_hour, "0");
  return (
    (BigInt(terms.base_rate_per_hour) *
      BigInt(terms.tier_multiplier_bps) *
      BigInt(terms.legality_multiplier_bps) *
      BigInt(terms.facility_multiplier_bps) *
      BigInt(terms.earn_cap_seconds)) /
    (3_600n * 10_000n ** 3n)
  );
}

async function confirmPending(state: Journal, path: string) {
  const call = state.pending;
  if (!call) return;
  let outcome = await reader.transactionStatus(call.hash, call.actor);
  if (outcome === "unknown") {
    try {
      outcome = await reader.sendSignedTransaction(call.signedBase64);
    } catch {
      // A lost RPC reply must be reconciled using the same signed bytes.
    }
  }
  for (
    let attempt = 0;
    (outcome === "unknown" || outcome === "pending") && attempt < 8;
    attempt++
  ) {
    await new Promise((done) => setTimeout(done, 1_000));
    outcome = await reader.transactionStatus(call.hash, call.actor);
  }
  if (outcome !== "success")
    throw new Error(`${call.method} transaction ${call.hash} is ${outcome}`);
  state.transactions.push({
    actor: call.actor,
    method: call.method,
    hash: call.hash,
  });
  state.pending = null;
  save(path, state);
}

async function submit(
  state: Journal,
  path: string,
  signer: Credential,
  method: Call["method"],
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
    actor: signer.account_id,
    method,
    hash: baseEncode(hashBytes),
    signedBase64: Buffer.from(encodeTransaction(signed)).toString("base64"),
  };
  save(path, state);
  await confirmPending(state, path);
}

async function main() {
  const version = await reader.cityVersion();
  if (mode === "--plan" && (version !== 2 || release.status !== "active")) {
    console.log(
      JSON.stringify({
        status: "waiting_for_active_version_2",
        cityVersion: version,
        releaseStatus: release.status,
      }),
    );
    return;
  }
  await requireActiveCity();
  if (mode === "--plan") {
    const config = await reader.view(
      "get_config",
      {},
      z.object({
        earn_cap_seconds: z.number().int().positive(),
        expiry_grace_seconds: z.number().int().nonnegative(),
      }),
    );
    console.log(
      JSON.stringify(
        {
          status: "ready",
          contractId: deployment.contractId,
          target: await target(),
          waitSeconds: config.earn_cap_seconds + config.expiry_grace_seconds,
          action:
            "first driver parks, second driver settles after expiry and reuses the curb",
        },
        null,
        2,
      ),
    );
    return;
  }
  const first = credential("OWNER");
  const second = credential("DRIVER");
  assert.notEqual(first.account_id, second.account_id);
  const path = resolve(
    dirname(second.path),
    "variable-expiry-journey-journal.json",
  );
  let state: Journal;
  if (existsSync(path)) {
    state = JSON.parse(readFileSync(path, "utf8")) as Journal;
    assert.equal(state.contractId, deployment.contractId);
    assert.equal(state.releaseRecord, realpathSync(recordPath));
    assert.equal(state.firstDriverId, first.account_id);
    assert.equal(state.secondDriverId, second.account_id);
  } else {
    if (mode === "--verify") throw new Error("No version-2 expiry journal");
    const [firstPlayer, secondPlayer] = await Promise.all([
      reader.player(first.account_id),
      reader.player(second.account_id),
    ]);
    assert(
      firstPlayer.account && secondPlayer.account,
      "Both players must be registered",
    );
    assert.equal(firstPlayer.active_session, null);
    assert.equal(secondPlayer.active_session, null);
    const cost = (
      await reader.view(
        "get_config",
        {},
        z.object({ park_durability_cost: z.number().int().positive() }),
      )
    ).park_durability_cost;
    const firstCar = firstPlayer.cars.find((car) => car.durability >= cost);
    const secondCar = secondPlayer.cars.find((car) => car.durability >= cost);
    assert(firstCar && secondCar, "Both players need parkable cars");
    state = {
      contractId: deployment.contractId,
      releaseRecord: realpathSync(recordPath),
      firstDriverId: first.account_id,
      secondDriverId: second.account_id,
      ...(await target()),
      firstCarId: firstCar.id,
      secondCarId: secondCar.id,
      firstBalanceBefore: firstPlayer.account.balance,
      secondBalanceBefore: secondPlayer.account.balance,
      sessionId: null,
      expiresAt: null,
      expectedFirstPayout: null,
      secondSessionId: null,
      firstBalanceAfter: null,
      secondBalanceAfter: null,
      pending: null,
      transactions: [],
      completed: false,
    };
    save(path, state);
  }
  if (mode === "--apply") await confirmPending(state, path);
  if (mode === "--verify") {
    assert(state.completed, "Expiry journey has not completed");
    const evidencePath = resolve(
      root,
      "deployments/testnet-variable-expiry-journey.json",
    );
    assert(
      existsSync(evidencePath),
      "Completed expiry journey has no public evidence",
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
      oldSessionId: number;
      reusedSessionId: number;
      plotId: string;
      transactions: Receipt[];
    };
    assert.equal(evidence.plotId, state.plotId);
    assert.equal(evidence.oldSessionId, state.sessionId);
    assert.equal(evidence.reusedSessionId, state.secondSessionId);
    assert.deepEqual(evidence.transactions, state.transactions);
    assert.equal(state.transactions.length, 4);
    assert.deepEqual(
      state.transactions.map((tx) => [tx.actor, tx.method]),
      [
        [first.account_id, "park"],
        [second.account_id, "settle_expired"],
        [second.account_id, "park"],
        [second.account_id, "collect"],
      ],
    );
    assert.equal(await curb(state), null);
    assert.equal((await reader.player(first.account_id)).active_session, null);
    assert.equal((await reader.player(second.account_id)).active_session, null);
    assert.equal(
      BigInt(state.firstBalanceAfter!) - BigInt(state.firstBalanceBefore),
      BigInt(state.expectedFirstPayout!),
    );
    assert(
      BigInt(state.secondBalanceAfter!) > BigInt(state.secondBalanceBefore),
    );
    for (const tx of state.transactions)
      assert.equal(
        await reader.transactionStatus(tx.hash, tx.actor),
        "success",
      );
    console.log(JSON.stringify({ status: "verified", plotId: state.plotId }));
    return;
  }
  if (state.completed) {
    assert(
      existsSync(
        resolve(root, "deployments/testnet-variable-expiry-journey.json"),
      ),
      "Completed expiry journey has no public evidence",
    );
    console.log("Version-2 expiry journey already completed");
    return;
  }

  if (state.sessionId === null) {
    if (state.transactions.length === 0) {
      assert.equal(await curb(state), null);
      await submit(state, path, first, "park", {
        car_id: state.firstCarId,
        plot_id: state.plotId,
        slot: state.slot,
      });
    }
    const parked = (await reader.player(first.account_id)).active_session;
    assert(parked && parked.location_id === state.plotId);
    assert.equal(parked.slot, state.slot);
    assert.equal(parked.facility, "Curb");
    state.sessionId = parked.id;
    state.expiresAt = parked.expires_at;
    state.expectedFirstPayout = cappedPayout(parked).toString();
    save(path, state);
  }
  if (state.transactions.length === 1) {
    const parked = (await reader.player(first.account_id)).active_session;
    assert(parked && parked.id === state.sessionId);
    assert.equal((await curb(state))?.id, state.sessionId);
    const chainNow = await reader.chainTimeSeconds();
    if (chainNow < state.expiresAt!) {
      console.log(
        JSON.stringify({
          status: "waiting_for_expiry",
          plotId: state.plotId,
          sessionId: state.sessionId,
          expiresAt: state.expiresAt,
          chainNow,
        }),
      );
      return;
    }
    await submit(state, path, second, "settle_expired", {
      expected_session_id: state.sessionId,
    });
  }
  if (state.transactions.length === 2) {
    const settled = await reader.player(first.account_id);
    assert(settled.account);
    assert.equal(settled.active_session, null);
    assert.equal(await curb(state), null);
    assert.equal(
      BigInt(settled.account.balance) - BigInt(state.firstBalanceBefore),
      BigInt(state.expectedFirstPayout!),
      "Expired park did not pay the capped amount",
    );
    state.firstBalanceAfter = settled.account.balance;
    save(path, state);
    const secondBefore = await reader.player(second.account_id);
    assert.equal(secondBefore.active_session, null);
    await submit(state, path, second, "park", {
      car_id: state.secondCarId,
      plot_id: state.plotId,
      slot: state.slot,
    });
  }
  if (state.transactions.length === 3) {
    const reused = (await reader.player(second.account_id)).active_session;
    assert(reused && reused.location_id === state.plotId);
    assert.equal(reused.slot, state.slot);
    assert.equal(reused.facility, "Curb");
    state.secondSessionId = reused.id;
    save(path, state);
    assert.equal((await curb(state))?.id, reused.id);
    await new Promise((done) => setTimeout(done, 2_200));
    await submit(state, path, second, "collect", {
      expected_session_id: reused.id,
    });
  }
  assert.equal(state.transactions.length, 4);
  const secondAfter = await reader.player(second.account_id);
  assert(secondAfter.account);
  assert.equal(secondAfter.active_session, null);
  assert.equal(await curb(state), null);
  assert(
    BigInt(secondAfter.account.balance) > BigInt(state.secondBalanceBefore),
    "Reused park paid no coins",
  );
  state.secondBalanceAfter = secondAfter.account.balance;
  const evidence = {
    network: "testnet",
    contractId: state.contractId,
    releaseRecord: state.releaseRecord,
    firstDriverId: state.firstDriverId,
    secondDriverId: state.secondDriverId,
    plotId: state.plotId,
    slot: state.slot,
    oldSessionId: state.sessionId,
    oldExpiresAt: state.expiresAt,
    cappedPayoutAtomic: state.expectedFirstPayout,
    firstBalanceBefore: state.firstBalanceBefore,
    firstBalanceAfter: state.firstBalanceAfter,
    reusedSessionId: state.secondSessionId,
    secondBalanceBefore: state.secondBalanceBefore,
    secondBalanceAfter: state.secondBalanceAfter,
    transactions: state.transactions,
    finalSlotFree: true,
    verifiedAt: new Date().toISOString(),
  };
  writeFileSync(
    resolve(root, "deployments/testnet-variable-expiry-journey.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  state.completed = true;
  save(path, state);
  console.log(JSON.stringify(evidence, null, 2));
}

await main();
