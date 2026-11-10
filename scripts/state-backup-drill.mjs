#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ApiStore } from "../services/api/dist/store.js";
import { EventStore } from "../services/worker/dist/event-store.js";

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
  assert.equal(backup.files, 4);
  execFileSync(process.execPath, [command, "verify", archive], {
    encoding: "utf8",
  });
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
      tamperRejected: true,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
