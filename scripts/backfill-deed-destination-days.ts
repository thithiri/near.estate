import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backfillDeedDestinationDays } from "../services/api/src/deed-history.js";
import { readPlotStats } from "../services/api/src/plot-stats.js";
import { readActiveVersion2Release } from "./testnet-v2-release-context.js";

const root = resolve(import.meta.dirname, "..");
const [recordArg, liveArg, frozenArg] = process.argv.slice(2);
if (!recordArg || !liveArg || !frozenArg)
  throw new Error(
    "Pass absolute release record, live SQLite and frozen SQLite paths",
  );
const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
) as { contractId: string; wasmSha256: string; citySeedVersion: number };
const release = readActiveVersion2Release(root, recordArg, deployment);
const record = JSON.parse(readFileSync(release.path, "utf8")) as {
  cutoverAtMs: number;
  frozenBlock: { height: number };
  serviceDbPath: string;
};
const livePath = realpathSync(liveArg);
const frozenPath = realpathSync(frozenArg);
const recordedDbPath = record.serviceDbPath.startsWith("~/")
  ? resolve(homedir(), record.serviceDbPath.slice(2))
  : record.serviceDbPath;
assert.equal(livePath, realpathSync(recordedDbPath));
assert(!livePath.startsWith(`${root}/`) && !frozenPath.startsWith(`${root}/`));
assert.notEqual(livePath, frozenPath);
const backup = JSON.parse(
  readFileSync(
    resolve(root, "deployments/variable-city-backup-evidence-2026-11-12.json"),
    "utf8",
  ),
) as { sqliteSha256: string; verifiedRestore: boolean };
assert.equal(backup.verifiedRestore, true);
const frozenSha256 = createHash("sha256")
  .update(readFileSync(frozenPath))
  .digest("hex");
assert.equal(
  frozenSha256,
  backup.sqliteSha256,
  "Frozen SQLite differs from the verified backup",
);

const live = new DatabaseSync(livePath);
const frozen = new DatabaseSync(frozenPath, { readOnly: true });
try {
  assert.equal(
    (live.prepare("PRAGMA integrity_check").get() as Record<string, string>)
      .integrity_check,
    "ok",
  );
  assert.equal(
    (frozen.prepare("PRAGMA integrity_check").get() as Record<string, string>)
      .integrity_check,
    "ok",
  );
  const days = backfillDeedDestinationDays(
    live,
    frozen,
    deployment.contractId,
    release.moves,
    record.frozenBlock.height,
    record.cutoverAtMs,
  );
  const now = Math.floor(Date.now() / 1_000);
  const plots = release.moves.map((move) => {
    const stats = readPlotStats(live, move.to, now);
    assert.equal(stats.linkedHistory?.sourcePlotId, move.from);
    return {
      from: move.from,
      to: move.to,
      currentTotals: stats.totals,
      linkedTotals: stats.linkedHistory.totals,
    };
  });
  const evidence = {
    contractId: deployment.contractId,
    cutoverHeight: record.frozenBlock.height,
    cutoverAtMs: record.cutoverAtMs,
    frozenSqliteSha256: frozenSha256,
    destinationBaselineDays: days,
    plots,
    verifiedAt: new Date().toISOString(),
  };
  writeFileSync(
    resolve(root, "deployments/testnet-v2-deed-destination-baseline.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  frozen.close();
  live.close();
}
