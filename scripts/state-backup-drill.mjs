#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { canonicalJson } from "@estate/shared";
import { ApiStore } from "../services/api/dist/store.js";
import { EventStore } from "../services/worker/dist/event-store.js";
import {
  verifyCarriedMedia,
  verifyDeedWorkflows,
  verifyVariableCityBackup,
} from "./variable-city-backup.mjs";

const root = await mkdtemp(join(tmpdir(), "estate-backup-drill-"));
const data = join(root, "data");
const metadata = join(root, "deployments");
const archive = join(root, "backup");
const restoredData = join(root, "restored-data");
const restoredMetadata = join(root, "restored-deployments");
const command = join(import.meta.dirname, "state-backup.mjs");
const deployment = JSON.parse(
  await readFile(
    join(import.meta.dirname, "..", "deployments", "testnet.json"),
    "utf8",
  ),
);
const contractId = deployment.contractId;
const timestampNs = "1794316011248367505";
const first = {
  height: 10,
  hash: "drill-hash-10",
  prevHash: "drill-hash-9",
  timestampNs,
  source: "neardata",
  events: [
    {
      id: "drill-receipt-a:0:0",
      receiptId: "drill-receipt-a",
      logIndex: 0,
      dataIndex: 0,
      event: "parked",
      payload: {
        session_id: 1,
        car_id: 1,
        driver: "driver.testnet",
        location_id: "plot-main-n-0",
        slot: 0,
        facility: "Curb",
        legal: true,
        expires_at: 1_800_000,
      },
    },
  ],
};
const second = {
  height: 11,
  hash: "drill-hash-11",
  prevHash: "drill-hash-10",
  timestampNs,
  source: "neardata",
  events: [
    {
      id: "drill-receipt-b:0:0",
      receiptId: "drill-receipt-b",
      logIndex: 0,
      dataIndex: 0,
      event: "collected",
      payload: {
        session_id: 1,
        location_id: "plot-main-n-0",
        slot: 0,
        facility: "Curb",
        gross: "1000000",
        driver_payout: "1000000",
        recipient_payout: "0",
        forfeited: "0",
      },
    },
  ],
};
const next = {
  height: 12,
  hash: "drill-hash-12",
  prevHash: "drill-hash-11",
  timestampNs,
  source: "neardata",
  events: [],
};

try {
  await mkdir(data);
  await mkdir(metadata);
  await writeFile(join(metadata, "testnet.json"), JSON.stringify(deployment));
  await writeFile(
    join(metadata, "testnet-floor-upgrade.json"),
    await readFile(
      join(
        import.meta.dirname,
        "..",
        "deployments",
        "testnet-floor-upgrade.json",
      ),
    ),
  );
  const api = new ApiStore(join(data, "estate.sqlite"), join(data, "assets"));
  const png = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 255, g: 202, b: 36, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const assetHash = createHash("sha256").update(png).digest("hex");
  const paidThumbnail = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 72, g: 143, b: 230, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const paidThumbnailHash = createHash("sha256")
    .update(paidThumbnail)
    .digest("hex");
  await writeFile(join(data, "assets", `${assetHash}.png`), png);
  await writeFile(
    join(data, "assets", ".11111111-1111-1111-1111-111111111111.tmp"),
    Buffer.from("incomplete write"),
  );
  const upload = api.recordUpload({
    accountId: "owner.testnet",
    plotId: "plot-main-n-0",
    kind: "Logo",
    hash: assetHash,
    layoutRevision: 1,
    createdAt: 1_800_001,
  });
  const approvedProposal = api.createMediaProposal({
    uploadId: upload.id,
    accountId: "owner.testnet",
    plotId: "plot-main-n-0",
    kind: "Logo",
    assetHash,
    link: null,
    buildingType: "Retail",
    level: 1,
    layoutRevision: 1,
    expectedMediaRevision: 0,
    createdAt: 1_800_001,
  });
  api.markMediaSubmitted(approvedProposal.id, 1);
  api.markMediaDecided(approvedProposal.id, "approved", 1_800_002, null);
  const pendingUpload = api.recordUpload({
    accountId: "owner.testnet",
    plotId: "plot-main-n-0",
    kind: "Billboard",
    hash: paidThumbnailHash,
    layoutRevision: 1,
    createdAt: 1_800_001,
  });
  const pendingProposal = api.createMediaProposal({
    uploadId: pendingUpload.id,
    accountId: "owner.testnet",
    plotId: "plot-main-n-0",
    kind: "Billboard",
    assetHash: paidThumbnailHash,
    link: null,
    buildingType: "Retail",
    level: 1,
    layoutRevision: 1,
    expectedMediaRevision: 0,
    createdAt: 1_800_001,
  });
  api.markMediaSubmitted(pendingProposal.id, 1);
  const facadeManifest = {
    schemaVersion: 1,
    renderProfileVersion: 1,
    buildingType: "Retail",
    level: 1,
    spriteHash: assetHash,
    thumbnailHash: paidThumbnailHash,
    alphaBounds: { x: 0, y: 90, width: 140, height: 70 },
    logoRect: null,
    billboardRect: null,
  };
  const facadeHash = createHash("sha256")
    .update(canonicalJson(facadeManifest))
    .digest("hex");
  api.db
    .prepare(
      `INSERT INTO generation_jobs
       (id, account_id, plot_id, building_type, level, layout_revision,
        description, candidates_json, created_at, status, selected_candidate_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "approved-facade-job",
      "owner.testnet",
      "plot-main-n-0",
      "Retail",
      1,
      1,
      "Backup fixture",
      JSON.stringify([
        {
          id: 1,
          manifestHash: facadeHash,
          manifest: facadeManifest,
          spriteHash: assetHash,
          thumbnailHash: paidThumbnailHash,
        },
      ]),
      1_800_001,
      "approved",
      1,
    );
  api.db
    .prepare(
      "INSERT INTO generation_assets (job_id, hash, is_public) VALUES (?, ?, 1)",
    )
    .run("approved-facade-job", assetHash);
  api.db
    .prepare(
      "INSERT INTO generation_assets (job_id, hash, is_public) VALUES (?, ?, 1)",
    )
    .run("approved-facade-job", paidThumbnailHash);
  const expiredHash = "f".repeat(64);
  const expiredUpload = api.recordUpload({
    accountId: "owner.testnet",
    plotId: "plot-main-n-0",
    kind: "Billboard",
    hash: expiredHash,
    layoutRevision: 1,
    createdAt: 1_000_000,
  });
  const expiredProposal = api.createMediaProposal({
    uploadId: expiredUpload.id,
    accountId: "owner.testnet",
    plotId: "plot-main-n-0",
    kind: "Billboard",
    assetHash: expiredHash,
    link: null,
    buildingType: "Retail",
    level: 1,
    layoutRevision: 1,
    expectedMediaRevision: 0,
    createdAt: 1_000_000,
  });
  api.markMediaSubmitted(expiredProposal.id, 1_000_001);
  api.markMediaDecided(expiredProposal.id, "rejected", 1_000_002, "Test");
  assert.equal(api.expireStaleUploads(1_800_000), 1);
  assert.equal(api.upload(expiredUpload.id), null);
  api.db.exec(`
    CREATE TABLE paid_generation_candidates (
      job_id TEXT NOT NULL,
      review_status TEXT NOT NULL,
      sprite_hash TEXT NOT NULL,
      thumbnail_hash TEXT NOT NULL
    );
  `);
  api.db
    .prepare("INSERT INTO paid_generation_candidates VALUES (?, ?, ?, ?)")
    .run("approved-paid-job", "approved", assetHash, paidThumbnailHash);
  api.close();
  const indexer = new EventStore(join(data, "estate.sqlite"), contractId, 10);
  assert.equal(indexer.applyHeight(10, first), 1);
  assert.equal(indexer.applyHeight(11, second), 1);
  indexer.close();

  await rm(join(data, "assets", `${assetHash}.png`));
  const missingBackup = join(root, "missing-asset-backup");
  const missingAsset = spawnSync(
    process.execPath,
    [command, "backup", data, metadata, missingBackup],
    { encoding: "utf8" },
  );
  assert.notEqual(missingAsset.status, 0);
  assert.match(missingAsset.stderr, /Referenced artwork is missing/);
  await assert.rejects(readFile(join(missingBackup, "manifest.json")));
  await writeFile(join(data, "assets", `${assetHash}.png`), png);

  const missingApprovedBackup = join(root, "missing-approved-backup");
  const missingApprovedAsset = spawnSync(
    process.execPath,
    [command, "backup", data, metadata, missingApprovedBackup],
    { encoding: "utf8" },
  );
  assert.notEqual(missingApprovedAsset.status, 0);
  assert.match(missingApprovedAsset.stderr, new RegExp(paidThumbnailHash));
  await assert.rejects(readFile(join(missingApprovedBackup, "manifest.json")));
  await writeFile(
    join(data, "assets", `${paidThumbnailHash}.png`),
    paidThumbnail,
  );

  const backup = JSON.parse(
    execFileSync(
      process.execPath,
      [command, "backup", data, metadata, archive],
      {
        encoding: "utf8",
      },
    ),
  );
  assert.equal(backup.eventCount, 2);
  assert.equal(backup.cursor.last_height, 11);
  assert.equal(backup.files, 5);
  const frozenInventory = {
    paused: true,
    contractId,
    finalBlock: { hash: second.hash, height: 11 },
    ownedPlots: [
      {
        id: "plot-main-n-0",
        owner: "owner.testnet",
        building: {
          approved_manifest_hash: facadeHash,
          pending_appearance: null,
        },
        logo: {
          active: {
            content: { asset_hash: assetHash, link: null },
            approved_layout_revision: 1,
          },
        },
        billboard: {
          active: null,
          pending: {
            revision: 1,
            owner: "owner.testnet",
            building_type: "Retail",
            level: 1,
            layout_revision: 1,
            content: { asset_hash: paidThumbnailHash, link: null },
          },
        },
      },
    ],
  };
  const deedMoves = [{ from: "plot-main-n-0", to: "plot-main-n-1" }];
  const migrationBackup = await verifyVariableCityBackup(
    archive,
    frozenInventory,
    deedMoves,
  );
  assert.equal(migrationBackup.indexerCursorHeight, 11);
  assert.match(migrationBackup.backupManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(migrationBackup.chainMediaAssetsVerified, true);
  assert.equal(migrationBackup.carriedLogoAndBillboardCount, 2);
  assert.equal(migrationBackup.carriedFacadeCount, 1);
  assert.equal(migrationBackup.deedWorkflowsVerified, true);
  assert.equal(migrationBackup.deedWorkflowMoveCount, 1);
  assert.ok(migrationBackup.deedWorkflowSourceRows >= 4);
  assert.throws(
    () =>
      verifyCarriedMedia(
        archive,
        {
          ownedPlots: [
            { ...frozenInventory.ownedPlots[0], owner: "someone-else.testnet" },
          ],
        },
        new Set([assetHash, paidThumbnailHash]),
      ),
    /Carried logo is not public in the backup/,
  );
  const sourceDb = new DatabaseSync(join(data, "estate.sqlite"));
  try {
    sourceDb
      .prepare("UPDATE media_proposals SET status = 'rejected' WHERE id = ?")
      .run(pendingProposal.id);
    assert.throws(
      () =>
        verifyCarriedMedia(
          data,
          frozenInventory,
          new Set([assetHash, paidThumbnailHash]),
        ),
      /Carried pending billboard moderation proposal is missing/,
    );
    sourceDb
      .prepare("UPDATE media_proposals SET status = 'submitted' WHERE id = ?")
      .run(pendingProposal.id);
    sourceDb
      .prepare("UPDATE media_proposals SET status = 'revoked' WHERE id = ?")
      .run(approvedProposal.id);
    assert.throws(
      () =>
        verifyCarriedMedia(
          data,
          frozenInventory,
          new Set([assetHash, paidThumbnailHash]),
        ),
      /Carried logo moderation proposal is missing/,
    );
    sourceDb
      .prepare("UPDATE media_proposals SET status = 'approved' WHERE id = ?")
      .run(approvedProposal.id);
    sourceDb
      .prepare("UPDATE generation_jobs SET status = 'revoked' WHERE id = ?")
      .run("approved-facade-job");
    assert.throws(
      () =>
        verifyCarriedMedia(
          data,
          frozenInventory,
          new Set([assetHash, paidThumbnailHash]),
        ),
      /Carried approved facade manifest is missing/,
    );
    sourceDb
      .prepare("UPDATE generation_jobs SET status = 'approved' WHERE id = ?")
      .run("approved-facade-job");
    sourceDb
      .prepare("UPDATE generation_assets SET is_public = 0 WHERE hash = ?")
      .run(paidThumbnailHash);
    assert.throws(
      () =>
        verifyCarriedMedia(
          data,
          frozenInventory,
          new Set([assetHash, paidThumbnailHash]),
        ),
      /Carried approved facade asset is not public/,
    );
    sourceDb
      .prepare(
        "INSERT INTO media_upload_attempts (id, account_id, plot_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("destination-conflict", "owner.testnet", deedMoves[0].to, 1_800_002);
    assert.throws(
      () => verifyDeedWorkflows(data, deedMoves),
      /Destination plot-main-n-1 already has media_upload_attempts records/,
    );
  } finally {
    sourceDb
      .prepare("UPDATE generation_assets SET is_public = 1 WHERE hash = ?")
      .run(paidThumbnailHash);
    sourceDb
      .prepare("DELETE FROM media_upload_attempts WHERE id = ?")
      .run("destination-conflict");
    sourceDb.close();
  }
  await assert.rejects(
    verifyVariableCityBackup(archive, {
      ...frozenInventory,
      ownedPlots: [
        {
          ...frozenInventory.ownedPlots[0],
          logo: { active: { content: { asset_hash: "f".repeat(64) } } },
        },
      ],
    }),
    /Carried logo asset is missing/,
  );
  await assert.rejects(
    verifyVariableCityBackup(archive, {
      ...frozenInventory,
      ownedPlots: [
        {
          ...frozenInventory.ownedPlots[0],
          billboard: {
            active: null,
            pending: { content: { asset_hash: "f".repeat(64) } },
          },
        },
      ],
    }),
    /Carried pending billboard asset is missing/,
  );
  await assert.rejects(
    verifyVariableCityBackup(archive, {
      ...frozenInventory,
      ownedPlots: [
        {
          ...frozenInventory.ownedPlots[0],
          building: {
            ...frozenInventory.ownedPlots[0].building,
            approved_manifest_hash: "f".repeat(64),
          },
        },
      ],
    }),
    /Carried approved facade manifest is missing/,
  );
  await assert.rejects(
    verifyVariableCityBackup(archive, {
      ...frozenInventory,
      finalBlock: { hash: "other-block", height: 11 },
    }),
    /cursor differs from the frozen block/,
  );
  await assert.rejects(
    verifyVariableCityBackup(archive, {
      ...frozenInventory,
      finalBlock: { hash: "future-block", height: 12 },
    }),
    /behind the frozen block/,
  );
  execFileSync(process.execPath, [command, "verify", archive], {
    encoding: "utf8",
  });
  await writeFile(join(archive, "unexpected.txt"), "untracked content");
  const extraFile = spawnSync(process.execPath, [command, "verify", archive], {
    encoding: "utf8",
  });
  assert.notEqual(extraFile.status, 0);
  assert.match(extraFile.stderr, /Unexpected file or directory/);
  await rm(join(archive, "unexpected.txt"));
  const savedAssets = join(root, "saved-archive-assets");
  await rename(join(archive, "assets"), savedAssets);
  await symlink(savedAssets, join(archive, "assets"));
  const linkedAssets = spawnSync(
    process.execPath,
    [command, "verify", archive],
    { encoding: "utf8" },
  );
  assert.notEqual(linkedAssets.status, 0);
  assert.match(linkedAssets.stderr, /Expected a regular directory/);
  await rm(join(archive, "assets"));
  await rename(savedAssets, join(archive, "assets"));
  execFileSync(
    process.execPath,
    [command, "restore", archive, restoredData, restoredMetadata],
    { encoding: "utf8" },
  );

  const restoredApi = new ApiStore(
    join(restoredData, "estate.sqlite"),
    join(restoredData, "assets"),
  );
  assert.equal(restoredApi.upload(upload.id)?.hash, assetHash);
  assert.equal(restoredApi.upload(expiredUpload.id), null);
  assert.equal(
    restoredApi.mediaProposal(expiredProposal.id)?.status,
    "rejected",
  );
  assert.equal(restoredApi.canReadAsset(assetHash, "owner.testnet"), true);
  assert.deepEqual(
    await readFile(join(restoredData, "assets", `${assetHash}.png`)),
    png,
  );
  assert.deepEqual(
    await readFile(join(restoredData, "assets", `${paidThumbnailHash}.png`)),
    paidThumbnail,
  );
  restoredApi.close();
  assert.deepEqual(
    JSON.parse(await readFile(join(restoredMetadata, "testnet.json"), "utf8")),
    deployment,
  );
  const resumed = new EventStore(
    join(restoredData, "estate.sqlite"),
    contractId,
    10,
  );
  assert.deepEqual(resumed.cursor(), {
    height: 11,
    hash: second.hash,
    timestampNs,
  });
  assert.equal(resumed.applyHeight(11, second), 0);
  assert.equal(resumed.applyHeight(12, next), 0);
  assert.equal(
    resumed.db.prepare("SELECT COUNT(*) AS count FROM chain_events").get()
      .count,
    2,
  );
  assert.deepEqual(resumed.cursor(), {
    height: 12,
    hash: next.hash,
    timestampNs,
  });
  resumed.close();

  await writeFile(
    join(archive, "assets", `${assetHash}.png`),
    Buffer.from("tampered"),
  );
  const tampered = spawnSync(process.execPath, [command, "verify", archive], {
    encoding: "utf8",
  });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /hash mismatch/i);

  console.log(
    JSON.stringify({
      result: "passed",
      contractId,
      backupCursorHeight: 11,
      resumedCursorHeight: 12,
      eventsPreserved: 2,
      assetHash,
      deploymentRecordsPreserved: 2,
      missingReferencedAssetRejected: true,
      missingApprovedPaidAssetRejected: true,
      unexpectedArchiveFileRejected: true,
      symlinkedArchiveDirectoryRejected: true,
      tamperRejected: true,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
