import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { verifyServiceRestore } from "./verify-variable-city-service-restore.mjs";

const root = resolve(import.meta.dirname, "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("manual rollback completes only after exact service backup restoration", async () => {
  const temporary = await mkdtemp(
    join(tmpdir(), "estate-city-service-rollback-"),
  );
  try {
    const data = join(temporary, "source-data");
    const metadata = join(temporary, "source-deployments");
    const archive = join(temporary, "archive");
    const restoredData = join(temporary, "restored-data");
    const restoredMetadata = join(temporary, "restored-deployments");
    await mkdir(join(data, "assets"), { recursive: true });
    const artwork = Buffer.from("restored-artwork");
    const artworkName = `${hash(artwork)}.png`;
    await writeFile(join(data, "assets", artworkName), artwork);
    await mkdir(metadata);
    await copyFile(
      join(root, "deployments/testnet.json"),
      join(metadata, "testnet.json"),
    );
    const database = new DatabaseSync(join(data, "estate.sqlite"));
    database.exec(
      "CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('frozen')",
    );
    database.close();
    execFileSync(process.execPath, [
      join(root, "scripts/state-backup.mjs"),
      "backup",
      data,
      metadata,
      archive,
    ]);
    execFileSync(process.execPath, [
      join(root, "scripts/state-backup.mjs"),
      "restore",
      archive,
      restoredData,
      restoredMetadata,
    ]);
    const manifestBytes = await readFile(join(archive, "manifest.json"));
    const manifest = JSON.parse(manifestBytes);
    const deployment = JSON.parse(
      await readFile(join(root, "deployments/testnet.json"), "utf8"),
    );
    const reportPath = join(temporary, "preflight.json");
    const reportBytes = Buffer.from(
      JSON.stringify({
        contractId: deployment.contractId,
        backupEvidence: {
          backupManifestSha256: hash(manifestBytes),
          sqliteSha256: manifest.files.find(
            (file) => file.path === "estate.sqlite",
          ).sha256,
        },
      }),
    );
    await writeFile(reportPath, reportBytes);
    const recordPath = join(temporary, "release-record.json");
    await writeFile(
      recordPath,
      JSON.stringify({
        status: "chain_rolled_back_service_pending",
        contractId: deployment.contractId,
        serviceDataDir: restoredData,
        preflightFile: reportPath,
        preflightSha256: hash(reportBytes),
      }),
    );
    const verified = await verifyServiceRestore(
      recordPath,
      archive,
      restoredData,
    );
    assert.equal(verified.verified, true);
    assert.equal(verified.assetsVerified, 1);
    await assert.rejects(
      verifyServiceRestore(recordPath, archive, data),
      /Service data directory differs from rollback record/,
    );
    await appendFile(join(restoredData, "assets", artworkName), "changed");
    await assert.rejects(
      verifyServiceRestore(recordPath, archive, restoredData),
      /Restored artwork differs/,
    );
    await copyFile(
      join(archive, "assets", artworkName),
      join(restoredData, "assets", artworkName),
    );
    await appendFile(join(restoredData, "estate.sqlite"), "changed");
    await assert.rejects(
      verifyServiceRestore(recordPath, archive, restoredData),
      /Service SQLite differs from the backup/,
    );
    await copyFile(
      join(archive, "estate.sqlite"),
      join(restoredData, "estate.sqlite"),
    );
    await writeFile(join(restoredData, "estate.sqlite-wal"), "stale");
    await assert.rejects(
      verifyServiceRestore(recordPath, archive, restoredData),
      /Restored data directory contains unexpected files/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
