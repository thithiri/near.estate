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
if (mode !== "--plan" && mode !== "--apply")
  throw new Error("Pass --plan or --apply");
const root = resolve(import.meta.dirname, "..");
const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
) as { network: string; contractId: string };
const ownerJourney = JSON.parse(
  readFileSync(
    resolve(root, "deployments/testnet-shared-owner-journey.json"),
    "utf8",
  ),
) as { contractId: string; ownerId: string };
assert.equal(deployment.network, "testnet");
assert.equal(ownerJourney.contractId, deployment.contractId);
const keyFile = process.env.ESTATE_DRIVER_KEY_FILE;
if (!keyFile || !keyFile.startsWith("/"))
  throw new Error("Set ESTATE_DRIVER_KEY_FILE to a private absolute path");
if (realpathSync(keyFile).startsWith(`${root}/`))
  throw new Error("Driver key must stay outside the repository");
if ((statSync(keyFile).mode & 0o077) !== 0)
  throw new Error("Driver key must be private");
const driver = JSON.parse(readFileSync(keyFile, "utf8")) as {
  account_id: string;
  public_key: string;
  secret_key: `ed25519:${string}`;
};
assert.match(driver.account_id, /^[a-z0-9._-]+\.testnet$/);
assert.notEqual(driver.account_id, ownerJourney.ownerId);
assert.equal(
  KeyPair.fromString(driver.secret_key).getPublicKey().toString(),
  driver.public_key,
);
const reader = new ChainReader(deployment.contractId);
type SignedCall = {
  method: "settle_expired" | "park" | "collect";
  hash: string;
  signedBase64: string;
};
type Journal = {
  contractId: string;
  ownerId: string;
  driverId: string;
  oldSessionId: number;
  plotId: string;
  slot: number;
  expiresAt: number;
  ownerBalanceBefore: string;
  settle: SignedCall | null;
  reusePark: SignedCall | null;
  reuseSessionId: number | null;
  reuseCollect: SignedCall | null;
  completed: boolean;
};
const journalPath = resolve(dirname(keyFile), "expiry-reuse-journal.json");
const journal: Journal | null = existsSync(journalPath)
  ? (JSON.parse(readFileSync(journalPath, "utf8")) as Journal)
  : null;
if (journal) {
  assert.equal(journal.contractId, deployment.contractId);
  assert.equal(journal.ownerId, ownerJourney.ownerId);
  assert.equal(journal.driverId, driver.account_id);
}

function saveJournal(value: Journal) {
  const temporary = `${journalPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, journalPath);
}

async function signCall(
  method: SignedCall["method"],
  args: Record<string, unknown>,
): Promise<SignedCall> {
  const access = await reader.accessKey(driver.account_id, driver.public_key);
  const transaction = createTransaction(
    driver.account_id,
    KeyPair.fromString(driver.secret_key).getPublicKey(),
    deployment.contractId,
    access.nonce + 1n,
    [actionCreators.functionCall(method, args, 60n * 10n ** 12n, 0n)],
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    driver.secret_key,
  ).signTransaction(transaction);
  return {
    method,
    hash: baseEncode(hashBytes),
    signedBase64: Buffer.from(encodeTransaction(signed)).toString("base64"),
  };
}

async function confirm(call: SignedCall): Promise<void> {
  let outcome = await reader.transactionStatus(call.hash, driver.account_id);
  if (outcome === "unknown") {
    try {
      outcome = await reader.sendSignedTransaction(call.signedBase64);
    } catch {
      // A lost reply must be reconciled by exact hash before a new call.
    }
  }
  for (
    let attempt = 0;
    (outcome === "unknown" || outcome === "pending") && attempt < 8;
    attempt++
  ) {
    await new Promise((done) => setTimeout(done, 1_000));
    outcome = await reader.transactionStatus(call.hash, driver.account_id);
  }
  assert.equal(outcome, "success", `${call.method} is ${outcome}`);
}

async function main() {
  const ownerBefore = await reader.player(ownerJourney.ownerId);
  assert(ownerBefore.account, "Owner is not registered");
  const driverBefore = await reader.player(driver.account_id);
  assert(driverBefore.account, "Driver is not registered");
  const session = ownerBefore.active_session;
  if (mode === "--plan") {
    console.log(
      JSON.stringify(
        {
          contractId: deployment.contractId,
          ownerId: ownerJourney.ownerId,
          driverId: driver.account_id,
          sessionId: session?.id ?? journal?.oldSessionId ?? null,
          plotId: session?.location_id ?? journal?.plotId ?? null,
          slot: session?.slot ?? journal?.slot ?? null,
          expiresAt: session?.expires_at ?? journal?.expiresAt ?? null,
          chainNow: await reader.chainTimeSeconds(),
          driverActiveSession: driverBefore.active_session?.id ?? null,
          completed: journal?.completed ?? false,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (journal?.completed) {
    console.log("Expiry and reuse journey already completed");
    return;
  }
  const state: Journal =
    journal ??
    (() => {
      assert(session, "Owner has no session to expire");
      assert.equal(session.facility, "Curb");
      assert.equal(session.location_id, "plot-river-s-0");
      return {
        contractId: deployment.contractId,
        ownerId: ownerJourney.ownerId,
        driverId: driver.account_id,
        oldSessionId: session.id,
        plotId: session.location_id,
        slot: session.slot,
        expiresAt: session.expires_at,
        ownerBalanceBefore: ownerBefore.account.balance,
        settle: null,
        reusePark: null,
        reuseSessionId: null,
        reuseCollect: null,
        completed: false,
      };
    })();
  if (!journal) saveJournal(state);
  if (!state.settle) {
    assert.equal(session?.id, state.oldSessionId);
    const chainNow = await reader.chainTimeSeconds();
    if (chainNow < state.expiresAt) {
      console.log(
        JSON.stringify({
          status: "waiting_for_expiry",
          expiresAt: state.expiresAt,
          chainNow,
        }),
      );
      return;
    }
    state.settle = await signCall("settle_expired", {
      expected_session_id: state.oldSessionId,
    });
    saveJournal(state);
  }
  await confirm(state.settle);
  const ownerAfter = await reader.player(ownerJourney.ownerId);
  assert(ownerAfter.account);
  assert.equal(ownerAfter.active_session, null);
  const ownerPayout =
    BigInt(ownerAfter.account.balance) - BigInt(state.ownerBalanceBefore);
  assert.equal(
    ownerPayout,
    30_000_000n,
    "Expired owner park was not paid at cap",
  );
  if (!state.reusePark) {
    assert.equal(driverBefore.active_session, null);
    const street = await reader.streetSide("river", "South");
    const plot = street.plots.find(
      (entry) => entry.plot.plot.id === state.plotId,
    );
    assert.equal(plot?.slots[state.slot], null, "Expired curb did not clear");
    const car = driverBefore.cars.find((entry) => entry.durability >= 2);
    assert(car, "Driver needs a parkable car");
    state.reusePark = await signCall("park", {
      car_id: car.id,
      plot_id: state.plotId,
      slot: state.slot,
    });
    saveJournal(state);
  }
  await confirm(state.reusePark);
  const reused = await reader.player(driver.account_id);
  if (!state.reuseCollect) {
    assert(reused.active_session, "Driver did not reuse expired curb");
    assert.equal(reused.active_session.location_id, state.plotId);
    assert.equal(reused.active_session.slot, state.slot);
    state.reuseSessionId = reused.active_session.id;
    state.reuseCollect = await signCall("collect", {
      expected_session_id: state.reuseSessionId,
    });
    saveJournal(state);
  }
  await confirm(state.reuseCollect);
  const driverAfter = await reader.player(driver.account_id);
  assert.equal(driverAfter.active_session, null);
  const finalStreet = await reader.streetSide("river", "South");
  const finalPlot = finalStreet.plots.find(
    (entry) => entry.plot.plot.id === state.plotId,
  );
  assert.equal(finalPlot?.slots[state.slot], null);
  state.completed = true;
  saveJournal(state);
  const evidence = {
    network: "testnet",
    contractId: deployment.contractId,
    oldDriverId: ownerJourney.ownerId,
    settlerAndNewDriverId: driver.account_id,
    plotId: state.plotId,
    slot: state.slot,
    oldSessionId: state.oldSessionId,
    oldExpiresAt: state.expiresAt,
    ownerPayoutAtomic: ownerPayout.toString(),
    newSessionId: state.reuseSessionId,
    settleHash: state.settle.hash,
    reuseParkHash: state.reusePark.hash,
    reuseCollectHash: state.reuseCollect.hash,
    finalSessions: {
      owner: ownerAfter.active_session,
      driver: driverAfter.active_session,
    },
    finalSlotFree: true,
  };
  writeFileSync(
    resolve(root, "deployments/testnet-expiry-reuse-journey.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));
}

await main();
