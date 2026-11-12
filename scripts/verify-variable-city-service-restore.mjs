#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function regularFile(path) {
  const entry = await lstat(path);
  assert.ok(
    entry.isFile() && !entry.isSymbolicLink(),
    `Expected regular file: ${path}`,
  );
  return readFile(path);
}

async function regularDirectory(path) {
  const entry = await lstat(path);
  assert.ok(
    entry.isDirectory() && !entry.isSymbolicLink(),
    `Expected regular directory: ${path}`,
  );
}

export async function verifyServiceRestore(recordPath, backupDir, dataDir) {
  const recordFile = resolve(recordPath);
  const archive = resolve(backupDir);
  const data = resolve(dataDir);
  assert.ok(
    data !== archive &&
      !data.startsWith(`${archive}${sep}`) &&
      !archive.startsWith(`${data}${sep}`),
    "Service data and backup must be separate directories",
  );
  const record = JSON.parse(await regularFile(recordFile));
  assert.equal(
    record.status,
    "chain_rolled_back_service_pending",
    "Chain rollback must finish before service restore verification",
  );
  assert.equal(
    data,
    resolve(record.serviceDataDir),
    "Service data directory differs from rollback record",
  );
  const preflightBytes = await regularFile(resolve(root, record.preflightFile));
  assert.equal(
    digest(preflightBytes),
    record.preflightSha256,
    "Release preflight changed",
  );
  const report = JSON.parse(preflightBytes);
  assert.equal(
    report.contractId,
    record.contractId,
    "Release contract differs",
  );
  assert.ok(report.backupEvidence, "Release has no pinned service backup");

  const verified = JSON.parse(
    (
      await run(process.execPath, [
        join(root, "scripts/state-backup.mjs"),
        "verify",
        archive,
      ])
    ).stdout,
  );
  assert.equal(verified.operation, "verify");
  assert.equal(verified.contractId, record.contractId);
  const manifestBytes = await regularFile(join(archive, "manifest.json"));
  assert.equal(
    digest(manifestBytes),
    report.backupEvidence.backupManifestSha256,
    "Backup manifest differs from the release packet",
  );
  const manifest = JSON.parse(manifestBytes);
  const sqlite = manifest.files.find((file) => file.path === "estate.sqlite");
  assert.ok(sqlite, "Backup SQLite entry is missing");
  assert.equal(sqlite.sha256, report.backupEvidence.sqliteSha256);
  await regularDirectory(data);
  await regularDirectory(join(data, "assets"));
  assert.deepEqual(
    (await readdir(data)).sort(),
    ["assets", "estate.sqlite"],
    "Restored data directory contains unexpected files",
  );
  const currentSqlite = await regularFile(join(data, "estate.sqlite"));
  assert.equal(
    digest(currentSqlite),
    sqlite.sha256,
    "Service SQLite differs from the backup",
  );

  const assets = manifest.files
    .filter((file) => file.path.startsWith("assets/"))
    .sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(
    (await readdir(join(data, "assets"))).sort(),
    assets.map((file) => basename(file.path)).sort(),
    "Restored asset list differs from the backup",
  );
  for (const asset of assets)
    assert.equal(
      digest(await regularFile(join(data, asset.path))),
      asset.sha256,
      `Restored artwork differs: ${asset.path}`,
    );
  const deployed = manifest.files.find(
    (file) => file.path === "deployments/testnet.json",
  );
  assert.ok(deployed, "Backup deployment entry is missing");
  assert.equal(
    digest(await regularFile(join(root, deployed.path))),
    deployed.sha256,
    "Restored deployment manifest differs from the backup",
  );
  return {
    verified: true,
    contractId: record.contractId,
    sqliteSha256: sqlite.sha256,
    backupManifestSha256: digest(manifestBytes),
    assetsVerified: assets.length,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const [recordPath, backupDir, dataDir] = process.argv.slice(2);
  if (!recordPath || !backupDir || !dataDir) {
    console.error(
      "Usage: verify-variable-city-service-restore.mjs <release-record> <verified-backup-dir> <restored-data-dir>",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(
          await verifyServiceRestore(recordPath, backupDir, dataDir),
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
