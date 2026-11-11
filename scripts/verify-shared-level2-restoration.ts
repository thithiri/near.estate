import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChainReader } from "../apps/web/src/chain-reader.js";
import { createApiApp } from "../services/api/src/app.js";
import { ApiStore } from "../services/api/src/store.js";

const root = resolve(import.meta.dirname, "..");
const dataDir = process.env.ESTATE_MEDIA_DATA_DIR;
if (!dataDir || !dataDir.startsWith("/") || dataDir.startsWith(`${root}/`))
  throw new Error("Set ESTATE_MEDIA_DATA_DIR outside the repository");
const readEvidence = (name: string) =>
  JSON.parse(readFileSync(resolve(root, `deployments/${name}`), "utf8")) as {
    contractId: string;
    plotId: string;
    moderatorId?: string;
    moderatorRuntimePublicKey?: string;
    manifestHash?: string;
    spriteHash?: string;
    logoHash?: string;
    billboardHash?: string;
    link?: string;
    layoutRevision?: number;
    layoutAfter?: number;
    levelAfter?: number;
    normalCostAtomic?: string;
  };
const upgrade = readEvidence("testnet-shared-upgrade-journey.json");
const facade = readEvidence("testnet-shared-level2-facade-journey.json");
const logo = readEvidence("testnet-shared-level2-logo-revalidation.json");
const billboard = readEvidence(
  "testnet-shared-level2-billboard-revalidation.json",
);
const originalLogo = readEvidence("testnet-shared-media-journey.json");
const originalBillboard = readEvidence("testnet-shared-billboard-journey.json");
assert.equal(upgrade.normalCostAtomic, "200000000");
assert.equal(upgrade.levelAfter, 2);
assert(upgrade.layoutAfter && facade.layoutRevision);
assert.equal(facade.layoutRevision, upgrade.layoutAfter + 1);
assert(facade.manifestHash && facade.spriteHash);
assert(facade.moderatorId && facade.moderatorRuntimePublicKey);
assert(logo.logoHash && billboard.billboardHash);
assert.equal(logo.logoHash, originalLogo.logoHash);
assert.equal(logo.link, originalLogo.link);
assert.equal(billboard.billboardHash, originalBillboard.billboardHash);
assert.equal(billboard.link, originalBillboard.link);
for (const entry of [upgrade, logo, billboard]) {
  assert.equal(entry.contractId, facade.contractId);
  assert.equal(entry.plotId, facade.plotId);
}

const reader = new ChainReader(facade.contractId);
const moderatorKeys = await reader.accessKeyList(facade.moderatorId);
assert(
  !moderatorKeys.keys.some(
    (key) => key.public_key === facade.moderatorRuntimePublicKey,
  ),
  "Temporary moderator key is still active",
);
const street = await reader.streetSide("main", "North");
const entry = street.plots.find((item) => item.plot.plot.id === facade.plotId);
assert(entry, "Approved plot is missing from the anonymous street view");
const plot = entry.plot;
assert.equal(plot.plot.building.level, 2);
assert.equal(plot.plot.building.approved_manifest_hash, facade.manifestHash);
assert.equal(plot.plot.building.layout_revision, facade.layoutRevision);
assert(plot.logo_eligible && plot.billboard_eligible);
assert.equal(plot.plot.logo.active?.content.asset_hash, logo.logoHash);
assert.equal(
  plot.plot.billboard.active?.content.asset_hash,
  billboard.billboardHash,
);
assert.equal(plot.plot.logo.active?.content.link, logo.link);
assert.equal(plot.plot.billboard.active?.content.link, billboard.link);
assert.equal(
  plot.plot.logo.active?.approved_layout_revision,
  facade.layoutRevision,
);
assert.equal(
  plot.plot.billboard.active?.approved_layout_revision,
  facade.layoutRevision,
);

const store = new ApiStore(
  resolve(dataDir, "estate.sqlite"),
  resolve(dataDir, "assets"),
);
try {
  const app = createApiApp({
    store,
    chain: null,
    appOrigin: "http://localhost:8080",
  });
  const manifest = await app.request(`/manifests/${facade.manifestHash}`);
  assert.equal(manifest.status, 200);
  const assetChecks: Record<string, boolean> = {};
  for (const [kind, assetHash] of [
    ["facade", facade.spriteHash],
    ["logo", logo.logoHash],
    ["billboard", billboard.billboardHash],
  ] as const) {
    const response = await app.request(`/assets/${assetHash}`);
    assert.equal(response.status, 200, `${kind} is not public`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), assetHash);
    assetChecks[kind] = true;
  }
  const evidence = {
    network: "testnet",
    contractId: facade.contractId,
    plotId: facade.plotId,
    normalUpgradeCostAtomic: upgrade.normalCostAtomic,
    level: 2,
    facadeManifestHash: facade.manifestHash,
    facadeSpriteHash: facade.spriteHash,
    logoHash: logo.logoHash,
    billboardHash: billboard.billboardHash,
    layoutRevision: facade.layoutRevision,
    anonymousStreetView: {
      facadeActive: true,
      logoEligible: true,
      billboardEligible: true,
      bothMediaMatchNewLayout: true,
      originalMediaAndLinksRestored: true,
    },
    anonymousManifestReadable: true,
    anonymousAssetHashesVerified: assetChecks,
    temporaryModeratorKeyRevoked: true,
  };
  writeFileSync(
    resolve(root, "deployments/testnet-shared-level2-combined.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  store.close();
}
