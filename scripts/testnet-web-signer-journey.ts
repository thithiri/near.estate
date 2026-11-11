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
import { createTransaction, encodeTransaction } from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import { ChainReader } from "../apps/web/src/chain-reader.js";
import { GameWalletClient } from "../apps/web/src/wallet-client.js";

if (process.argv.slice(2).join(" ") !== "--apply")
  throw new Error("Pass --apply to run the disposable testnet journey");

const keyFile = process.env.ESTATE_DRIVER_KEY_FILE;
if (!keyFile || !keyFile.startsWith("/"))
  throw new Error(
    "Set ESTATE_DRIVER_KEY_FILE to a private absolute credential path",
  );
const projectRoot = resolve(import.meta.dirname, "..");
if (realpathSync(keyFile).startsWith(`${projectRoot}/`))
  throw new Error("Driver credential must be outside the repository");
if ((statSync(keyFile).mode & 0o077) !== 0)
  throw new Error("Driver credential must not be readable by group or others");
const credential = JSON.parse(readFileSync(keyFile, "utf8")) as {
  account_id: string;
  public_key: string;
  secret_key: `ed25519:${string}`;
};
assert.match(credential.account_id, /^[a-z0-9._-]+\.testnet$/);
const fullAccessPair = KeyPair.fromString(credential.secret_key);
assert.equal(fullAccessPair.getPublicKey().toString(), credential.public_key);

const deployment = JSON.parse(
  readFileSync(resolve(projectRoot, "deployments/testnet.json"), "utf8"),
) as { network: string; contractId: string };
assert.equal(deployment.network, "testnet");
const reader = new ChainReader(deployment.contractId);
const storageFile = resolve(dirname(keyFile), "web-gameplay-storage.json");
const saved = existsSync(storageFile)
  ? (JSON.parse(readFileSync(storageFile, "utf8")) as Record<string, string>)
  : {};
const values = new Map(Object.entries(saved));
const gameplayTransactions: Array<{ method: string; hash: string }> = [];
let gameplayKeyPublic: string | null = null;
function persistStorage() {
  const temporary = `${storageFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(Object.fromEntries(values)), {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, storageFile);
}
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
      if (name.endsWith(":action")) {
        const action = JSON.parse(value) as { method: string; hash: string };
        if (!gameplayTransactions.some((entry) => entry.hash === action.hash))
          gameplayTransactions.push({
            method: action.method,
            hash: action.hash,
          });
      }
      if (name.endsWith(":gameplay-key") || name.endsWith(":pending")) {
        const key = JSON.parse(value) as { publicKey?: string };
        if (key.publicKey) gameplayKeyPublic = key.publicKey;
      }
      persistStorage();
    },
    removeItem: (name: string) => {
      values.delete(name);
      persistStorage();
    },
  },
});

const transactionHashes: string[] = [];
async function fullAccessCall(receiverId: string, actions: unknown[]) {
  const state = await reader.accessKey(
    credential.account_id,
    credential.public_key,
  );
  const transaction = createTransaction(
    credential.account_id,
    fullAccessPair.getPublicKey(),
    receiverId,
    state.nonce + 1n,
    actions as Parameters<typeof createTransaction>[4],
    baseDecode(state.blockHash),
  );
  const signer = KeyPairSigner.fromSecretKey(credential.secret_key);
  const [hashBytes, signed] = await signer.signTransaction(transaction);
  const hash = baseEncode(hashBytes);
  const base64 = Buffer.from(encodeTransaction(signed)).toString("base64");
  let outcome: "success" | "failure" | "pending" = "pending";
  try {
    outcome = await reader.sendSignedTransaction(base64);
  } catch {
    // A timed-out submission may still be on-chain. Query its exact hash.
  }
  for (let attempt = 0; outcome === "pending" && attempt < 8; attempt++) {
    await new Promise((done) => setTimeout(done, 1_000));
    const status = await reader.transactionStatus(hash, credential.account_id);
    if (status !== "unknown") outcome = status;
  }
  if (outcome !== "success")
    throw new Error(`Full-access transaction ${hash} is ${outcome}`);
  transactionHashes.push(hash);
  return { status: { SuccessValue: "" } };
}

const selector = {
  store: {
    getState: () => ({
      contract: { contractId: reader.contractId },
      accounts: [{ accountId: credential.account_id, active: true }],
    }),
  },
  wallet: async () => ({
    signAndSendTransaction: async (request: {
      signerId: string;
      receiverId: string;
      actions: unknown[];
    }) => {
      assert.equal(request.signerId, credential.account_id);
      return fullAccessCall(request.receiverId, request.actions);
    },
  }),
};
const client = Object.assign(Object.create(GameWalletClient.prototype), {
  reader,
  selector,
  lastCall: Promise.resolve(),
}) as GameWalletClient;

const before = await reader.player(credential.account_id);
if (!before.account) await client.register("Hatchback", "Blue");
const registered = await reader.player(credential.account_id);
assert(registered.account, "Driver registration did not finalize");
const car = registered.cars[0];
assert(car, "Starter car is missing");
if (registered.active_session)
  throw new Error("Disposable driver already has a parking session");

const keyState = await client.resumePendingKey();
if (keyState === "pending") {
  const recovered = await client.retryPendingKey();
  assert.equal(recovered, "ready");
} else if (keyState !== "ready") {
  assert.equal(keyState, "none");
  assert.equal(await client.addGameplayKey(), "ready");
}
if (!gameplayKeyPublic) {
  const stored = [...values.entries()].find(([name]) =>
    name.endsWith(":gameplay-key"),
  );
  gameplayKeyPublic = stored
    ? (JSON.parse(stored[1]) as { publicKey: string }).publicKey
    : null;
}
assert(gameplayKeyPublic, "Gameplay key public ID is missing");

let selected: { plotId: string; slot: number } | null = null;
for (const road of ["main", "market", "river", "central", "harbor"] as const) {
  for (const side of ["North", "South"] as const) {
    const street = await reader.streetSide(road, side);
    const open = street.plots.find(
      ({ plot, slots }) =>
        plot.plot.owner === null &&
        plot.effective_rule.kind === "Free" &&
        slots.some((session) => session === null),
    );
    if (open) {
      selected = {
        plotId: open.plot.plot.id,
        slot: open.slots.findIndex((session) => session === null),
      };
      break;
    }
  }
  if (selected) break;
}
assert(selected, "No open free curb slot was found");
const parkArgs = {
  car_id: car.id,
  plot_id: selected.plotId,
  slot: selected.slot,
};
const realSendSigned = reader.sendSignedTransaction.bind(reader);
const realTransactionStatus = reader.transactionStatus.bind(reader);
let signedSubmissions = 0;
let hiddenStatusReads = 0;
reader.sendSignedTransaction = async (signedTxBase64) => {
  signedSubmissions++;
  assert.equal(await realSendSigned(signedTxBase64), "success");
  throw new Error("Simulated network reply loss after final execution");
};
reader.transactionStatus = async (hash, accountId) => {
  if (hiddenStatusReads++ === 0) return "unknown";
  return realTransactionStatus(hash, accountId);
};
try {
  await assert.rejects(client.gameplayCall("park", parkArgs), /pending/);
} finally {
  reader.sendSignedTransaction = realSendSigned;
  reader.transactionStatus = realTransactionStatus;
}
assert.equal(signedSubmissions, 1, "Parking was submitted more than once");
const reopenedClient = Object.assign(
  Object.create(GameWalletClient.prototype),
  {
    reader,
    selector,
    lastCall: Promise.resolve(),
  },
) as GameWalletClient;
assert.equal(await reopenedClient.checkPendingGameplayAction(), "success");
assert.equal(signedSubmissions, 1, "Recovery rebroadcast the parked action");
const parked = await reader.player(credential.account_id);
assert(parked.active_session, "Parking did not finalize");
assert.equal(parked.active_session.location_id, selected.plotId);
assert.equal(parked.active_session.slot, selected.slot);
await reopenedClient.gameplayCall("collect", {
  expected_session_id: parked.active_session.id,
});
const collected = await reader.player(credential.account_id);
assert.equal(collected.active_session, null, "Collection did not free the car");
assert.equal(await reopenedClient.revokeGameplayKey(), "revoked");
const listedKeys = await reader.accessKeyList(credential.account_id);
assert(
  !listedKeys.keys.some((key) => key.public_key === gameplayKeyPublic),
  "Temporary gameplay key remains on-chain",
);
for (const entry of gameplayTransactions)
  assert.equal(
    await reader.transactionStatus(entry.hash, credential.account_id),
    "success",
    `${entry.method} is not final and successful`,
  );

const evidence = {
  network: "testnet",
  contractId: reader.contractId,
  driverId: credential.account_id,
  carId: car.id,
  plotId: selected.plotId,
  slot: selected.slot,
  sessionId: parked.active_session.id,
  fullAccessTransactionHashes: transactionHashes,
  gameplayTransactions,
  gameplayKeyPublic,
  gameplayKeyRevoked: true,
  simulatedReplyLossRecoveredWithoutRebroadcast: true,
  finalActiveSession: collected.active_session,
};
const evidenceFile = resolve(
  projectRoot,
  "deployments/testnet-web-signer-journey.json",
);
writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
