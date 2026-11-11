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
  throw new Error("Pass --apply to run the shared-city owner journey");
const projectRoot = resolve(import.meta.dirname, "..");
const keyFile = process.env.ESTATE_SHARED_OWNER_KEY_FILE;
if (!keyFile || !keyFile.startsWith("/"))
  throw new Error(
    "Set ESTATE_SHARED_OWNER_KEY_FILE to a private absolute path",
  );
if (realpathSync(keyFile).startsWith(`${projectRoot}/`))
  throw new Error("Owner key must stay outside the repository");
if ((statSync(keyFile).mode & 0o077) !== 0)
  throw new Error("Owner key must not be readable by group or others");
const credential = JSON.parse(readFileSync(keyFile, "utf8")) as {
  account_id: string;
  public_key: string;
  secret_key: `ed25519:${string}`;
};
assert.match(credential.account_id, /^[a-z0-9._-]+\.testnet$/);
const pair = KeyPair.fromString(credential.secret_key);
assert.equal(pair.getPublicKey().toString(), credential.public_key);
const deployment = JSON.parse(
  readFileSync(resolve(projectRoot, "deployments/testnet.json"), "utf8"),
) as { network: string; contractId: string };
assert.equal(deployment.network, "testnet");
const reader = new ChainReader(deployment.contractId);
const plotId = "plot-main-n-2";
const storagePath = resolve(dirname(keyFile), "shared-owner-web-storage.json");
const saved = existsSync(storagePath)
  ? (JSON.parse(readFileSync(storagePath, "utf8")) as Record<string, string>)
  : {};
const values = new Map(Object.entries(saved));
const gameplayTransactions: Array<{ method: string; hash: string }> = [];
const fullAccessTransactions: Array<{ action: string; hash: string }> = [];
let gameplayKeyPublic: string | null = null;
let currentAction = "owner_wallet_action";

function persistStorage() {
  const temporary = `${storagePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(Object.fromEntries(values)), {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, storagePath);
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
        const record = JSON.parse(value) as { publicKey?: string };
        if (record.publicKey) gameplayKeyPublic = record.publicKey;
      }
      persistStorage();
    },
    removeItem: (name: string) => {
      values.delete(name);
      persistStorage();
    },
  },
});

async function fullAccessCall(
  receiverId: string,
  actions: Parameters<typeof createTransaction>[4],
) {
  const access = await reader.accessKey(
    credential.account_id,
    credential.public_key,
  );
  const transaction = createTransaction(
    credential.account_id,
    pair.getPublicKey(),
    receiverId,
    access.nonce + 1n,
    actions,
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    credential.secret_key,
  ).signTransaction(transaction);
  const hash = baseEncode(hashBytes);
  const bytes = Buffer.from(encodeTransaction(signed)).toString("base64");
  let outcome: "success" | "failure" | "pending" = "pending";
  try {
    outcome = await reader.sendSignedTransaction(bytes);
  } catch {
    // The exact transaction may have finalized despite a lost RPC response.
  }
  for (let attempt = 0; outcome === "pending" && attempt < 8; attempt++) {
    await new Promise((done) => setTimeout(done, 1_000));
    const status = await reader.transactionStatus(hash, credential.account_id);
    if (status !== "unknown") outcome = status;
  }
  if (outcome !== "success")
    throw new Error(`${currentAction} transaction ${hash} is ${outcome}`);
  fullAccessTransactions.push({ action: currentAction, hash });
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
      actions: Parameters<typeof createTransaction>[4];
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
if (!before.account) {
  currentAction = "register_player";
  await client.register("Hatchback", "Green");
}
const registered = await reader.player(credential.account_id);
assert(registered.account, "Owner registration did not finalize");
assert.equal(registered.cars.length, 1);
const plotBefore = await reader.plot(plotId);
assert(plotBefore, "Seeded plot is missing");
if (plotBefore.plot.owner && plotBefore.plot.owner !== credential.account_id)
  throw new Error("Selected shared-city plot belongs to another owner");
const quote = await reader.plotPurchaseQuote(plotId);
if (!plotBefore.plot.owner) {
  currentAction = "buy_plot";
  await client.buyPlot(plotId, quote);
}
const owned = await reader.plot(plotId);
assert.equal(owned?.plot.owner, credential.account_id);

const keyState = await client.resumePendingKey();
if (keyState === "pending") {
  currentAction = "retry_gameplay_key";
  assert.equal(await client.retryPendingKey(), "ready");
} else if (keyState !== "ready") {
  assert.equal(keyState, "none");
  currentAction = "add_gameplay_key";
  assert.equal(await client.addGameplayKey(), "ready");
}
try {
  if (owned.plot.pending_rule?.rule.kind !== "Meter") {
    await client.gameplayCall("set_rule", {
      plot_id: plotId,
      rule: { kind: "Meter", ratePerHour: "1000000" },
    });
  }
} finally {
  currentAction = "revoke_gameplay_key";
  assert.equal(await client.revokeGameplayKey(), "revoked");
}
if (gameplayKeyPublic) {
  const keys = await reader.accessKeyList(credential.account_id);
  assert(!keys.keys.some((key) => key.public_key === gameplayKeyPublic));
}
const rulePlot = await reader.plot(plotId);
assert.equal(rulePlot?.plot.pending_rule?.rule.kind, "Meter");
assert.equal(rulePlot.plot.pending_rule.rule.ratePerHour, "1000000");
const building = rulePlot.plot.building;
if (
  building.variant !== 2 ||
  building.primary_color !== "#73D9A6" ||
  building.name !== "Near Garden"
) {
  currentAction = "choose_preset";
  await client.choosePreset(plotId, 2, "#73D9A6", "Near Garden");
}
const finalPlot = await reader.plot(plotId);
assert.equal(finalPlot?.plot.owner, credential.account_id);
assert.equal(finalPlot.plot.building.variant, 2);
assert.equal(finalPlot.plot.building.primary_color, "#73D9A6");
assert.equal(finalPlot.plot.building.name, "Near Garden");
const street = await reader.streetSide("main", "North");
const publicPlot = street.plots.find((entry) => entry.plot.plot.id === plotId);
assert.equal(publicPlot?.plot.plot.owner, credential.account_id);
assert.equal(publicPlot.plot.plot.building.name, "Near Garden");
const playerAfter = await reader.player(credential.account_id);
assert(playerAfter.account);
assert.equal(playerAfter.account.balance, "100000000");
assert.equal(values.size, 0, "Temporary gameplay key remains in local storage");
const evidence = {
  network: "testnet",
  contractId: reader.contractId,
  ownerId: credential.account_id,
  plotId,
  purchaseQuoteYocto: quote,
  registeredWithStarterCar: true,
  plotOwnerVerified: true,
  pendingRule: finalPlot.plot.pending_rule,
  building: finalPlot.plot.building,
  streetViewMatches: true,
  coinBalance: playerAfter.account.balance,
  gameplayKeyRevoked: true,
  gameplayTransactions,
  fullAccessTransactions,
};
writeFileSync(
  resolve(projectRoot, "deployments/testnet-shared-owner-journey.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence, null, 2));
