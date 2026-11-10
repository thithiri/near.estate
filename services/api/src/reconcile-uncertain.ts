import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readImageGenerationSettings } from "./image-generation-settings.js";
import { PaidGenerationLedger } from "./paid-generation-ledger.js";

type Outcome = "confirmed_not_received" | "confirmed_charged";

type HeldAttempt = {
  job_id: string;
  client_request_id: string;
  provider_request_id: string | null;
  status: string;
  attempt_no: number;
};

type HeldJob = {
  id: string;
  status: string;
  charged_calls: number;
  charged_usd_micros: number;
  cost_ceiling_usd_micros: number;
};

function usage(): never {
  throw new Error(
    "Usage: --plan <data-dir> <job-id> <client-request-id> | --apply <data-dir> <job-id> <client-request-id> <confirmed_not_received|confirmed_charged> <provider-evidence-note>",
  );
}

export function reconcileUncertainCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  now = Math.floor(Date.now() / 1_000),
): Record<string, string | number | null> {
  const [mode, dataDir, jobId, clientRequestId, outcome, ...noteParts] = args;
  if (
    !["--plan", "--apply"].includes(mode ?? "") ||
    !dataDir ||
    !jobId ||
    !clientRequestId ||
    (mode === "--plan" && args.length !== 4) ||
    (mode === "--apply" && args.length < 6)
  )
    usage();
  if (
    mode === "--apply" &&
    outcome !== "confirmed_not_received" &&
    outcome !== "confirmed_charged"
  )
    usage();
  const databasePath = join(resolve(dataDir), "estate.sqlite");
  const file = lstatSync(databasePath);
  if (!file.isFile() || file.isSymbolicLink())
    throw new Error("Expected an existing regular SQLite database");
  const db = new DatabaseSync(databasePath, { readOnly: mode === "--plan" });
  try {
    const job = db
      .prepare(
        `SELECT id, status, charged_calls, charged_usd_micros, cost_ceiling_usd_micros
         FROM paid_generation_jobs WHERE id = ?`,
      )
      .get(jobId) as HeldJob | undefined;
    const attempt = db
      .prepare(
        `SELECT job_id, client_request_id, provider_request_id, status, attempt_no
         FROM paid_generation_attempts
         WHERE job_id = ? AND client_request_id = ?`,
      )
      .get(jobId, clientRequestId) as HeldAttempt | undefined;
    if (!job || job.status !== "uncertain" || attempt?.status !== "uncertain")
      throw new Error("Job has no matching uncertain attempt");
    if (mode === "--plan")
      return {
        mode: "plan",
        jobId: job.id,
        clientRequestId: attempt.client_request_id,
        providerRequestId: attempt.provider_request_id,
        attemptNo: attempt.attempt_no,
        chargedCalls: job.charged_calls,
        chargedUsdMicros: job.charged_usd_micros,
        costCeilingUsdMicros: job.cost_ceiling_usd_micros,
      };
    const note = noteParts.join(" ").trim();
    if (note.length < 4 || note.length > 500)
      throw new Error("Provider-evidence note must contain 4–500 characters");
    if (env.ESTATE_RECONCILE_OFFLINE !== "true")
      throw new Error(
        "Stop the API and set ESTATE_RECONCILE_OFFLINE=true before applying",
      );
    const settings = readImageGenerationSettings(env);
    if (!settings.enabled)
      throw new Error("Original paid generation settings are required");
    const updated = new PaidGenerationLedger(db, settings).resolveUncertain({
      jobId,
      clientRequestId,
      outcome: outcome as Outcome,
      note,
      now,
    });
    return {
      mode: "applied",
      jobId: updated.id,
      clientRequestId,
      outcome: outcome as Outcome,
      jobStatus: updated.status,
      chargedCalls: updated.chargedCalls,
      chargedUsdMicros: updated.chargedUsdMicros,
    };
  } finally {
    db.close();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    console.log(
      JSON.stringify(
        reconcileUncertainCommand(process.argv.slice(2), process.env),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
