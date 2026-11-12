import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { baseEncode } from "@near-js/utils";
import { validateCitySeed } from "@estate/shared";
import { verifyVariableCityBackup } from "./variable-city-backup.mjs";
import { validateVariableCityPreflight } from "./variable-city-preflight.mjs";

const root = resolve(import.meta.dirname, "..");
const inventoryPath = process.argv[2];
const outputPath = process.argv[3];
const releaseEvidencePath = process.argv[4];
const backupDir = process.argv[5];
if (
  !inventoryPath?.startsWith("deployments/") ||
  !outputPath?.startsWith("deployments/") ||
  (releaseEvidencePath && !releaseEvidencePath.startsWith("deployments/")) ||
  (backupDir && !releaseEvidencePath)
)
  throw new Error(
    "Pass deployments/<inventory>.json deployments/<output>.json [deployments/<release-evidence>.json <backup-dir>]",
  );
const files = await Promise.all(
  [
    "contracts/estate/seed.json",
    "contracts/estate/seed-v2.json",
    "contracts/estate/migration-v1-to-v2-draft.json",
    "deployments/testnet.json",
    inventoryPath,
  ].map((path) => readFile(resolve(root, path))),
);
const [sourceBytes, targetBytes, planBytes, deploymentBytes, inventoryBytes] =
  files;
const source = validateCitySeed(JSON.parse(sourceBytes.toString("utf8")));
const target = validateCitySeed(JSON.parse(targetBytes.toString("utf8")));
const plan = JSON.parse(planBytes.toString("utf8"));
const deployment = JSON.parse(deploymentBytes.toString("utf8"));
const inventory = JSON.parse(inventoryBytes.toString("utf8"));
const releaseEvidenceBytes = releaseEvidencePath
  ? await readFile(resolve(root, releaseEvidencePath))
  : null;
const releaseEvidence = releaseEvidenceBytes
  ? JSON.parse(releaseEvidenceBytes.toString("utf8"))
  : null;
const measuredBackup = backupDir
  ? await verifyVariableCityBackup(backupDir, inventory, plan.moves)
  : null;
assert.equal(inventory.contractId, deployment.contractId);
assert.equal(
  inventory.codeHash,
  baseEncode(Buffer.from(deployment.wasmSha256, "hex")),
);
const preflight = validateVariableCityPreflight(
  source,
  target,
  inventory,
  plan,
  releaseEvidence ? { ...releaseEvidence, backup: measuredBackup } : null,
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  capturedAt: new Date().toISOString(),
  contractId: deployment.contractId,
  inventoryFile: inventoryPath,
  inventorySha256: hash(inventoryBytes),
  sourceSeedSha256: hash(sourceBytes),
  targetSeedSha256: hash(targetBytes),
  movePlanSha256: hash(planBytes),
  releaseEvidenceFile: releaseEvidencePath ?? null,
  releaseEvidenceSha256: releaseEvidenceBytes
    ? hash(releaseEvidenceBytes)
    : null,
  backupEvidence: measuredBackup,
  ...preflight,
};
await writeFile(
  resolve(root, outputPath),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    output: outputPath,
    sourcePlots: report.sourcePlots,
    targetPlots: report.targetPlots,
    targetCurbSpaces: report.targetCurbSpaces,
    moves: report.moves,
    migrationReady: report.migrationReady,
  }),
);
