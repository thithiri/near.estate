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
if (
  mode !== "--plan" &&
  mode !== "--apply" &&
  mode !== "--restore" &&
  mode !== "--verify"
)
  throw new Error("Pass --plan, --apply, --restore or --verify");
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
const reader = new ChainReader(deployment.contractId);
const cityVersion = await reader.cityVersion();
let plotId = "plot-market-n-1";
let meteredPlotId = "plot-main-n-2";
let releaseRecord: string | null = null;
if (cityVersion === 2) {
  const candidate = process.argv[3];
  if (!candidate)
    throw new Error("Pass an absolute active version-2 release-record path");
  const release = readActiveVersion2Release(root, candidate, deployment);
  releaseRecord = release.path;
  const ticketMove = release.moves.find(
    (move) => move.from === "plot-market-n-1",
  );
  const meterMove = release.moves.find((move) => move.from === "plot-main-n-2");
  assert(
    ticketMove && meterMove,
    "Both original owner deeds need reviewed destinations",
  );
  assert.notEqual(
    ticketMove.to,
    meterMove.to,
    "Owner deeds share a destination",
  );
  plotId = ticketMove.to;
  meteredPlotId = meterMove.to;
  assert.equal(
    await reader.view("is_paused", {}, z.boolean()),
    false,
    "Version-2 city remains paused",
  );
}

function credentialFrom(name: "OWNER" | "DRIVER") {
  const path = process.env[`ESTATE_${name}_KEY_FILE`];
  if (!path || !path.startsWith("/"))
    throw new Error(`Set ESTATE_${name}_KEY_FILE to a private absolute path`);
  if (realpathSync(path).startsWith(`${root}/`))
    throw new Error(`${name} credential must stay outside the repository`);
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error(`${name} credential must be private`);
  const value = JSON.parse(readFileSync(path, "utf8")) as {
    account_id: string;
    public_key: string;
    secret_key: `ed25519:${string}`;
  };
  assert.match(value.account_id, /^[a-z0-9._-]+\.testnet$/);
  assert.equal(
    KeyPair.fromString(value.secret_key).getPublicKey().toString(),
    value.public_key,
  );
  return { ...value, path };
}

const owner = credentialFrom("OWNER");
const driver = credentialFrom("DRIVER");
assert.notEqual(owner.account_id, driver.account_id);
const journalPath = resolve(
  dirname(owner.path),
  cityVersion === 2
    ? "two-account-ticket-v2-journal.json"
    : "two-account-ticket-journal.json",
);
type Pending = {
  accountId: string;
  method: string;
  hash: string;
  signedBase64: string;
};
type RecordedTransaction = { accountId: string; method: string; hash: string };
type Journal = {
  contractId: string;
  cityVersion?: 1 | 2;
  releaseRecord?: string | null;
  plotId: string;
  ownerId: string;
  driverId: string;
  pending: Pending | null;
  transactions: RecordedTransaction[];
  sessionId: number | null;
  ownerBalanceBeforeTicket: string | null;
  completed: boolean;
};
const freshJournal: Journal = {
  contractId: deployment.contractId,
  cityVersion,
  releaseRecord,
  plotId,
  ownerId: owner.account_id,
  driverId: driver.account_id,
  pending: null,
  transactions: [],
  sessionId: null,
  ownerBalanceBeforeTicket: null,
  completed: false,
};
const journal: Journal = existsSync(journalPath)
  ? (JSON.parse(readFileSync(journalPath, "utf8")) as Journal)
  : freshJournal;
for (const field of ["contractId", "plotId", "ownerId", "driverId"] as const)
  assert.equal(
    journal[field],
    freshJournal[field],
    `Journal ${field} mismatch`,
  );
if (cityVersion === 2) {
  assert.equal(journal.cityVersion, 2, "Journal city version mismatch");
  assert.equal(
    journal.releaseRecord,
    releaseRecord,
    "Journal release mismatch",
  );
}

function saveJournal() {
  const temporary = `${journalPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, journalPath);
}

async function confirmPending() {
  const pending = journal.pending;
  if (!pending) return;
  let outcome = await reader.transactionStatus(pending.hash, pending.accountId);
  if (outcome === "unknown") {
    try {
      outcome = await reader.sendSignedTransaction(pending.signedBase64);
    } catch {
      // Keep the exact signed bytes if an RPC reply is lost.
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
    journal.pending = null;
    saveJournal();
    throw new Error(`${pending.method} transaction ${pending.hash} failed`);
  }
  if (outcome !== "success")
    throw new Error(`${pending.method} transaction ${pending.hash} is pending`);
  journal.transactions.push({
    accountId: pending.accountId,
    method: pending.method,
    hash: pending.hash,
  });
  journal.pending = null;
  saveJournal();
}

async function submit(
  signer: typeof owner,
  method: string,
  args: Record<string, unknown>,
  deposit = 0n,
) {
  assert.equal(journal.pending, null, "Resolve the prior action first");
  const access = await reader.accessKey(signer.account_id, signer.public_key);
  const transaction = createTransaction(
    signer.account_id,
    KeyPair.fromString(signer.secret_key).getPublicKey(),
    deployment.contractId,
    access.nonce + 1n,
    [actionCreators.functionCall(method, args, 60n * 10n ** 12n, deposit)],
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    signer.secret_key,
  ).signTransaction(transaction);
  journal.pending = {
    accountId: signer.account_id,
    method,
    hash: baseEncode(hashBytes),
    signedBase64: Buffer.from(encodeTransaction(signed)).toString("base64"),
  };
  saveJournal();
  await confirmPending();
}

async function main() {
  if (mode === "--apply" || mode === "--restore") await confirmPending();
  const before = await reader.plot(plotId);
  assert(before, "Dedicated ticket plot is missing");
  if (before.plot.owner && before.plot.owner !== owner.account_id)
    throw new Error("Dedicated ticket plot belongs to another owner");
  if (mode === "--verify") {
    assert(journal.completed, "Ticket journey has not completed");
    assert.equal(before.plot.owner, owner.account_id);
    assert.equal(before.effective_rule.kind, "Free");
    if (cityVersion === 2) {
      assert("frontage_units" in before.plot);
      assert.equal(before.plot.frontage_units, 2);
    }
    const driverAfter = await reader.player(driver.account_id);
    assert.equal(driverAfter.active_session, null);
    for (const entry of journal.transactions)
      assert.equal(
        await reader.transactionStatus(entry.hash, entry.accountId),
        "success",
        `${entry.method} transaction is not final and successful`,
      );
    const evidencePath = resolve(
      root,
      cityVersion === 2
        ? "deployments/testnet-two-account-ticket-v2-journey.json"
        : "deployments/testnet-two-account-ticket-journey.json",
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<
      string,
      unknown
    >;
    evidence.restoredEffectiveRule = before.effective_rule;
    evidence.restoredVerifiedAt = new Date().toISOString();
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(
      JSON.stringify({
        status: "verified",
        restoredEffectiveRule: before.effective_rule,
        transactions: journal.transactions.length,
      }),
    );
    return;
  }
  if (mode === "--restore") {
    assert.equal(before.plot.owner, owner.account_id);
    if (
      before.effective_rule.kind === "Free" &&
      before.plot.pending_rule?.rule.kind !== "NoParking"
    ) {
      console.log(JSON.stringify({ status: "already_free" }));
      return;
    }
    if (before.plot.pending_rule?.rule.kind !== "Free")
      await submit(owner, "set_rule", {
        plot_id: plotId,
        rule: { kind: "Free" },
      });
    const restored = await reader.plot(plotId);
    assert.equal(restored?.plot.pending_rule?.rule.kind, "Free");
    console.log(
      JSON.stringify({
        status: "free_rule_scheduled",
        effectiveAt: restored.plot.pending_rule.effective_at,
      }),
    );
    return;
  }
  const metered = await reader.plot(meteredPlotId);
  assert.equal(metered?.plot.owner, owner.account_id);
  assert.equal(metered.effective_rule.kind, "Meter");
  if (cityVersion === 2) {
    assert("frontage_units" in before.plot);
    assert("frontage_units" in metered.plot);
    assert.equal(before.plot.frontage_units, 2);
    assert.equal(metered.plot.frontage_units, 2);
  }
  if (
    cityVersion === 2 &&
    journal.transactions.length === 0 &&
    journal.sessionId === null
  ) {
    assert.equal(
      before.plot.owner,
      owner.account_id,
      "Moved ticket deed is not owned by the expected account",
    );
    assert.equal(
      before.effective_rule.kind,
      "Free",
      "Ticket deed must start with its migrated Free rule",
    );
    assert.equal(
      before.plot.pending_rule,
      null,
      "Moved ticket deed has a pending rule change",
    );
  }
  const parkDurabilityCost = (
    await reader.view(
      "get_config",
      {},
      z.object({ park_durability_cost: z.number().int().positive() }),
    )
  ).park_durability_cost;
  const ownerPlayer = await reader.player(owner.account_id);
  const driverPlayer = await reader.player(driver.account_id);
  assert(
    ownerPlayer.account && driverPlayer.account,
    "Both players must register",
  );
  assert(driverPlayer.cars.some((car) => car.durability >= parkDurabilityCost));
  if (mode === "--plan") {
    console.log(
      JSON.stringify(
        {
          contractId: deployment.contractId,
          cityVersion,
          releaseRecord,
          plotId,
          ownerId: owner.account_id,
          driverId: driver.account_id,
          currentOwner: before.plot.owner,
          effectiveRule: before.effective_rule,
          pendingRule: before.plot.pending_rule,
          purchaseQuoteYocto: before.plot.owner
            ? null
            : await reader.plotPurchaseQuote(plotId),
          driverActiveSession: driverPlayer.active_session?.id ?? null,
          nextAction: before.plot.owner ? "set NoParking" : "buy plot",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (journal.completed) {
    console.log("Two-account ticket journey already completed");
    return;
  }
  if (!before.plot.owner) {
    assert.equal(
      cityVersion,
      1,
      "Version-2 deed move is missing; refusing a new purchase",
    );
    const quote = await reader.plotPurchaseQuote(plotId);
    await submit(owner, "buy_plot", { plot_id: plotId }, BigInt(quote));
  }
  let plot = await reader.plot(plotId);
  assert.equal(plot?.plot.owner, owner.account_id);
  if (
    plot.effective_rule.kind !== "NoParking" &&
    plot.plot.pending_rule?.rule.kind !== "NoParking" &&
    journal.sessionId === null
  ) {
    await submit(owner, "set_rule", {
      plot_id: plotId,
      rule: { kind: "NoParking" },
    });
    plot = await reader.plot(plotId);
    assert(plot);
  }
  if (plot.effective_rule.kind !== "NoParking") {
    assert.equal(plot.plot.pending_rule?.rule.kind, "NoParking");
    console.log(
      JSON.stringify({
        status: "waiting_for_rule",
        effectiveAt: plot.plot.pending_rule.effective_at,
      }),
    );
    return;
  }
  let player = await reader.player(driver.account_id);
  if (journal.sessionId === null) {
    if (player.active_session) {
      assert.equal(player.active_session.location_id, plotId);
      assert(
        journal.transactions.some((entry) => entry.method === "park"),
        "Existing driver session was not created by this journey",
      );
    } else {
      const street = await reader.streetSide(plot.plot.road_id, plot.plot.side);
      const target = street.plots.find(
        (entry) => entry.plot.plot.id === plotId,
      );
      assert(target, "Dedicated plot is missing from the street");
      if (cityVersion === 2) assert.equal(target.slots.length, 2);
      const slot = target.slots.findIndex((entry) => entry === null);
      assert(slot >= 0, "Dedicated plot has no open curb");
      const car = player.cars.find(
        (entry) => entry.durability >= parkDurabilityCost,
      );
      assert(car, "Driver needs a parkable car");
      await submit(driver, "park", { car_id: car.id, plot_id: plotId, slot });
      player = await reader.player(driver.account_id);
      assert(player.active_session, "Illegal parking did not create a session");
    }
    journal.sessionId = player.active_session.id;
    saveJournal();
  }
  if (player.active_session) {
    assert.equal(player.active_session.id, journal.sessionId);
    assert.equal(player.active_session.location_id, plotId);
    assert.equal(player.active_session.legal, false);
    if (journal.ownerBalanceBeforeTicket === null) {
      const current = await reader.player(owner.account_id);
      assert(current.account);
      journal.ownerBalanceBeforeTicket = current.account.balance;
      saveJournal();
    }
    await new Promise((done) => setTimeout(done, 2_200));
    await submit(owner, "ticket", {
      plot_id: plotId,
      slot: player.active_session.slot,
      expected_session_id: journal.sessionId,
    });
  }
  const cleared = await reader.player(driver.account_id);
  assert.equal(cleared.active_session, null, "Ticket did not free the car");
  assert(
    journal.transactions.some((entry) => entry.method === "ticket"),
    "Ticket transaction is missing",
  );
  const ownerAfter = await reader.player(owner.account_id);
  assert(ownerAfter.account && journal.ownerBalanceBeforeTicket);
  const ticketPayout =
    BigInt(ownerAfter.account.balance) -
    BigInt(journal.ownerBalanceBeforeTicket);
  assert(ticketPayout > 0n, "Ticket did not pay the owner");
  plot = await reader.plot(plotId);
  assert(plot);
  if (plot.plot.pending_rule?.rule.kind !== "Free")
    await submit(owner, "set_rule", {
      plot_id: plotId,
      rule: { kind: "Free" },
    });
  plot = await reader.plot(plotId);
  assert.equal(plot?.plot.pending_rule?.rule.kind, "Free");
  journal.completed = true;
  saveJournal();
  const evidence = {
    network: "testnet",
    contractId: deployment.contractId,
    cityVersion,
    releaseRecord,
    ownerId: owner.account_id,
    driverId: driver.account_id,
    plotId,
    sessionId: journal.sessionId,
    legalAtPark: false,
    ticketPayoutAtomic: ticketPayout.toString(),
    finalDriverSession: cleared.active_session,
    pendingRestoredRule: plot.plot.pending_rule,
    transactions: journal.transactions,
  };
  writeFileSync(
    resolve(
      root,
      cityVersion === 2
        ? "deployments/testnet-two-account-ticket-v2-journey.json"
        : "deployments/testnet-two-account-ticket-journey.json",
    ),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));
}

await main();
