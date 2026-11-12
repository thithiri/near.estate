import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ChainPlotV2,
  canonicalJson,
  validateAssetManifestV2,
  variableFrontageMediaLayout,
} from "@estate/shared";
import sharp from "sharp";
import { checkedFacadeCandidate, createApiApp } from "./app.js";
import { saveImmutablePng } from "./asset-storage.js";
import { ApiStore } from "./store.js";
import { composeVariableFacadePreview } from "./variable-art.js";
import { buildVariableGenerationPrompt } from "./variable-prompt-builder.js";

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("approved sandbox facade and logo hashes serve exact local images", async () => {
  const contract = JSON.parse(
    await readFile(
      new URL(
        "../../../deployments/variable-city-contract-media-fixture-2026-11-12.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    plotId: string;
    appearanceReference: {
      revision: number;
      owner: string;
      building_type: string;
      level: number;
      manifest_hash: string;
    };
    pendingPlot: { plot: { building: { layout_revision: number } } };
    approvedPlot: {
      plot: { building: { approved_manifest_hash: string } };
    };
    logoHash: string;
    logoApprovedPlot: unknown;
  };
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../tests/fixtures/variable-city-media/fixture.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    manifest: unknown;
    manifestHash: string;
    spriteHash: string;
    thumbnailHash: string;
    logoHash: string;
    promptSpec: unknown;
  };
  const manifest = validateAssetManifestV2(fixture.manifest);
  assert.equal(hash(canonicalJson(manifest)), fixture.manifestHash);
  assert.equal(
    contract.appearanceReference.manifest_hash,
    fixture.manifestHash,
  );
  assert.equal(
    contract.approvedPlot.plot.building.approved_manifest_hash,
    fixture.manifestHash,
  );
  assert.equal(contract.logoHash, fixture.logoHash);
  const logoView = ChainPlotV2.parse(contract.logoApprovedPlot);
  assert.equal(logoView.plot.logo.active?.content.asset_hash, fixture.logoHash);
  assert.equal(logoView.logo_eligible, true);
  const promptSpec = buildVariableGenerationPrompt({
    frontageUnits: 3,
    designChoice: 0,
    buildingType: "Retail",
    level: 2,
    palette: "#EF8270",
    description: "Warm market windows and copper trim",
  });
  assert.deepEqual(fixture.promptSpec, promptSpec);
  const sprite = await readFile(
    new URL(
      `../../../tests/fixtures/variable-city-media/${fixture.spriteHash}.png`,
      import.meta.url,
    ),
  );
  const thumbnail = await readFile(
    new URL(
      `../../../tests/fixtures/variable-city-media/${fixture.thumbnailHash}.png`,
      import.meta.url,
    ),
  );
  const logo = await readFile(
    new URL(
      `../../../tests/fixtures/variable-city-media/${fixture.logoHash}.png`,
      import.meta.url,
    ),
  );
  assert.equal(hash(sprite), manifest.spriteHash);
  assert.equal(hash(thumbnail), manifest.thumbnailHash);
  assert.equal(hash(logo), fixture.logoHash);

  const dir = await mkdtemp(join(tmpdir(), "estate-sandbox-media-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  try {
    await Promise.all([
      saveImmutablePng(store.assetDir, fixture.spriteHash, sprite),
      saveImmutablePng(store.assetDir, fixture.thumbnailHash, thumbnail),
      saveImmutablePng(store.assetDir, fixture.logoHash, logo),
    ]);
    const job = store.createGeneration({
      accountId: contract.appearanceReference.owner,
      plotId: contract.plotId,
      buildingType: "Retail",
      level: 2,
      layoutRevision: contract.pendingPlot.plot.building.layout_revision,
      appearanceRevision: contract.appearanceReference.revision - 1,
      description: promptSpec.description,
      promptSpec,
      candidates: [
        {
          id: 1,
          variant: 1,
          palette: promptSpec.palette,
          manifest,
          manifestHash: fixture.manifestHash,
          spriteHash: fixture.spriteHash,
          thumbnailHash: fixture.thumbnailHash,
        },
      ],
      createdAt: 1_000,
    });
    assert.deepEqual(
      await checkedFacadeCandidate(store, job, job.candidates[0]!),
      thumbnail,
    );
    assert.ok(store.selectGeneration(job.id, job.accountId, 1));
    store.markGenerationSubmitted(
      job.id,
      contract.appearanceReference.revision,
    );
    store.markGenerationDecided(job.id, "approved", 1_001, null);
    const approvedLogo = logoView.plot.logo.active;
    assert.ok(approvedLogo);
    const upload = store.recordUpload({
      accountId: contract.appearanceReference.owner,
      plotId: contract.plotId,
      kind: "Logo",
      hash: fixture.logoHash,
      layoutRevision: approvedLogo.approved_layout_revision,
      createdAt: 1_002,
    });
    const logoProposal = store.createMediaProposal({
      uploadId: upload.id,
      accountId: contract.appearanceReference.owner,
      plotId: contract.plotId,
      kind: "Logo",
      assetHash: fixture.logoHash,
      link: approvedLogo.content.link,
      buildingType: logoView.plot.building.building_type,
      level: logoView.plot.building.level,
      layoutRevision: approvedLogo.approved_layout_revision,
      expectedMediaRevision: logoView.plot.logo.revision - 1,
      createdAt: 1_002,
    });
    store.markMediaSubmitted(logoProposal.id, logoView.plot.logo.revision);
    store.markMediaDecided(logoProposal.id, "approved", 1_003, null);
    const app = createApiApp({
      store,
      chain: null,
      appOrigin: "http://localhost:8080",
    });
    const manifestResponse = await app.request(
      `/manifests/${fixture.manifestHash}`,
    );
    assert.equal(manifestResponse.status, 200);
    assert.deepEqual(await manifestResponse.json(), manifest);
    const spriteResponse = await app.request(`/assets/${fixture.spriteHash}`);
    assert.equal(spriteResponse.status, 200);
    assert.equal(
      spriteResponse.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.deepEqual(Buffer.from(await spriteResponse.arrayBuffer()), sprite);
    const logoResponse = await app.request(`/assets/${fixture.logoHash}`);
    assert.equal(logoResponse.status, 200);
    assert.deepEqual(Buffer.from(await logoResponse.arrayBuffer()), logo);
    const previewWithoutLogo = await composeVariableFacadePreview({
      plot: logoView,
      approvedFacade: { manifest, sprite },
    });
    const previewWithLogo = await composeVariableFacadePreview({
      plot: logoView,
      approvedFacade: { manifest, sprite },
      logo,
    });
    const mark = variableFrontageMediaLayout(3, 0, 2).logo;
    const center = {
      left: Math.floor(mark.x + mark.width / 2),
      top: Math.floor(mark.y + mark.height / 2),
      width: 1,
      height: 1,
    };
    const plainPixel = await sharp(previewWithoutLogo)
      .extract(center)
      .raw()
      .toBuffer();
    const logoPixel = await sharp(previewWithLogo)
      .extract(center)
      .raw()
      .toBuffer();
    assert.notDeepEqual(logoPixel, plainPixel);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
