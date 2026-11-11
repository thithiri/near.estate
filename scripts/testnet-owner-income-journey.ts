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
import { ChainReader } from "../apps/web/src/chain-reader.js";

const mode = process.argv[2];
if (mode !== "--park" && mode !== "--settle")
  throw new Error("Pass --park or --settle");
const root = resolve(import.meta.dirname, "..");
const keyFile = process.env.ESTATE_SHARED_OWNER_KEY_FILE;
if (!keyFile || !keyFile.startsWith("/"))
  throw new Error(
    "Set ESTATE_SHARED_OWNER_KEY_FILE to a private absolute path",
  );
if (realpathSync(keyFile).startsWith(`${root}/`))
  throw new Error("Owner key must stay outside the repository");
if ((statSync(keyFile).mode & 0o077) !== 0)
  throw new Error("Owner key must be private");
const credential = JSON.parse(readFileSync(keyFile, "utf8")) as {
  account_id: string;
  public_key: string;
  secret_key: `ed25519:${string}`;
};
const pair = KeyPair.fromString(credential.secret_key);
assert.equal(pair.getPublicKey().toString(), credential.public_key);
const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
) as { contractId: string };
const owner = JSON.parse(
  readFileSync(
    resolve(root, "deployments/testnet-shared-owner-journey.json"),
    "utf8",
  ),
) as { ownerId: string; contractId: string };
assert.equal(owner.ownerId, credential.account_id);
assert.equal(owner.contractId, deployment.contractId);
const reader = new ChainReader(deployment.contractId);
const journalPath = resolve(
  dirname(keyFile),
  "shared-owner-income-journal.json",
);

type Cycle = {
  sessionId: number;
  carId: number;
  plotId: string;
  slot: number;
  parkHash: string;
  startedAt: number;
  earnUntil: number;
  expiresAt: number;
  settleHash?: string;
  earnedAtomic?: string;
};
type Pending = {
  method: "park" | "collect" | "settle_expired";
  hash: string;
  signedBase64: string;
  carId?: number;
  plotId?: string;
  slot?: number;
  sessionId?: number;
  balanceBefore: string;
};
type Journal = { cycles: Cycle[]; pending: Pending | null };
const journal: Journal = existsSync(journalPath)
  ? (JSON.parse(readFileSync(journalPath, "utf8")) as Journal)
  : { cycles: [], pending: null };

function saveJournal() {
  const temporary = `${journalPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, journalPath);
}

function publishSettlementEvidence(balanceAtomic: string) {
  const evidence = {
    network: "testnet",
    contractId: deployment.contractId,
    ownerId: credential.account_id,
    balanceAtomic,
    completedCycles: journal.cycles.map(
      ({ parkHash, settleHash, earnedAtomic, ...cycle }) => ({
        ...cycle,
        parkHash,
        settleHash,
        earnedAtomic,
      }),
    ),
  };
  writeFileSync(
    resolve(root, "deployments/testnet-owner-income-journey.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify({ status: "settled", evidence }, null, 2));
}

async function prepareCall(
  method: Pending["method"],
  args: Record<string, unknown>,
  balanceBefore: string,
  extra: Pick<Pending, "carId" | "plotId" | "slot" | "sessionId">,
) {
  assert.equal(
    journal.pending,
    null,
    "Resolve the previous signed action first",
  );
  const access = await reader.accessKey(
    credential.account_id,
    credential.public_key,
  );
  const transaction = createTransaction(
    credential.account_id,
    pair.getPublicKey(),
    deployment.contractId,
    access.nonce + 1n,
    [actionCreators.functionCall(method, args, 60n * 10n ** 12n, 0n)],
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    credential.secret_key,
  ).signTransaction(transaction);
  journal.pending = {
    method,
    hash: baseEncode(hashBytes),
    signedBase64: Buffer.from(encodeTransaction(signed)).toString("base64"),
    balanceBefore,
    ...extra,
  };
  saveJournal();
}

async function confirmPending() {
  const pending = journal.pending;
  assert(pending, "No signed action to confirm");
  let outcome = await reader.transactionStatus(
    pending.hash,
    credential.account_id,
  );
  if (outcome === "unknown") {
    try {
      outcome = await reader.sendSignedTransaction(pending.signedBase64);
    } catch {
      // Keep the exact signed bytes for a later status check or rebroadcast.
    }
  }
  for (
    let attempt = 0;
    (outcome === "unknown" || outcome === "pending") && attempt < 8;
    attempt++
  ) {
    await new Promise((done) => setTimeout(done, 1_000));
    outcome = await reader.transactionStatus(
      pending.hash,
      credential.account_id,
    );
  }
  if (outcome !== "success")
    throw new Error(
      `${pending.method} transaction ${pending.hash} is ${outcome}`,
    );
  const player = await reader.player(credential.account_id);
  assert(player.account);
  if (pending.method === "park") {
    const session = player.active_session;
    assert(session, "Confirmed park has no active session");
    assert.equal(session.car_id, pending.carId);
    assert.equal(session.location_id, pending.plotId);
    assert.equal(session.slot, pending.slot);
    assert.equal(session.legal, true);
    if (!journal.cycles.some((cycle) => cycle.sessionId === session.id))
      journal.cycles.push({
        sessionId: session.id,
        carId: session.car_id,
        plotId: session.location_id,
        slot: session.slot,
        parkHash: pending.hash,
        startedAt: session.started_at,
        earnUntil: session.earn_until,
        expiresAt: session.expires_at,
      });
  } else {
    assert.equal(
      player.active_session,
      null,
      "Settlement did not free the car",
    );
    const cycle = journal.cycles.find(
      (entry) => entry.sessionId === pending.sessionId,
    );
    assert(cycle, "Settled session is missing from the private journal");
    cycle.settleHash = pending.hash;
    cycle.earnedAtomic = (
      BigInt(player.account.balance) - BigInt(pending.balanceBefore)
    ).toString();
    assert(BigInt(cycle.earnedAtomic) > 0n, "Parking earned no coins");
  }
  journal.pending = null;
  saveJournal();
}

const recoveredSettlementSessionId =
  journal.pending?.method === "collect" ||
  journal.pending?.method === "settle_expired"
    ? journal.pending.sessionId
    : undefined;
if (journal.pending) await confirmPending();
const player = await reader.player(credential.account_id);
assert(player.account, "Owner is not registered");
const unsettledCycle = journal.cycles.find((entry) => !entry.settleHash);
if (mode === "--settle" && recoveredSettlementSessionId !== undefined) {
  const recoveredCycle = journal.cycles.find(
    (entry) => entry.sessionId === recoveredSettlementSessionId,
  );
  assert(recoveredCycle?.settleHash, "Recovered settlement is not recorded");
  assert.equal(player.active_session, null, "Recovered settlement left car parked");
  publishSettlementEvidence(player.account.balance);
} else if (mode === "--park") {
  if (player.active_session) {
    assert.equal(
      player.active_session.id,
      unsettledCycle?.sessionId,
      "The active session does not match the private journey journal",
    );
    console.log(
      JSON.stringify({
        status: "already_parked",
        sessionId: player.active_session.id,
        earnUntil: player.active_session.earn_until,
        expiresAt: player.active_session.expires_at,
      }),
    );
  } else {
    assert(
      !unsettledCycle,
      `Session ${unsettledCycle?.sessionId} was settled externally; reconcile its chain event and payout before another park`,
    );
    const car = player.cars.find((entry) => entry.parked_session_id === null);
    assert(car && car.durability >= 2, "No parkable owner car");
    const street = await reader.streetSide("river", "South");
    const open = street.plots.find(
      (entry) =>
        entry.plot.plot.owner === null &&
        entry.plot.effective_rule.kind === "Free" &&
        entry.slots.some((session) => session === null),
    );
    assert(open, "No free unowned River Street curb is open");
    const slot = open.slots.findIndex((session) => session === null);
    await prepareCall(
      "park",
      { car_id: car.id, plot_id: open.plot.plot.id, slot },
      player.account.balance,
      { carId: car.id, plotId: open.plot.plot.id, slot },
    );
    await confirmPending();
    console.log(
      JSON.stringify({ status: "parked", cycle: journal.cycles.at(-1) }),
    );
  }
} else {
  const session = player.active_session;
  assert(
    session,
    unsettledCycle
      ? `Session ${unsettledCycle.sessionId} was settled externally; reconcile its chain event and payout`
      : "Owner has no active session to settle",
  );
  const cycle = journal.cycles.find((entry) => entry.sessionId === session.id);
  assert(cycle && !cycle.settleHash, "Active session is not in this journey");
  const chainNow = await reader.chainTimeSeconds();
  if (chainNow < session.earn_until)
    throw new Error(`Full parking payout available at ${session.earn_until}`);
  const secondsUntilExpiry = session.expires_at - chainNow;
  if (secondsUntilExpiry > 0 && secondsUntilExpiry <= 30)
    throw new Error("Collection is too close to expiry; retry after expiry");
  const method = secondsUntilExpiry > 0 ? "collect" : "settle_expired";
  await prepareCall(
    method,
    { expected_session_id: session.id },
    player.account.balance,
    { sessionId: session.id },
  );
  await confirmPending();
  const after = await reader.player(credential.account_id);
  assert(after.account);
  publishSettlementEvidence(after.account.balance);
}
