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

if (process.argv.slice(2).join(" ") !== "--apply")
  throw new Error("Pass --apply to run the shared-city building upgrade");
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
) as { network: string; contractId: string };
assert.equal(deployment.network, "testnet");
const owner = JSON.parse(
  readFileSync(
    resolve(root, "deployments/testnet-shared-owner-journey.json"),
    "utf8",
  ),
) as { ownerId: string; contractId: string; plotId: string };
assert.equal(owner.ownerId, credential.account_id);
assert.equal(owner.contractId, deployment.contractId);
const reader = new ChainReader(deployment.contractId);
const journalPath = resolve(
  dirname(keyFile),
  "shared-owner-upgrade-journal.json",
);

type Journal = {
  hash: string;
  signedBase64: string;
  balanceBefore: string;
  costAtomic: string;
  layoutBefore: number;
  appearanceBefore: number;
  facadeHashBefore: string;
  logoHashBefore: string;
  billboardHashBefore: string;
};

function saveJournal(journal: Journal) {
  const temporary = `${journalPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, journalPath);
}

async function prepare(): Promise<Journal> {
  const [plot, player, config] = await Promise.all([
    reader.plot(owner.plotId),
    reader.player(credential.account_id),
    reader.ownerConfig(),
  ]);
  assert(plot, "Owned plot is missing");
  assert.equal(plot.plot.owner, credential.account_id);
  assert.equal(plot.plot.building.level, 1, "Building must start at level 1");
  assert(plot.logo_eligible && plot.billboard_eligible);
  const facadeHashBefore = plot.plot.building.approved_manifest_hash;
  const logoHashBefore = plot.plot.logo.active?.content.asset_hash;
  const billboardHashBefore = plot.plot.billboard.active?.content.asset_hash;
  assert(facadeHashBefore && logoHashBefore && billboardHashBefore);
  assert(player.account, "Owner is not registered");
  assert(!player.active_session, "Finish parking before upgrading");
  const costAtomic = config.building_upgrade_costs[0];
  assert.equal(costAtomic, "200000000", "Normal level-2 price changed");
  assert(
    BigInt(player.account.balance) >= BigInt(costAtomic),
    "Earn enough coins at the normal price before upgrading",
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
    [
      actionCreators.functionCall(
        "upgrade_building",
        { plot_id: owner.plotId },
        60n * 10n ** 12n,
        0n,
      ),
    ],
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    credential.secret_key,
  ).signTransaction(transaction);
  const journal: Journal = {
    hash: baseEncode(hashBytes),
    signedBase64: Buffer.from(encodeTransaction(signed)).toString("base64"),
    balanceBefore: player.account.balance,
    costAtomic,
    layoutBefore: plot.plot.building.layout_revision,
    appearanceBefore: plot.plot.building.appearance_revision,
    facadeHashBefore,
    logoHashBefore,
    billboardHashBefore,
  };
  saveJournal(journal);
  return journal;
}

const journal = existsSync(journalPath)
  ? (JSON.parse(readFileSync(journalPath, "utf8")) as Journal)
  : await prepare();
let outcome = await reader.transactionStatus(
  journal.hash,
  credential.account_id,
);
if (outcome === "unknown") {
  try {
    outcome = await reader.sendSignedTransaction(journal.signedBase64);
  } catch {
    // Keep the exact signed bytes for status recovery after a lost reply.
  }
}
for (
  let attempt = 0;
  (outcome === "unknown" || outcome === "pending") && attempt < 8;
  attempt++
) {
  await new Promise((done) => setTimeout(done, 1_000));
  outcome = await reader.transactionStatus(journal.hash, credential.account_id);
}
if (outcome !== "success")
  throw new Error(`Upgrade transaction ${journal.hash} is ${outcome}`);

const [plot, street, player] = await Promise.all([
  reader.plot(owner.plotId),
  reader.streetSide("main", "North"),
  reader.player(credential.account_id),
]);
assert(plot && player.account);
assert.equal(plot.plot.owner, credential.account_id);
assert.equal(plot.plot.building.level, 2);
assert.equal(plot.plot.building.layout_revision, journal.layoutBefore + 1);
assert.equal(
  plot.plot.building.appearance_revision,
  journal.appearanceBefore + 1,
);
assert.equal(plot.plot.building.approved_manifest_hash, null);
assert.equal(plot.plot.logo.active?.content.asset_hash, journal.logoHashBefore);
assert.equal(
  plot.plot.billboard.active?.content.asset_hash,
  journal.billboardHashBefore,
);
assert(!plot.logo_eligible && !plot.billboard_eligible);
assert.equal(
  BigInt(player.account.balance),
  BigInt(journal.balanceBefore) - BigInt(journal.costAtomic),
);
const publicPlot = street.plots.find(
  (entry) => entry.plot.plot.id === owner.plotId,
);
assert.equal(publicPlot?.plot.plot.building.level, 2);
assert.equal(
  publicPlot.plot.plot.building.layout_revision,
  journal.layoutBefore + 1,
);
assert(!publicPlot.plot.logo_eligible && !publicPlot.plot.billboard_eligible);
const evidence = {
  network: "testnet",
  contractId: deployment.contractId,
  ownerId: credential.account_id,
  plotId: owner.plotId,
  upgradeHash: journal.hash,
  normalCostAtomic: journal.costAtomic,
  balanceBefore: journal.balanceBefore,
  balanceAfter: player.account.balance,
  levelBefore: 1,
  levelAfter: plot.plot.building.level,
  layoutBefore: journal.layoutBefore,
  layoutAfter: plot.plot.building.layout_revision,
  previousFacadeHash: journal.facadeHashBefore,
  previousLogoHash: journal.logoHashBefore,
  previousBillboardHash: journal.billboardHashBefore,
  facadeResetToPreset: true,
  logoEligibleAfter: plot.logo_eligible,
  billboardEligibleAfter: plot.billboard_eligible,
  anonymousStreetMatches: true,
};
writeFileSync(
  resolve(root, "deployments/testnet-shared-upgrade-journey.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify({ status: "upgraded", evidence }, null, 2));
