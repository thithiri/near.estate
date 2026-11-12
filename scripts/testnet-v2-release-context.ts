import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readActiveVersion2Release(
  root: string,
  recordPath: string,
  deployment: Deployment,
): { path: string; record: ReleaseRecord; moves: MovePlan["moves"] } {
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
  assert.equal(
    record.afterWasmSha256,
    deployment.wasmSha256,
    "Release code differs from deployment manifest",
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
  return { path, record, moves: map.moves };
}
