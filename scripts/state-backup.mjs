#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const PNG_NAME = /^[0-9a-f]{64}\.png$/;
const DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const BACKUP_FORMAT = 1;

function requireDistinctPaths(paths) {
  const absolute = paths.map((path) => resolve(path));
  for (let left = 0; left < absolute.length; left++) {
    for (let right = left + 1; right < absolute.length; right++) {
      if (
        absolute[left] === absolute[right] ||
        absolute[left].startsWith(`${absolute[right]}${sep}`) ||
        absolute[right].startsWith(`${absolute[left]}${sep}`)
      )
        throw new Error("Source, backup and restore paths must be separate");
    }
  }
}

async function regularFile(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error(`Expected a regular file: ${path}`);
  return entry;
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function snapshotInfo(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok")
      throw new Error("SQLite integrity check failed");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("SQLite foreign-key check failed");
    const hasTable = (name) =>
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(name),
      );
    const cursor = hasTable("indexer_state")
      ? db
          .prepare(
            "SELECT contract_id, start_height, last_height, last_hash, last_timestamp_ns FROM indexer_state WHERE id = 1",
          )
          .get()
      : null;
    if (hasTable("indexer_state") && !cursor)
      throw new Error("Indexer table has no durable cursor");
    const eventCount = hasTable("chain_events")
      ? db.prepare("SELECT COUNT(*) AS count FROM chain_events").get().count
      : 0;
    const requiredAssetHashes = new Set();
    if (hasTable("media_uploads"))
      for (const row of db
        .prepare(
          "SELECT DISTINCT hash FROM media_uploads WHERE status != 'expired'",
        )
        .all())
        requiredAssetHashes.add(row.hash);
    if (hasTable("generation_assets"))
      for (const row of db
        .prepare("SELECT DISTINCT hash FROM generation_assets")
        .all())
        requiredAssetHashes.add(row.hash);
    if (hasTable("paid_generation_candidates"))
      for (const row of db
        .prepare(
          "SELECT sprite_hash, thumbnail_hash FROM paid_generation_candidates WHERE review_status = 'pending'",
        )
        .all()) {
        requiredAssetHashes.add(row.sprite_hash);
        requiredAssetHashes.add(row.thumbnail_hash);
      }
    return {
      cursor: cursor ? { ...cursor } : null,
      eventCount,
      requiredAssetHashes: [...requiredAssetHashes].sort(),
    };
  } finally {
    db.close();
  }
}

async function listedFiles(dir, pattern, ignored = () => false) {
  const entries = await readdir(dir);
  for (const name of entries) {
    if (ignored(name)) continue;
    if (!pattern.test(name))
      throw new Error(`Unexpected file in ${dir}: ${name}`);
    await regularFile(join(dir, name));
  }
  return entries.filter((name) => !ignored(name)).sort();
}

async function recordFile(root, relative) {
  const path = join(root, relative);
  const stat = await regularFile(path);
  return { path: relative, bytes: stat.size, sha256: await sha256(path) };
}

function validateManifest(manifest) {
  if (
    manifest?.format !== BACKUP_FORMAT ||
    !Array.isArray(manifest.files) ||
    typeof manifest.createdAt !== "string" ||
    !Number.isSafeInteger(manifest.eventCount) ||
    manifest.eventCount < 0 ||
    !manifest.deployment ||
    typeof manifest.deployment.contractId !== "string"
  )
    throw new Error("Invalid backup manifest");
  const names = new Set();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !(
        file.path === "estate.sqlite" ||
        /^assets\/[0-9a-f]{64}\.png$/.test(file.path) ||
        /^deployments\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(file.path)
      ) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      names.has(file.path)
    )
      throw new Error("Invalid backup file entry");
    names.add(file.path);
  }
  if (!names.has("estate.sqlite") || !names.has("deployments/testnet.json"))
    throw new Error("Backup is missing SQLite or testnet deployment metadata");
}

async function verifyBackup(backupDir) {
  const manifest = JSON.parse(
    await readFile(join(backupDir, "manifest.json"), "utf8"),
  );
  validateManifest(manifest);
  const actual = ["estate.sqlite"];
  for (const name of await listedFiles(join(backupDir, "assets"), PNG_NAME))
    actual.push(`assets/${name}`);
  for (const name of await listedFiles(
    join(backupDir, "deployments"),
    DEPLOYMENT_NAME,
  ))
    actual.push(`deployments/${name}`);
  const expected = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected))
    throw new Error("Backup file list differs from its manifest");
  for (const file of manifest.files) {
    const measured = await recordFile(backupDir, file.path);
    if (measured.bytes !== file.bytes || measured.sha256 !== file.sha256)
      throw new Error(`Backup hash mismatch: ${file.path}`);
    if (
      file.path.startsWith("assets/") &&
      measured.sha256 !== basename(file.path, ".png")
    )
      throw new Error(`Asset content hash mismatch: ${file.path}`);
  }
  const deployment = JSON.parse(
    await readFile(join(backupDir, "deployments", "testnet.json"), "utf8"),
  );
  if (
    deployment.network !== "testnet" ||
    deployment.contractId !== manifest.deployment.contractId
  )
    throw new Error("Deployment metadata differs from the backup manifest");
  const snapshot = snapshotInfo(join(backupDir, "estate.sqlite"));
  const archivedAssets = new Set(
    actual
      .filter((path) => path.startsWith("assets/"))
      .map((path) => basename(path, ".png")),
  );
  for (const hash of snapshot.requiredAssetHashes)
    if (!archivedAssets.has(hash))
      throw new Error(`Referenced artwork is missing: ${hash}`);
  if (
    JSON.stringify(snapshot.cursor) !== JSON.stringify(manifest.cursor) ||
    snapshot.eventCount !== manifest.eventCount ||
    (snapshot.cursor && snapshot.cursor.contract_id !== deployment.contractId)
  )
    throw new Error("SQLite cursor or event count differs from the manifest");
  return manifest;
}

async function backupState(dataDir, deploymentsDir, backupDir) {
  requireDistinctPaths([dataDir, deploymentsDir, backupDir]);
  await regularFile(join(dataDir, "estate.sqlite"));
  const assets = await listedFiles(join(dataDir, "assets"), PNG_NAME, (name) =>
    /^\.[0-9a-f-]{36}\.tmp$/.test(name),
  );
  const deployments = await listedFiles(
    deploymentsDir,
    DEPLOYMENT_NAME,
    (name) => name === "README.md",
  );
  if (!deployments.includes("testnet.json"))
    throw new Error("testnet.json deployment metadata is required");
  const deployment = JSON.parse(
    await readFile(join(deploymentsDir, "testnet.json"), "utf8"),
  );
  if (deployment.network !== "testnet" || !deployment.contractId)
    throw new Error("Invalid testnet deployment metadata");
  await mkdir(backupDir, { mode: 0o700 });
  try {
    await mkdir(join(backupDir, "assets"));
    await mkdir(join(backupDir, "deployments"));
    const sourceDb = new DatabaseSync(join(dataDir, "estate.sqlite"), {
      readOnly: true,
    });
    try {
      await backup(sourceDb, join(backupDir, "estate.sqlite"));
    } finally {
      sourceDb.close();
    }
    await chmod(join(backupDir, "estate.sqlite"), 0o600);
    const snapshot = snapshotInfo(join(backupDir, "estate.sqlite"));
    const availableAssets = new Set(
      assets.map((name) => basename(name, ".png")),
    );
    for (const hash of snapshot.requiredAssetHashes)
      if (!availableAssets.has(hash))
        throw new Error(`Referenced artwork is missing: ${hash}`);
    if (
      snapshot.cursor &&
      snapshot.cursor.contract_id !== deployment.contractId
    )
      throw new Error("Indexer cursor belongs to another deployed contract");
    const files = [await recordFile(backupDir, "estate.sqlite")];
    for (const name of assets) {
      const relative = `assets/${name}`;
      await copyFile(join(dataDir, relative), join(backupDir, relative));
      await chmod(join(backupDir, relative), 0o600);
      const entry = await recordFile(backupDir, relative);
      if (entry.sha256 !== basename(name, ".png"))
        throw new Error(`Asset content hash mismatch: ${name}`);
      files.push(entry);
    }
    for (const name of deployments) {
      const relative = `deployments/${name}`;
      await copyFile(join(deploymentsDir, name), join(backupDir, relative));
      await chmod(join(backupDir, relative), 0o600);
      JSON.parse(await readFile(join(backupDir, relative), "utf8"));
      files.push(await recordFile(backupDir, relative));
    }
    const manifest = {
      format: BACKUP_FORMAT,
      createdAt: new Date().toISOString(),
      deployment: { contractId: deployment.contractId },
      cursor: snapshot.cursor,
      eventCount: snapshot.eventCount,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    };
    await writeFile(
      join(backupDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await verifyBackup(backupDir);
    return manifest;
  } catch (error) {
    await rm(backupDir, { recursive: true, force: true });
    throw error;
  }
}

async function restoreState(backupDir, dataDir, deploymentsDir) {
  requireDistinctPaths([backupDir, dataDir, deploymentsDir]);
  const manifest = await verifyBackup(backupDir);
  await mkdir(dataDir, { mode: 0o700 });
  try {
    await mkdir(deploymentsDir, { mode: 0o700 });
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  try {
    await mkdir(join(dataDir, "assets"));
    for (const file of manifest.files) {
      const destination = file.path.startsWith("deployments/")
        ? join(deploymentsDir, basename(file.path))
        : join(dataDir, file.path);
      await copyFile(join(backupDir, file.path), destination);
      await chmod(destination, 0o600);
      const copied = await recordFile(
        file.path.startsWith("deployments/") ? deploymentsDir : dataDir,
        file.path.startsWith("deployments/") ? basename(file.path) : file.path,
      );
      if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256)
        throw new Error(`Restored file differs from backup: ${file.path}`);
    }
    const restored = snapshotInfo(join(dataDir, "estate.sqlite"));
    if (
      JSON.stringify(restored.cursor) !== JSON.stringify(manifest.cursor) ||
      restored.eventCount !== manifest.eventCount
    )
      throw new Error("Restored cursor or events differ from backup");
    return manifest;
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    await rm(deploymentsDir, { recursive: true, force: true });
    throw error;
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  let manifest;
  if (command === "backup" && args.length === 3)
    manifest = await backupState(...args);
  else if (command === "verify" && args.length === 1)
    manifest = await verifyBackup(args[0]);
  else if (command === "restore" && args.length === 3)
    manifest = await restoreState(...args);
  else
    throw new Error(
      "Usage: state-backup.mjs backup <data-dir> <deployments-dir> <new-backup-dir> | verify <backup-dir> | restore <backup-dir> <new-data-dir> <new-deployments-dir>",
    );
  console.log(
    JSON.stringify({
      operation: command,
      files: manifest.files.length,
      eventCount: manifest.eventCount,
      cursor: manifest.cursor,
      contractId: manifest.deployment.contractId,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
