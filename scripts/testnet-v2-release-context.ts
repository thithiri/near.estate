import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

type Deployment = {
  contractId: string;
  wasmSha256: string;
  citySeedVersion: number;
};

type ReleaseRecord = {
  contractId: string;
  status: string;
  reopenedAtMs: number;
  preflightFile: string;
  preflightSha256: string;
  afterWasmSha256: string;
};

type MovePlan = {
  status: string;
  moves: Array<{ from: string; to: string }>;
};

type RuntimeUpgrade = {
  contractId: string;
  status: string;
  beforeWasmSha256: string;
  afterWasmSha256: string;
  finalCodeSha256: string;
  pauseTransactionHash: string;
  deployTransactionHash: string;
  reopenTransactionHash: string;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function codeOnlyUpgradePath(
  root: string,
  contractId: string,
  releaseCode: string,
  deployedCode: string,
): string[] {
  if (releaseCode === deployedCode) return [];
  const directory = resolve(root, "deployments");
  const upgrades = readdirSync(directory)
    .filter((name) => /^runtime-upgrade-live-[0-9a-f]{16}\.json$/.test(name))
    .map((name) => {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      assert(
        stat.isFile() && !stat.isSymbolicLink(),
        "Upgrade record must be a regular file",
      );
      const record = JSON.parse(readFileSync(path, "utf8")) as RuntimeUpgrade;
      return { path, name, record };
    })
    .filter(
      ({ name, record }) =>
        record.contractId === contractId &&
        record.status === "verified" &&
        /^[0-9a-f]{64}$/.test(record.beforeWasmSha256) &&
        /^[0-9a-f]{64}$/.test(record.afterWasmSha256) &&
        name ===
          `runtime-upgrade-live-${record.afterWasmSha256.slice(0, 16)}.json` &&
        record.finalCodeSha256 === record.afterWasmSha256 &&
        [
          record.pauseTransactionHash,
          record.deployTransactionHash,
          record.reopenTransactionHash,
        ].every((hash) => typeof hash === "string" && hash.length > 0),
    );
  const paths = [{ code: releaseCode, records: [] as string[] }];
  const seen = new Set([releaseCode]);
  for (let index = 0; index < paths.length; index++) {
    const current = paths[index];
    for (const upgrade of upgrades.filter(
      ({ record }) => record.beforeWasmSha256 === current.code,
    )) {
      const next = upgrade.record.afterWasmSha256;
      if (seen.has(next)) continue;
      const records = [...current.records, upgrade.path];
      if (next === deployedCode) return records;
      seen.add(next);
      paths.push({ code: next, records });
    }
  }
  assert.fail(
    "No verified code-only upgrade links release code to deployment manifest",
  );
}

export function readActiveVersion2Release(
  root: string,
  recordPath: string,
  deployment: Deployment,
): {
  path: string;
  record: ReleaseRecord;
  moves: MovePlan["moves"];
  runtimeUpgrades: string[];
} {
  assert(
    recordPath.startsWith("/"),
    "Pass an absolute version-2 release-record path",
  );
  const path = realpathSync(recordPath);
  const record = JSON.parse(readFileSync(path, "utf8")) as ReleaseRecord;
  assert.equal(
    record.contractId,
    deployment.contractId,
    "Release contract differs from deployment",
  );
  assert.equal(record.status, "active", "Version-2 release is not active");
  assert(
    Number.isSafeInteger(record.reopenedAtMs) && record.reopenedAtMs > 0,
    "Release has no valid reopen time",
  );
  assert.equal(
    deployment.citySeedVersion,
    2,
    "Deployment manifest is not version 2",
  );
  const runtimeUpgrades = codeOnlyUpgradePath(
    root,
    deployment.contractId,
    record.afterWasmSha256,
    deployment.wasmSha256,
  );

  const preflightPath = resolve(root, record.preflightFile);
  assert(
    preflightPath.startsWith(`${root}/deployments/`),
    "Release preflight must be in deployments",
  );
  const preflightBytes = readFileSync(preflightPath);
  assert.equal(
    sha256(preflightBytes),
    record.preflightSha256,
    "Release preflight changed",
  );
  const preflight = JSON.parse(preflightBytes.toString("utf8")) as {
    contractId: string;
    migrationReady: boolean;
    movePlanSha256: string;
    targetSeedSha256: string;
  };
  assert.equal(
    preflight.contractId,
    deployment.contractId,
    "Preflight contract differs from deployment",
  );
  assert.equal(
    preflight.migrationReady,
    true,
    "Release preflight was not ready",
  );
  const seedBytes = readFileSync(
    resolve(root, "contracts/estate/seed-v2.json"),
  );
  assert.equal(
    sha256(seedBytes),
    preflight.targetSeedSha256,
    "Version-2 seed changed after release",
  );
  const mapBytes = readFileSync(
    resolve(root, "contracts/estate/migration-v1-to-v2-draft.json"),
  );
  assert.equal(
    sha256(mapBytes),
    preflight.movePlanSha256,
    "Reviewed deed map changed after release",
  );
  const map = JSON.parse(mapBytes.toString("utf8")) as MovePlan;
  assert.equal(map.status, "reviewed", "Deed map has not been reviewed");
  assert(
    Array.isArray(map.moves) && map.moves.length > 0,
    "Reviewed deed map is empty",
  );
  assert.equal(
    new Set(map.moves.map((move) => move.from)).size,
    map.moves.length,
    "Duplicate source deed",
  );
  assert.equal(
    new Set(map.moves.map((move) => move.to)).size,
    map.moves.length,
    "Duplicate deed destination",
  );
  return { path, record, moves: map.moves, runtimeUpgrades };
}

/** Repository-relative form of a local path, so public evidence never records a home directory. */
export function repoRelativePath(root: string, path: string): string {
  return relative(realpathSync(root), realpathSync(path));
}
