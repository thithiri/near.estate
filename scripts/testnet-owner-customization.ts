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
import { GameWalletClient } from "../apps/web/src/wallet-client.js";

if (process.argv.slice(2).join(" ") !== "--apply")
  throw new Error("Pass --apply to customize the isolated testnet plot");
const projectRoot = resolve(import.meta.dirname, "..");
function keyFromEnv(name: string) {
  const path = process.env[name];
  if (!path || !path.startsWith("/"))
    throw new Error(`Set ${name} to a private absolute credential file`);
  if (realpathSync(path).startsWith(`${projectRoot}/`))
    throw new Error(`${name} must be outside the repository`);
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error(`${name} must not be readable by group or others`);
  const record = JSON.parse(readFileSync(path, "utf8")) as {
    account_id: string;
    public_key: string;
    secret_key: `ed25519:${string}`;
  };
  const pair = KeyPair.fromString(record.secret_key);
  assert.equal(pair.getPublicKey().toString(), record.public_key);
  return {
    accountId: record.account_id,
    pair,
    secret: record.secret_key,
    path,
  };
}
const manifest = JSON.parse(
  readFileSync(
    resolve(projectRoot, "deployments/testnet-moderation-journey.json"),
    "utf8",
  ),
) as { contractId: string; ownerId: string };
const admin = keyFromEnv("ESTATE_MEDIA_CONTRACT_KEY_FILE");
const owner = keyFromEnv("ESTATE_MEDIA_OWNER_KEY_FILE");
assert.equal(admin.accountId, manifest.contractId);
assert.equal(owner.accountId, manifest.ownerId);
const reader = new ChainReader(manifest.contractId);
const plotId = "plot-main-n-0";
const storagePath = resolve(dirname(owner.path), "owner-web-storage.json");
const saved = existsSync(storagePath)
  ? (JSON.parse(readFileSync(storagePath, "utf8")) as Record<string, string>)
  : {};
const values = new Map(Object.entries(saved));
const gameplayTransactions: Array<{ method: string; hash: string }> = [];
let gameplayKeyPublic: string | null = null;
function persist() {
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
      if (name.endsWith(":pending") || name.endsWith(":gameplay-key")) {
        const key = JSON.parse(value) as { publicKey?: string };
        if (key.publicKey) gameplayKeyPublic = key.publicKey;
      }
      persist();
    },
    removeItem: (name: string) => {
      values.delete(name);
      persist();
    },
  },
});

const fullAccessTransactions: Array<{ action: string; hash: string }> = [];
let currentOwnerAction = "owner_wallet_action";
async function fullAccessCall(
  signer: typeof owner,
  action: string,
  receiverId: string,
  actions: Parameters<typeof createTransaction>[4],
) {
  const access = await reader.accessKey(
    signer.accountId,
    signer.pair.getPublicKey().toString(),
  );
  const transaction = createTransaction(
    signer.accountId,
    signer.pair.getPublicKey(),
    receiverId,
    access.nonce + 1n,
    actions,
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    signer.secret,
  ).signTransaction(transaction);
  const hash = baseEncode(hashBytes);
  const bytes = Buffer.from(encodeTransaction(signed)).toString("base64");
  let outcome: "success" | "failure" | "pending" = "pending";
  try {
    outcome = await reader.sendSignedTransaction(bytes);
  } catch {
    // A lost RPC response can still follow a finalized transaction.
  }
  for (let attempt = 0; outcome === "pending" && attempt < 8; attempt++) {
    await new Promise((done) => setTimeout(done, 1_000));
    const status = await reader.transactionStatus(hash, signer.accountId);
    if (status !== "unknown") outcome = status;
  }
  if (outcome !== "success")
    throw new Error(`${action} transaction ${hash} is ${outcome}`);
  fullAccessTransactions.push({ action, hash });
  return { status: { SuccessValue: "" } };
}

const selector = {
  store: {
    getState: () => ({
      contract: { contractId: reader.contractId },
      accounts: [{ accountId: owner.accountId, active: true }],
    }),
  },
  wallet: async () => ({
    signAndSendTransaction: async (request: {
      signerId: string;
      receiverId: string;
      actions: Parameters<typeof createTransaction>[4];
    }) => {
      assert.equal(request.signerId, owner.accountId);
      return fullAccessCall(
        owner,
        currentOwnerAction,
        request.receiverId,
        request.actions,
      );
    },
  }),
};
const client = Object.assign(Object.create(GameWalletClient.prototype), {
  reader,
  selector,
  lastCall: Promise.resolve(),
}) as GameWalletClient;
const before = await reader.plot(plotId);
assert.equal(before?.plot.owner, owner.accountId);
assert.equal(before.plot.building.building_type, "Retail");
assert.equal(before.plot.building.level, 1);
const playerBefore = await reader.player(owner.accountId);
assert(playerBefore.account, "Owner is not registered");
const original = await reader.view(
  "get_config",
  {},
  z.record(z.string(), z.unknown()),
);
assert.equal(original.change_building_type_cost, "100000000");
assert.deepEqual(original.building_upgrade_costs, [
  "200000000",
  "600000000",
  "1500000000",
]);
assert.equal(typeof original.version, "number");
let costsLowered = false;
try {
  const keyState = await client.resumePendingKey();
  if (keyState === "pending") {
    currentOwnerAction = "retry_gameplay_key";
    assert.equal(await client.retryPendingKey(), "ready");
  } else if (keyState !== "ready") {
    assert.equal(keyState, "none");
    currentOwnerAction = "add_gameplay_key";
    assert.equal(await client.addGameplayKey(), "ready");
  }
  await client.gameplayCall("set_rule", {
    plot_id: plotId,
    rule: { kind: "ColorOnly", color: "Blue" },
  });
  const scheduled = await reader.plot(plotId);
  assert.equal(scheduled?.effective_rule.kind, "Free");
  assert.equal(scheduled.plot.pending_rule?.rule.kind, "ColorOnly");
  currentOwnerAction = "revoke_gameplay_key";
  assert.equal(await client.revokeGameplayKey(), "revoked");
  if (gameplayKeyPublic) {
    const keys = await reader.accessKeyList(owner.accountId);
    assert(!keys.keys.some((key) => key.public_key === gameplayKeyPublic));
  }
  currentOwnerAction = "choose_preset";
  await client.choosePreset(plotId, 2, "#69B9E9", "Near Arcade");
  const cheap = {
    ...original,
    version: Number(original.version) + 1,
    change_building_type_cost: "1000000",
    building_upgrade_costs: [
      "1000000",
      ...(original.building_upgrade_costs as string[]).slice(1),
    ],
  };
  await fullAccessCall(admin, "lower_isolated_build_costs", admin.accountId, [
    actionCreators.functionCall(
      "update_config",
      { config: cheap },
      60n * 10n ** 12n,
      0n,
    ),
  ]);
  costsLowered = true;
  currentOwnerAction = "change_building_type";
  await client.changeBuildingType(plotId, "Cafe", 1);
  currentOwnerAction = "upgrade_building";
  await client.upgradeBuilding(plotId);
} finally {
  if (costsLowered) {
    const current = await reader.view(
      "get_config",
      {},
      z.record(z.string(), z.unknown()),
    );
    await fullAccessCall(
      admin,
      "restore_isolated_build_costs",
      admin.accountId,
      [
        actionCreators.functionCall(
          "update_config",
          { config: { ...original, version: Number(current.version) + 1 } },
          60n * 10n ** 12n,
          0n,
        ),
      ],
    );
  }
}
const after = await reader.plot(plotId);
const playerAfter = await reader.player(owner.accountId);
const configAfter = await reader.view(
  "get_config",
  {},
  z.record(z.string(), z.unknown()),
);
assert.equal(after?.plot.building.building_type, "Cafe");
assert.equal(after.plot.building.variant, 1);
assert.equal(after.plot.building.level, 2);
assert.equal(after.plot.building.name, "Near Arcade");
assert.equal(after.plot.building.primary_color, "#69B9E9");
assert.equal(after.plot.pending_rule?.rule.kind, "ColorOnly");
assert.equal(
  configAfter.change_building_type_cost,
  original.change_building_type_cost,
);
assert.deepEqual(
  configAfter.building_upgrade_costs,
  original.building_upgrade_costs,
);
assert(playerAfter.account);
assert.equal(
  BigInt(playerBefore.account.balance) - BigInt(playerAfter.account.balance),
  2_000_000n,
);
assert.equal(values.size, 0, "Temporary gameplay key remains in local storage");
const evidence = {
  network: "testnet",
  contractId: reader.contractId,
  ownerId: owner.accountId,
  plotId,
  building: after.plot.building,
  pendingRule: after.plot.pending_rule,
  effectiveRule: after.effective_rule,
  coinDebit: "2000000",
  testOnlyTypeAndFirstLevelCost: "1000000",
  restoredTypeCost: configAfter.change_building_type_cost,
  restoredUpgradeCosts: configAfter.building_upgrade_costs,
  finalConfigVersion: configAfter.version,
  defaultCostsRestored: true,
  gameplayKeyRevoked: true,
  gameplayTransactions,
  fullAccessTransactions,
};
const path = resolve(
  projectRoot,
  "deployments/testnet-owner-customization.json",
);
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
