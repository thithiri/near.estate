import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attachProviderCostReport, readBetaMetrics } from "./beta-metrics.mjs";

let input = null;
let costsPath = null;
let projectId = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--costs-json") costsPath = args[++i];
  else if (args[i] === "--project-id") projectId = args[++i];
  else if (!input && !args[i].startsWith("--")) input = args[i];
  else throw new Error(`Unknown beta report option: ${args[i]}`);
}
input ??= process.env.ESTATE_DB_PATH ?? null;
if (!input)
  throw new Error(
    "Pass the SQLite path: npm run beta:metrics -- /path/to/estate.sqlite",
  );
if (Boolean(costsPath) !== Boolean(projectId))
  throw new Error("Use --costs-json and --project-id together");
const path = resolve(input);
const db = new DatabaseSync(path, { readOnly: true });
try {
  let report = readBetaMetrics(db);
  if (costsPath) {
    const page = JSON.parse(readFileSync(resolve(costsPath), "utf8"));
    report = attachProviderCostReport(report, page, projectId);
  }
  const deployment = JSON.parse(
    readFileSync(
      new URL("../deployments/testnet.json", import.meta.url),
      "utf8",
    ),
  );
  report.source.matchesDeployedCity =
    report.source.contractId === deployment.contractId;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  db.close();
}
