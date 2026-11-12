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
const recordPath = process.argv[3];
if (!recordPath || !recordPath.startsWith("/"))
  throw new Error("Pass an absolute version-2 release-record path");
const releaseStatus = JSON.parse(readFileSync(recordPath, "utf8")) as {
  contractId: string;
  status: string;
};
assert.equal(releaseStatus.contractId, deployment.contractId);
const reader = new ChainReader(deployment.contractId);

type Credential = {
  account_id: string;
  public_key: string;
  secret_key: `ed25519:${string}`;
  path: string;
};
function ownerCredential(): Credential {
  const path = process.env.ESTATE_OWNER_KEY_FILE;
  if (!path || !path.startsWith("/"))
    throw new Error("Set ESTATE_OWNER_KEY_FILE to a private absolute path");
  const actual = realpathSync(path);
  if (actual.startsWith(`${root}/`))
    throw new Error("Owner credential must stay outside the repository");
  if ((statSync(actual).mode & 0o077) !== 0)
    throw new Error("Owner credential must be private");
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
  method: "buy_plot" | "choose_design";
  label: string;
  hash: string;
  signedBase64: string;
};
type Transaction = { method: Pending["method"]; label: string; hash: string };
type Step = {
  units: 1 | 3;
  plotId: string;
  initialDesignChoice: number;
  selectedDesignChoice: number;
  priceYocto: string;
  storageReserveYocto: string;
  totalYocto: string;
  purchased: boolean;
  designChosen: boolean;
};
type Journal = {
  contractId: string;
  releaseRecord: string;
  ownerId: string;
  coinBalanceBefore: string;
  pending: Pending | null;
  transactions: Transaction[];
  steps: Step[];
  completed: boolean;
};

function save(path: string, journal: Journal) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

async function confirm(journal: Journal, path: string, accountId: string) {
  const pending = journal.pending;
  if (!pending) return;
  let outcome = await reader.transactionStatus(pending.hash, accountId);
  if (outcome === "unknown") {
    try {
      outcome = await reader.sendSignedTransaction(pending.signedBase64);
    } catch {
      // Keep and reconcile the exact signed bytes after an RPC reply is lost.
    }
  }
  for (
    let attempt = 0;
    (outcome === "unknown" || outcome === "pending") && attempt < 8;
    attempt++
  ) {
    await new Promise((done) => setTimeout(done, 1_000));
    outcome = await reader.transactionStatus(pending.hash, accountId);
  }
  if (outcome === "failure") {
    journal.pending = null;
    save(path, journal);
    throw new Error(`${pending.method} transaction ${pending.hash} failed`);
  }
  if (outcome !== "success")
    throw new Error(`${pending.method} transaction ${pending.hash} is pending`);
  journal.transactions.push({
    method: pending.method,
    label: pending.label,
    hash: pending.hash,
  });
  journal.pending = null;
  save(path, journal);
}

async function submit(
  journal: Journal,
  path: string,
  owner: Credential,
  method: Pending["method"],
  label: string,
  args: Record<string, unknown>,
  deposit = 0n,
) {
  assert.equal(journal.pending, null);
  const access = await reader.accessKey(owner.account_id, owner.public_key);
  const transaction = createTransaction(
    owner.account_id,
    KeyPair.fromString(owner.secret_key).getPublicKey(),
    deployment.contractId,
    access.nonce + 1n,
    [actionCreators.functionCall(method, args, 60n * 10n ** 12n, deposit)],
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    owner.secret_key,
  ).signTransaction(transaction);
  journal.pending = {
    method,
    label,
    hash: baseEncode(hashBytes),
    signedBase64: Buffer.from(encodeTransaction(signed)).toString("base64"),
  };
  save(path, journal);
  await confirm(journal, path, owner.account_id);
}

async function candidates(excludedIds: ReadonlySet<string>): Promise<Step[]> {
  const config = await reader.view(
    "get_config",
    {},
    z.object({ plot_unit_price_yocto: z.string().regex(/^\d+$/) }),
  );
  const plots = await reader.plots();
  assert.equal(plots.length, 100, "Expected the 100-plot city");
  const steps: Step[] = [];
  for (const units of [1, 3] as const) {
    const selected = plots.find(
      (view) =>
        "frontage_units" in view.plot &&
        view.plot.frontage_units === units &&
        !view.plot.corner &&
        view.plot.owner === null &&
        !excludedIds.has(view.plot.id),
    );
    assert(
      selected && "frontage_units" in selected.plot,
      `No unowned noncorner ${units}-unit plot`,
    );
    const plot = selected.plot;
    const breakdown = await reader.plotPurchaseBreakdown(plot.id);
    assert.equal(
      BigInt(breakdown.price_yocto),
      BigInt(config.plot_unit_price_yocto) * BigInt(units),
    );
    assert.equal(
      BigInt(breakdown.total_yocto),
      BigInt(breakdown.price_yocto) + BigInt(breakdown.storage_reserve_yocto),
    );
    assert.equal(
      await reader.plotPurchaseQuote(plot.id),
      breakdown.total_yocto,
    );
    const street = await reader.streetSide(plot.road_id, plot.side);
    const entry = street.plots.find((item) => item.plot.plot.id === plot.id);
    assert(entry);
    assert.equal(entry.slots.length, units);
    steps.push({
      units,
      plotId: plot.id,
      initialDesignChoice: plot.design_choice,
      selectedDesignChoice: (plot.design_choice + 1) % 5,
      priceYocto: breakdown.price_yocto,
      storageReserveYocto: breakdown.storage_reserve_yocto,
      totalYocto: breakdown.total_yocto,
      purchased: false,
      designChosen: false,
    });
  }
  assert.equal(steps[0]!.storageReserveYocto, steps[1]!.storageReserveYocto);
  return steps;
}

async function checkOwned(step: Step, ownerId: string, selected: boolean) {
  const view = await reader.plot(step.plotId);
  assert(view && "frontage_units" in view.plot);
  assert.equal(view.plot.owner, ownerId);
  assert.equal(view.plot.frontage_units, step.units);
  assert.equal(
    view.plot.design_choice,
    selected ? step.selectedDesignChoice : step.initialDesignChoice,
  );
  assert(view.plot.reserved_storage_bytes > 0);
  assert(view.plot.used_storage_bytes <= view.plot.reserved_storage_bytes);
  const street = await reader.streetSide(view.plot.road_id, view.plot.side);
  const entry = street.plots.find((item) => item.plot.plot.id === step.plotId);
  assert(entry);
  assert("frontage_units" in entry.plot.plot);
  assert.equal(entry.slots.length, step.units);
  assert.equal(entry.plot.plot.owner, ownerId);
  assert.equal(entry.plot.plot.design_choice, view.plot.design_choice);
}

async function main() {
  const version = await reader.cityVersion();
  if (
    mode === "--plan" &&
    (version !== 2 || releaseStatus.status !== "active")
  ) {
    console.log(
      JSON.stringify(
        {
          status: "waiting_for_active_version_2",
          cityVersion: version,
          releaseStatus: releaseStatus.status,
        },
        null,
        2,
      ),
    );
    return;
  }
  assert.equal(version, 2, "Version-2 city has not been deployed");
  const release = readActiveVersion2Release(root, recordPath, deployment);
  const oldDeedIds = new Set(release.moves.map((move) => move.from));
  assert.equal(
    await reader.view("is_paused", {}, z.boolean()),
    false,
    "City remains paused",
  );
  if (mode === "--plan") {
    console.log(
      JSON.stringify(
        {
          contractId: deployment.contractId,
          releaseRecord: release.path,
          purchases: await candidates(oldDeedIds),
        },
        null,
        2,
      ),
    );
    return;
  }
  const owner = ownerCredential();
  const journalPath = resolve(
    dirname(owner.path),
    "variable-ownership-journey-journal.json",
  );
  let journal: Journal;
  if (existsSync(journalPath)) {
    journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    assert.equal(journal.contractId, deployment.contractId);
    assert.equal(journal.releaseRecord, release.path);
    assert.equal(journal.ownerId, owner.account_id);
  } else {
    if (mode === "--verify")
      throw new Error("No variable-ownership journey journal");
    const player = await reader.player(owner.account_id);
    assert(player.account, "Owner must be registered before the journey");
    assert.equal(
      player.active_session,
      null,
      "Owner has an active parking session",
    );
    journal = {
      contractId: deployment.contractId,
      releaseRecord: release.path,
      ownerId: owner.account_id,
      coinBalanceBefore: player.account.balance,
      pending: null,
      transactions: [],
      steps: await candidates(oldDeedIds),
      completed: false,
    };
    save(journalPath, journal);
  }
  if (mode === "--apply") await confirm(journal, journalPath, owner.account_id);
  if (mode === "--verify") {
    assert(journal.completed, "Ownership journey has not completed");
    for (const step of journal.steps) {
      assert(step.purchased && step.designChosen);
      await checkOwned(step, owner.account_id, true);
    }
    const player = await reader.player(owner.account_id);
    assert.equal(player.account?.balance, journal.coinBalanceBefore);
    for (const tx of journal.transactions)
      assert.equal(
        await reader.transactionStatus(tx.hash, owner.account_id),
        "success",
      );
    console.log(
      JSON.stringify({
        status: "verified",
        plotIds: journal.steps.map((step) => step.plotId),
      }),
    );
    return;
  }
  for (const step of journal.steps) {
    if (!step.purchased) {
      const bought = journal.transactions.some(
        (tx) => tx.label === `buy:${step.units}`,
      );
      if (!bought) {
        const view = await reader.plot(step.plotId);
        assert(view && "frontage_units" in view.plot);
        assert.equal(
          view.plot.owner,
          null,
          "Chosen plot was bought by another account",
        );
        assert.equal(view.plot.frontage_units, step.units);
        assert.equal(view.plot.design_choice, step.initialDesignChoice);
        const quote = await reader.plotPurchaseBreakdown(step.plotId);
        assert.equal(
          quote.total_yocto,
          step.totalYocto,
          "Purchase quote changed",
        );
        await submit(
          journal,
          journalPath,
          owner,
          "buy_plot",
          `buy:${step.units}`,
          { plot_id: step.plotId },
          BigInt(step.totalYocto),
        );
      }
      await checkOwned(step, owner.account_id, false);
      step.purchased = true;
      save(journalPath, journal);
    }
    if (!step.designChosen) {
      if (
        !journal.transactions.some((tx) => tx.label === `design:${step.units}`)
      )
        await submit(
          journal,
          journalPath,
          owner,
          "choose_design",
          `design:${step.units}`,
          { plot_id: step.plotId, choice: step.selectedDesignChoice },
        );
      await checkOwned(step, owner.account_id, true);
      step.designChosen = true;
      save(journalPath, journal);
    }
  }
  const player = await reader.player(owner.account_id);
  assert.equal(
    player.account?.balance,
    journal.coinBalanceBefore,
    "Purchasing deeds changed the coin balance",
  );
  journal.completed = true;
  save(journalPath, journal);
  const evidence = {
    network: "testnet",
    contractId: journal.contractId,
    releaseRecord: journal.releaseRecord,
    ownerId: journal.ownerId,
    coinBalanceBefore: journal.coinBalanceBefore,
    coinBalanceAfter: player.account.balance,
    purchases: journal.steps,
    transactions: journal.transactions,
    verifiedAt: new Date().toISOString(),
  };
  writeFileSync(
    resolve(root, "deployments/testnet-variable-ownership-journey.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));
}

await main();
