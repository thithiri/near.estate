import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  validateAssetManifest,
  type AssetManifest,
} from "@estate/shared";
import type { ImageGenerationSettings } from "./image-generation-settings.js";
import type { ImageTokenUsage } from "./image-provider.js";
import type { GenerationPromptSpec } from "./prompt-builder.js";

type EnabledSettings = Extract<ImageGenerationSettings, { enabled: true }>;
export type PaidJobStatus =
  | "queued"
  | "leased"
  | "uncertain"
  | "complete"
  | "failed"
  | "cancelled"
  | "superseded";

export type PaidJob = {
  id: string;
  accountId: string;
  plotId: string;
  requestHash: string;
  snapshot: PaidGenerationSnapshot | null;
  utcDay: number;
  status: PaidJobStatus;
  reservedCalls: number;
  chargedCalls: number;
  reservedUsdMicros: number;
  chargedUsdMicros: number;
  costCeilingUsdMicros: number;
  attemptsStarted: number;
  acceptedCount: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  stopReason: "cancelled" | "superseded" | null;
  createdAt: number;
};

export type PaidGenerationSnapshot = {
  buildingType: GenerationPromptSpec["buildingType"];
  level: GenerationPromptSpec["level"];
  layoutRevision: number;
  appearanceRevision: number | null;
  approvedManifestHashAtRequest?: string | null;
  usePriorArt?: boolean;
  promptSpec: GenerationPromptSpec;
};

export type PaidCandidate = {
  jobId: string;
  attemptId: string;
  ordinal: number;
  manifest: AssetManifest;
  manifestHash: string;
  spriteHash: string;
  thumbnailHash: string;
  reviewStatus: "pending" | "approved" | "rejected";
  reviewReason: string | null;
  reviewedAt: number | null;
  reviewedBy: string | null;
  createdAt: number;
};

export type PaidCandidateInput = Pick<
  PaidCandidate,
  "manifest" | "manifestHash" | "spriteHash" | "thumbnailHash"
>;

export type PaidAttempt = {
  id: string;
  jobId: string;
  attemptNo: number;
  clientRequestId: string;
  providerRequestId: string | null;
  status:
    | "started"
    | "accepted"
    | "rejected"
    | "uncertain"
    | "confirmed_not_received"
    | "confirmed_charged";
  assetHash: string | null;
  usage: ImageTokenUsage | null;
  resolutionNote: string | null;
  startedAt: number;
  finishedAt: number | null;
};

export class PaidJobLimitError extends Error {
  constructor(
    readonly code:
      | "INVITE_REQUIRED"
      | "QUOTA"
      | "BUDGET"
      | "ACTIVE_JOB"
      | "IDEMPOTENCY_CONFLICT",
  ) {
    super(code);
  }
}

type JobRow = {
  id: string;
  account_id: string;
  plot_id: string;
  request_hash: string;
  snapshot_json: string | null;
  utc_day: number;
  status: PaidJobStatus;
  reserved_calls: number;
  charged_calls: number;
  reserved_usd_micros: number;
  charged_usd_micros: number;
  cost_ceiling_usd_micros: number;
  attempts_started: number;
  accepted_count: number;
  lease_owner: string | null;
  lease_until: number | null;
  stop_reason: "cancelled" | "superseded" | null;
  created_at: number;
};

type AttemptRow = {
  id: string;
  job_id: string;
  attempt_no: number;
  client_request_id: string;
  provider_request_id: string | null;
  status: PaidAttempt["status"];
  asset_hash: string | null;
  usage_json: string | null;
  resolution_note: string | null;
  started_at: number;
  finished_at: number | null;
};

type CandidateRow = {
  job_id: string;
  attempt_id: string;
  ordinal: number;
  manifest_json: string;
  manifest_hash: string;
  sprite_hash: string;
  thumbnail_hash: string;
  review_status: PaidCandidate["reviewStatus"];
  review_reason: string | null;
  reviewed_at: number | null;
  reviewed_by: string | null;
  created_at: number;
};

function jobFromRow(row: JobRow): PaidJob {
  return {
    id: row.id,
    accountId: row.account_id,
    plotId: row.plot_id,
    requestHash: row.request_hash,
    snapshot: row.snapshot_json
      ? (JSON.parse(row.snapshot_json) as PaidGenerationSnapshot)
      : null,
    utcDay: row.utc_day,
    status: row.status,
    reservedCalls: row.reserved_calls,
    chargedCalls: row.charged_calls,
    reservedUsdMicros: row.reserved_usd_micros,
    chargedUsdMicros: row.charged_usd_micros,
    costCeilingUsdMicros: row.cost_ceiling_usd_micros,
    attemptsStarted: row.attempts_started,
    acceptedCount: row.accepted_count,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    stopReason: row.stop_reason,
    createdAt: row.created_at,
  };
}

function attemptFromRow(row: AttemptRow): PaidAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    attemptNo: row.attempt_no,
    clientRequestId: row.client_request_id,
    providerRequestId: row.provider_request_id,
    status: row.status,
    assetHash: row.asset_hash,
    usage: row.usage_json
      ? (JSON.parse(row.usage_json) as ImageTokenUsage)
      : null,
    resolutionNote: row.resolution_note,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function candidateFromRow(row: CandidateRow): PaidCandidate {
  return {
    jobId: row.job_id,
    attemptId: row.attempt_id,
    ordinal: row.ordinal,
    manifest: JSON.parse(row.manifest_json) as AssetManifest,
    manifestHash: row.manifest_hash,
    spriteHash: row.sprite_hash,
    thumbnailHash: row.thumbnail_hash,
    reviewStatus: row.review_status,
    reviewReason: row.review_reason,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
  };
}

export class PaidGenerationLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly settings: EnabledSettings,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS paid_generation_days (
        utc_day INTEGER PRIMARY KEY,
        reserved_calls INTEGER NOT NULL DEFAULT 0 CHECK (reserved_calls >= 0),
        charged_calls INTEGER NOT NULL DEFAULT 0 CHECK (charged_calls >= 0),
        reserved_usd_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_usd_micros >= 0),
        charged_usd_micros INTEGER NOT NULL DEFAULT 0 CHECK (charged_usd_micros >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS paid_generation_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        plot_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        snapshot_json TEXT,
        utc_day INTEGER NOT NULL REFERENCES paid_generation_days(utc_day),
        status TEXT NOT NULL CHECK (status IN
          ('queued', 'leased', 'uncertain', 'complete', 'failed', 'cancelled', 'superseded')),
        reserved_calls INTEGER NOT NULL CHECK (reserved_calls >= 0),
        charged_calls INTEGER NOT NULL DEFAULT 0 CHECK (charged_calls >= 0),
        reserved_usd_micros INTEGER NOT NULL CHECK (reserved_usd_micros >= 0),
        charged_usd_micros INTEGER NOT NULL DEFAULT 0 CHECK (charged_usd_micros >= 0),
        cost_ceiling_usd_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_ceiling_usd_micros >= 0),
        attempts_started INTEGER NOT NULL DEFAULT 0 CHECK (attempts_started >= 0),
        accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
        lease_owner TEXT,
        lease_until INTEGER,
        stop_reason TEXT CHECK (stop_reason IN ('cancelled', 'superseded')),
        created_at INTEGER NOT NULL,
        UNIQUE(account_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS paid_jobs_account_day
        ON paid_generation_jobs(account_id, utc_day);
      CREATE INDEX IF NOT EXISTS paid_jobs_plot_day
        ON paid_generation_jobs(plot_id, utc_day);
      CREATE INDEX IF NOT EXISTS paid_jobs_status
        ON paid_generation_jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS paid_generation_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES paid_generation_jobs(id),
        attempt_no INTEGER NOT NULL,
        client_request_id TEXT NOT NULL UNIQUE,
        provider_request_id TEXT,
        status TEXT NOT NULL CHECK (status IN
          ('started', 'accepted', 'rejected', 'uncertain', 'confirmed_not_received', 'confirmed_charged')),
        asset_hash TEXT,
        usage_json TEXT,
        resolution_note TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE(job_id, attempt_no)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS paid_attempt_job_status
        ON paid_generation_attempts(job_id, status);
      CREATE TABLE IF NOT EXISTS paid_generation_candidates (
        attempt_id TEXT PRIMARY KEY REFERENCES paid_generation_attempts(id),
        job_id TEXT NOT NULL REFERENCES paid_generation_jobs(id),
        ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
        manifest_json TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        sprite_hash TEXT NOT NULL,
        thumbnail_hash TEXT NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
        review_reason TEXT,
        reviewed_at INTEGER,
        reviewed_by TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(job_id, ordinal),
        UNIQUE(job_id, manifest_hash)
      ) STRICT;
    `);
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(paid_generation_jobs)").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    for (const [name, declaration] of [
      ["attempts_started", "INTEGER NOT NULL DEFAULT 0"],
      ["snapshot_json", "TEXT"],
      ["cost_ceiling_usd_micros", "INTEGER NOT NULL DEFAULT 0"],
      ["accepted_count", "INTEGER NOT NULL DEFAULT 0"],
      ["lease_owner", "TEXT"],
      ["lease_until", "INTEGER"],
      ["stop_reason", "TEXT"],
    ] as const) {
      if (!columns.has(name))
        this.db.exec(
          `ALTER TABLE paid_generation_jobs ADD COLUMN ${name} ${declaration}`,
        );
    }
    const attemptColumns = new Set(
      (
        this.db
          .prepare("PRAGMA table_info(paid_generation_attempts)")
          .all() as { name: string }[]
      ).map((column) => column.name),
    );
    if (!attemptColumns.has("usage_json"))
      this.db.exec(
        "ALTER TABLE paid_generation_attempts ADD COLUMN usage_json TEXT",
      );
    const candidateColumns = new Set(
      (
        this.db
          .prepare("PRAGMA table_info(paid_generation_candidates)")
          .all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    for (const [name, declaration] of [
      ["review_status", "TEXT NOT NULL DEFAULT 'pending'"],
      ["review_reason", "TEXT"],
      ["reviewed_at", "INTEGER"],
      ["reviewed_by", "TEXT"],
    ] as const) {
      if (!candidateColumns.has(name))
        this.db.exec(
          `ALTER TABLE paid_generation_candidates ADD COLUMN ${name} ${declaration}`,
        );
    }
    this.db.exec(`
      UPDATE paid_generation_jobs
      SET cost_ceiling_usd_micros =
        (reserved_usd_micros + charged_usd_micros) / 4
      WHERE cost_ceiling_usd_micros = 0
        AND reserved_usd_micros + charged_usd_micros > 0;
    `);
    // Earlier staging builds could reserve budget without a durable prompt.
    // They never exposed a paid route, so cancel those unexecutable rows.
    const incomplete = this.db
      .prepare(
        "SELECT * FROM paid_generation_jobs WHERE snapshot_json IS NULL AND status = 'queued'",
      )
      .all() as JobRow[];
    for (const row of incomplete)
      this.transaction(() =>
        this.releaseRemaining(jobFromRow(row), "cancelled"),
      );
  }

  job(id: string): PaidJob | null {
    const row = this.db
      .prepare("SELECT * FROM paid_generation_jobs WHERE id = ?")
      .get(id) as JobRow | undefined;
    return row ? jobFromRow(row) : null;
  }

  latest(accountId: string, plotId: string): PaidJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM paid_generation_jobs
         WHERE account_id = ? AND plot_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(accountId, plotId) as JobRow | undefined;
    return row ? jobFromRow(row) : null;
  }

  byIdempotencyKey(accountId: string, key: string): PaidJob | null {
    const row = this.db
      .prepare(
        "SELECT * FROM paid_generation_jobs WHERE account_id = ? AND idempotency_key = ?",
      )
      .get(accountId, key) as JobRow | undefined;
    return row ? jobFromRow(row) : null;
  }

  canReadCandidateAsset(assetHash: string, accountId: string | null): boolean {
    if (!accountId) return false;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM paid_generation_candidates AS candidate
           JOIN paid_generation_jobs AS job ON job.id = candidate.job_id
           WHERE job.account_id = ?
             AND candidate.review_status = 'approved'
             AND (candidate.sprite_hash = ? OR candidate.thumbnail_hash = ?)
             AND (
               NOT EXISTS (SELECT 1 FROM generation_jobs AS design WHERE design.id = job.id)
               OR EXISTS (
                 SELECT 1 FROM generation_assets AS asset
                 WHERE asset.job_id = job.id AND asset.hash = ?
               )
             )
           LIMIT 1`,
        )
        .get(accountId, assetHash, assetHash, assetHash),
    );
  }

  attempts(jobId: string): PaidAttempt[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM paid_generation_attempts WHERE job_id = ? ORDER BY attempt_no",
        )
        .all(jobId) as AttemptRow[]
    ).map(attemptFromRow);
  }

  candidates(jobId: string): PaidCandidate[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM paid_generation_candidates WHERE job_id = ? ORDER BY ordinal",
        )
        .all(jobId) as CandidateRow[]
    ).map(candidateFromRow);
  }

  pendingCandidateReviews(limit: number): {
    job: PaidJob;
    candidate: PaidCandidate;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT candidate.* FROM paid_generation_candidates AS candidate
         JOIN paid_generation_jobs AS job ON job.id = candidate.job_id
         WHERE candidate.review_status = 'pending' AND job.status = 'complete'
         ORDER BY candidate.created_at, candidate.rowid LIMIT ?`,
      )
      .all(limit) as CandidateRow[];
    return rows.flatMap((row) => {
      const job = this.job(row.job_id);
      return job ? [{ job, candidate: candidateFromRow(row) }] : [];
    });
  }

  reviewCandidate(input: {
    jobId: string;
    ordinal: number;
    decision: "approved" | "rejected";
    reason: string | null;
    now: number;
    reviewer: string;
    suppressBillboard?: boolean;
    logoRectOverride?: NonNullable<AssetManifest["logoRect"]>;
  }): PaidCandidate {
    if (
      !Number.isSafeInteger(input.now) ||
      input.now < 0 ||
      !Number.isInteger(input.ordinal) ||
      input.ordinal < 1 ||
      input.ordinal > 3 ||
      (input.decision !== "approved" && input.decision !== "rejected") ||
      input.reviewer.trim().length < 1 ||
      input.reviewer.length > 100 ||
      (input.suppressBillboard === true && input.decision !== "approved") ||
      (input.decision === "rejected" &&
        (!input.reason?.trim() || Array.from(input.reason).length > 500))
    )
      throw new Error("Invalid candidate review");
    this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM paid_generation_candidates
           WHERE job_id = ? AND ordinal = ? AND review_status = 'pending'`,
        )
        .get(input.jobId, input.ordinal) as CandidateRow | undefined;
      if (!row) throw new Error("Candidate is not awaiting review");
      const originalManifest = validateAssetManifest(
        JSON.parse(row.manifest_json),
      );
      if (
        originalManifest.spriteHash !== row.sprite_hash ||
        originalManifest.thumbnailHash !== row.thumbnail_hash ||
        createHash("sha256")
          .update(canonicalJson(originalManifest))
          .digest("hex") !== row.manifest_hash
      )
        throw new Error("Candidate manifest fingerprint is invalid");
      if (input.suppressBillboard && !originalManifest.billboardRect)
        throw new Error("Candidate has no billboard to remove");
      const proposedLogo = input.logoRectOverride;
      if (
        proposedLogo &&
        (input.decision !== "approved" ||
          !originalManifest.logoRect ||
          proposedLogo.width !== originalManifest.logoRect.width ||
          proposedLogo.height !== originalManifest.logoRect.height ||
          !Number.isInteger(proposedLogo.x) ||
          !Number.isInteger(proposedLogo.y))
      )
        throw new Error("Invalid candidate logo adjustment");
      const manifest = validateAssetManifest({
        ...originalManifest,
        logoRect: proposedLogo ?? originalManifest.logoRect,
        billboardRect: input.suppressBillboard
          ? null
          : originalManifest.billboardRect,
      });
      if (
        manifest.logoRect &&
        manifest.billboardRect &&
        manifest.logoRect.x <
          manifest.billboardRect.x + manifest.billboardRect.width &&
        manifest.logoRect.x + manifest.logoRect.width >
          manifest.billboardRect.x &&
        manifest.logoRect.y <
          manifest.billboardRect.y + manifest.billboardRect.height &&
        manifest.logoRect.y + manifest.logoRect.height >
          manifest.billboardRect.y
      )
        throw new Error("Candidate media placements overlap");
      const manifestJson = canonicalJson(manifest);
      const manifestHash = createHash("sha256")
        .update(manifestJson)
        .digest("hex");
      const changed = this.db
        .prepare(
          `UPDATE paid_generation_candidates SET review_status = ?,
             review_reason = ?, reviewed_at = ?, reviewed_by = ?,
             manifest_json = ?, manifest_hash = ?
           WHERE job_id = ? AND ordinal = ? AND review_status = 'pending'
             AND EXISTS (SELECT 1 FROM paid_generation_jobs
                         WHERE id = ? AND status = 'complete')`,
        )
        .run(
          input.decision,
          input.decision === "rejected" ? input.reason!.trim() : null,
          input.now,
          input.reviewer.trim(),
          manifestJson,
          manifestHash,
          input.jobId,
          input.ordinal,
          input.jobId,
        ).changes;
      if (changed !== 1) throw new Error("Candidate is not awaiting review");
    });
    const candidate = this.candidates(input.jobId).find(
      (item) => item.ordinal === input.ordinal,
    );
    if (!candidate) throw new Error("Reviewed candidate disappeared");
    return candidate;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private releaseRemaining(job: PaidJob, status: PaidJobStatus): void {
    this.db
      .prepare(
        `UPDATE paid_generation_days
         SET reserved_calls = reserved_calls - ?,
             reserved_usd_micros = reserved_usd_micros - ?
         WHERE utc_day = ?`,
      )
      .run(job.reservedCalls, job.reservedUsdMicros, job.utcDay);
    this.db
      .prepare(
        `UPDATE paid_generation_jobs
         SET status = ?, reserved_calls = 0, reserved_usd_micros = 0,
             lease_owner = NULL, lease_until = NULL
         WHERE id = ?`,
      )
      .run(status, job.id);
  }

  private finalStatus(job: PaidJob): PaidJobStatus {
    return job.acceptedCount > 0 ? "complete" : "failed";
  }

  private sweepExpiredInTransaction(now: number): number {
    const expired = this.db
      .prepare(
        "SELECT * FROM paid_generation_jobs WHERE status = 'leased' AND lease_until <= ?",
      )
      .all(now) as JobRow[];
    for (const row of expired) {
      const job = jobFromRow(row);
      const started = this.db
        .prepare(
          "SELECT id FROM paid_generation_attempts WHERE job_id = ? AND status = 'started' LIMIT 1",
        )
        .get(job.id) as { id: string } | undefined;
      if (started) {
        this.db
          .prepare(
            "UPDATE paid_generation_attempts SET status = 'uncertain', finished_at = ? WHERE id = ?",
          )
          .run(now, started.id);
        this.db
          .prepare(
            "UPDATE paid_generation_jobs SET status = 'uncertain', lease_owner = NULL, lease_until = NULL WHERE id = ?",
          )
          .run(job.id);
      } else if (job.stopReason) {
        this.releaseRemaining(job, job.stopReason);
      } else {
        this.db
          .prepare(
            "UPDATE paid_generation_jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL WHERE id = ?",
          )
          .run(job.id);
      }
    }
    return expired.length;
  }

  sweepExpired(now: number): number {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid time");
    return this.transaction(() => this.sweepExpiredInTransaction(now));
  }

  claim(workerId: string, now: number): PaidJob | null {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(workerId) ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw new Error("Invalid worker claim");
    const id = this.transaction(() => {
      this.sweepExpiredInTransaction(now);
      const active = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM paid_generation_jobs WHERE status = 'leased' AND lease_until > ?",
        )
        .get(now) as { count: number };
      if (active.count >= this.settings.maxConcurrentCalls) return null;
      const queued = this.db
        .prepare(
          "SELECT id FROM paid_generation_jobs WHERE status = 'queued' AND snapshot_json IS NOT NULL ORDER BY created_at, rowid LIMIT 1",
        )
        .get() as { id: string } | undefined;
      if (!queued) return null;
      const leaseUntil =
        now + Math.ceil(this.settings.provider.timeoutMs / 1_000) + 60;
      this.db
        .prepare(
          "UPDATE paid_generation_jobs SET status = 'leased', lease_owner = ?, lease_until = ? WHERE id = ? AND status = 'queued'",
        )
        .run(workerId, leaseUntil, queued.id);
      return queued.id;
    });
    return id ? this.job(id) : null;
  }

  renewLease(jobId: string, workerId: string, now: number): PaidJob {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid time");
    const updated = this.db
      .prepare(
        `UPDATE paid_generation_jobs SET lease_until = ?
         WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_until > ?`,
      )
      .run(
        now + Math.ceil(this.settings.provider.timeoutMs / 1_000) + 60,
        jobId,
        workerId,
        now,
      ).changes;
    if (updated !== 1) throw new Error("Job lease is unavailable");
    const job = this.job(jobId);
    if (!job) throw new Error("Leased job disappeared");
    return job;
  }

  releaseLease(jobId: string, workerId: string): PaidJob {
    this.transaction(() => {
      const job = this.job(jobId);
      if (!job || job.status !== "leased" || job.leaseOwner !== workerId)
        throw new Error("Job lease is unavailable");
      const started = this.db
        .prepare(
          "SELECT 1 FROM paid_generation_attempts WHERE job_id = ? AND status = 'started' LIMIT 1",
        )
        .get(jobId);
      if (started)
        throw new Error("An in-flight image call cannot be released");
      if (job.stopReason) this.releaseRemaining(job, job.stopReason);
      else
        this.db
          .prepare(
            "UPDATE paid_generation_jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL WHERE id = ?",
          )
          .run(jobId);
    });
    const job = this.job(jobId);
    if (!job) throw new Error("Released job disappeared");
    return job;
  }

  beginAttempt(jobId: string, workerId: string, now: number): PaidAttempt {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid time");
    const attemptId = this.transaction(() => {
      const job = this.job(jobId);
      if (
        !job ||
        job.status !== "leased" ||
        job.leaseOwner !== workerId ||
        job.leaseUntil === null ||
        job.leaseUntil <= now ||
        job.stopReason ||
        job.attemptsStarted >= this.settings.maxAttemptsPerBatch ||
        job.reservedCalls < 1
      )
        throw new Error("Job cannot start another image attempt");
      const alreadyStarted = this.db
        .prepare(
          "SELECT 1 FROM paid_generation_attempts WHERE job_id = ? AND status = 'started' LIMIT 1",
        )
        .get(jobId);
      if (alreadyStarted) throw new Error("Image attempt is already in flight");
      const id = randomUUID();
      const clientRequestId = randomUUID();
      const cost = job.costCeilingUsdMicros;
      this.db
        .prepare(
          `INSERT INTO paid_generation_attempts
           (id, job_id, attempt_no, client_request_id, status, started_at)
           VALUES (?, ?, ?, ?, 'started', ?)`,
        )
        .run(id, jobId, job.attemptsStarted + 1, clientRequestId, now);
      this.db
        .prepare(
          `UPDATE paid_generation_jobs
           SET attempts_started = attempts_started + 1,
               reserved_calls = reserved_calls - 1,
               charged_calls = charged_calls + 1,
               reserved_usd_micros = reserved_usd_micros - ?,
               charged_usd_micros = charged_usd_micros + ?
           WHERE id = ?`,
        )
        .run(cost, cost, jobId);
      this.db
        .prepare(
          `UPDATE paid_generation_days
           SET reserved_calls = reserved_calls - 1,
               charged_calls = charged_calls + 1,
               reserved_usd_micros = reserved_usd_micros - ?,
               charged_usd_micros = charged_usd_micros + ?
           WHERE utc_day = ?`,
        )
        .run(cost, cost, job.utcDay);
      return id;
    });
    const attempt = this.attempts(jobId).find((item) => item.id === attemptId);
    if (!attempt) throw new Error("Started attempt disappeared");
    return attempt;
  }

  finishAttempt(input: {
    jobId: string;
    workerId: string;
    clientRequestId: string;
    outcome: "accepted" | "rejected" | "uncertain";
    candidate?: PaidCandidateInput;
    providerRequestId?: string | null;
    usage?: ImageTokenUsage | null;
    now: number;
  }): PaidJob {
    if (!Number.isSafeInteger(input.now) || input.now < 0)
      throw new Error("Invalid time");
    if (input.outcome === "accepted" && !input.candidate)
      throw new Error("Accepted attempt needs a validated candidate");
    if (input.outcome !== "accepted" && input.candidate)
      throw new Error("Only accepted attempts may attach candidates");
    if (input.candidate) {
      const manifest = validateAssetManifest(input.candidate.manifest);
      if (
        input.candidate.spriteHash !== manifest.spriteHash ||
        input.candidate.thumbnailHash !== manifest.thumbnailHash ||
        input.candidate.manifestHash !==
          createHash("sha256").update(canonicalJson(manifest)).digest("hex")
      )
        throw new Error("Paid candidate hashes do not match its manifest");
    }
    if (
      input.providerRequestId !== undefined &&
      input.providerRequestId !== null &&
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.providerRequestId)
    )
      throw new Error("Invalid provider request ID");
    const usageJson = input.usage ? canonicalJson(input.usage) : null;
    if (
      input.usage &&
      Object.values(input.usage).some(
        (count) =>
          count !== null && (!Number.isSafeInteger(count) || count < 0),
      )
    )
      throw new Error("Invalid image token usage");
    this.transaction(() => {
      const job = this.job(input.jobId);
      const attempt = this.db
        .prepare(
          "SELECT * FROM paid_generation_attempts WHERE job_id = ? AND client_request_id = ?",
        )
        .get(input.jobId, input.clientRequestId) as AttemptRow | undefined;
      if (!job || !attempt) throw new Error("Image attempt is missing");
      if (attempt.status !== "started") {
        if (
          attempt.status === input.outcome &&
          attempt.asset_hash === (input.candidate?.manifestHash ?? null) &&
          attempt.provider_request_id === (input.providerRequestId ?? null) &&
          attempt.usage_json === usageJson
        )
          return;
        throw new Error("Image attempt already has a different outcome");
      }
      if (job.status !== "leased" || job.leaseOwner !== input.workerId)
        throw new Error("Job lease is unavailable");
      if (
        input.candidate &&
        (job.snapshot?.buildingType !== input.candidate.manifest.buildingType ||
          job.snapshot.level !== input.candidate.manifest.level ||
          job.acceptedCount >= 3)
      )
        throw new Error("Candidate does not match the paid building snapshot");
      if (input.candidate)
        this.db
          .prepare(
            `INSERT INTO paid_generation_candidates
             (attempt_id, job_id, ordinal, manifest_json, manifest_hash,
              sprite_hash, thumbnail_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            attempt.id,
            job.id,
            job.acceptedCount + 1,
            canonicalJson(input.candidate.manifest),
            input.candidate.manifestHash,
            input.candidate.spriteHash,
            input.candidate.thumbnailHash,
            input.now,
          );
      this.db
        .prepare(
          `UPDATE paid_generation_attempts
           SET status = ?, asset_hash = ?, provider_request_id = ?, usage_json = ?, finished_at = ?
           WHERE id = ? AND status = 'started'`,
        )
        .run(
          input.outcome,
          input.candidate?.manifestHash ?? null,
          input.providerRequestId ?? null,
          usageJson,
          input.now,
          attempt.id,
        );
      if (input.outcome === "accepted")
        this.db
          .prepare(
            "UPDATE paid_generation_jobs SET accepted_count = accepted_count + 1 WHERE id = ?",
          )
          .run(job.id);
      const updated = this.job(job.id);
      if (!updated) throw new Error("Image job disappeared");
      if (input.outcome === "uncertain") {
        this.db
          .prepare(
            "UPDATE paid_generation_jobs SET status = 'uncertain', lease_owner = NULL, lease_until = NULL WHERE id = ?",
          )
          .run(job.id);
      } else if (updated.stopReason) {
        this.releaseRemaining(updated, updated.stopReason);
      } else if (
        updated.acceptedCount >= 3 ||
        updated.attemptsStarted >= this.settings.maxAttemptsPerBatch
      ) {
        this.releaseRemaining(updated, this.finalStatus(updated));
      }
    });
    const job = this.job(input.jobId);
    if (!job) throw new Error("Finished job disappeared");
    return job;
  }

  resolveUncertain(input: {
    jobId: string;
    clientRequestId: string;
    outcome: "confirmed_not_received" | "confirmed_charged";
    note: string;
    now: number;
  }): PaidJob {
    if (
      !Number.isSafeInteger(input.now) ||
      input.now < 0 ||
      input.note.trim().length < 4 ||
      input.note.length > 500
    )
      throw new Error(
        "Uncertain outcome requires a bounded reconciliation note",
      );
    this.transaction(() => {
      const job = this.job(input.jobId);
      const attempt = this.db
        .prepare(
          "SELECT * FROM paid_generation_attempts WHERE job_id = ? AND client_request_id = ?",
        )
        .get(input.jobId, input.clientRequestId) as AttemptRow | undefined;
      if (
        !job ||
        job.status !== "uncertain" ||
        !attempt ||
        attempt.status !== "uncertain"
      )
        throw new Error("Job has no uncertain attempt to reconcile");
      this.db
        .prepare(
          "UPDATE paid_generation_attempts SET status = ?, resolution_note = ?, finished_at = ? WHERE id = ?",
        )
        .run(input.outcome, input.note.trim(), input.now, attempt.id);
      if (input.outcome === "confirmed_not_received") {
        const cost = job.costCeilingUsdMicros;
        this.db
          .prepare(
            `UPDATE paid_generation_jobs
             SET charged_calls = charged_calls - 1,
                 charged_usd_micros = charged_usd_micros - ? WHERE id = ?`,
          )
          .run(cost, job.id);
        this.db
          .prepare(
            `UPDATE paid_generation_days
             SET charged_calls = charged_calls - 1,
                 charged_usd_micros = charged_usd_micros - ? WHERE utc_day = ?`,
          )
          .run(cost, job.utcDay);
      }
      const updated = this.job(job.id);
      if (!updated) throw new Error("Reconciled job disappeared");
      if (updated.stopReason)
        this.releaseRemaining(updated, updated.stopReason);
      else if (updated.attemptsStarted >= this.settings.maxAttemptsPerBatch)
        this.releaseRemaining(updated, this.finalStatus(updated));
      else
        this.db
          .prepare(
            "UPDATE paid_generation_jobs SET status = 'queued' WHERE id = ?",
          )
          .run(job.id);
    });
    const job = this.job(input.jobId);
    if (!job) throw new Error("Reconciled job disappeared");
    return job;
  }

  reserve(input: {
    accountId: string;
    plotId: string;
    idempotencyKey: string;
    snapshot: PaidGenerationSnapshot;
    now: number;
  }): PaidJob {
    if (!this.settings.invites.has(input.accountId))
      throw new PaidJobLimitError("INVITE_REQUIRED");
    if (
      !Number.isSafeInteger(input.now) ||
      input.now < 0 ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey)
    )
      throw new Error("Invalid paid generation reservation");
    if (
      input.snapshot.buildingType !== input.snapshot.promptSpec.buildingType ||
      input.snapshot.level !== input.snapshot.promptSpec.level ||
      !/^[0-9a-f]{64}$/.test(input.snapshot.promptSpec.promptHash) ||
      !Number.isSafeInteger(input.snapshot.layoutRevision) ||
      input.snapshot.layoutRevision < 0 ||
      (input.snapshot.appearanceRevision !== null &&
        (!Number.isSafeInteger(input.snapshot.appearanceRevision) ||
          input.snapshot.appearanceRevision < 0))
    )
      throw new Error("Paid generation snapshot does not match the prompt");
    const { promptHash, ...promptIdentity } = input.snapshot.promptSpec;
    if (
      createHash("sha256")
        .update(canonicalJson(promptIdentity))
        .digest("hex") !== promptHash
    )
      throw new Error("Paid generation prompt fingerprint is invalid");
    const snapshotJson = canonicalJson(input.snapshot);
    const requestHash = createHash("sha256")
      .update(
        canonicalJson({
          accountId: input.accountId,
          plotId: input.plotId,
          snapshot: input.snapshot,
        }),
      )
      .digest("hex");
    const utcDay = Math.floor(input.now / 86_400);
    const reserveCalls = this.settings.maxAttemptsPerBatch;
    const reserveUsdMicros =
      reserveCalls * this.settings.maxCostPerCallUsdMicros;
    if (!Number.isSafeInteger(reserveUsdMicros))
      throw new Error("Image budget exceeds safe integer range");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT * FROM paid_generation_jobs WHERE account_id = ? AND idempotency_key = ?",
        )
        .get(input.accountId, input.idempotencyKey) as JobRow | undefined;
      if (existing) {
        if (
          existing.request_hash !== requestHash ||
          existing.plot_id !== input.plotId
        )
          throw new PaidJobLimitError("IDEMPOTENCY_CONFLICT");
        this.db.exec("COMMIT");
        return jobFromRow(existing);
      }
      const count = (query: string, ...args: (string | number)[]) =>
        (
          this.db.prepare(query).get(...args) as {
            count: number;
          }
        ).count;
      if (
        count(
          "SELECT COUNT(*) AS count FROM paid_generation_jobs WHERE account_id = ? AND utc_day = ?",
          input.accountId,
          utcDay,
        ) >= this.settings.maxBatchesPerAccountPerDay ||
        count(
          "SELECT COUNT(*) AS count FROM paid_generation_jobs WHERE plot_id = ? AND utc_day = ?",
          input.plotId,
          utcDay,
        ) >= this.settings.maxBatchesPerPlotPerDay
      )
        throw new PaidJobLimitError("QUOTA");
      if (
        count(
          "SELECT COUNT(*) AS count FROM paid_generation_jobs WHERE account_id = ? AND status IN ('queued', 'leased', 'uncertain')",
          input.accountId,
        ) >= 1
      )
        throw new PaidJobLimitError("ACTIVE_JOB");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO paid_generation_days (utc_day) VALUES (?)",
        )
        .run(utcDay);
      const day = this.db
        .prepare("SELECT * FROM paid_generation_days WHERE utc_day = ?")
        .get(utcDay) as {
        reserved_calls: number;
        charged_calls: number;
        reserved_usd_micros: number;
        charged_usd_micros: number;
      };
      if (
        day.reserved_calls + day.charged_calls + reserveCalls >
          this.settings.maxCallsPerDay ||
        day.reserved_usd_micros + day.charged_usd_micros + reserveUsdMicros >
          this.settings.dailyBudgetUsdMicros
      )
        throw new PaidJobLimitError("BUDGET");
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO paid_generation_jobs
           (id, account_id, plot_id, idempotency_key, request_hash, snapshot_json, utc_day,
            status, reserved_calls, reserved_usd_micros,
            cost_ceiling_usd_micros, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.accountId,
          input.plotId,
          input.idempotencyKey,
          requestHash,
          snapshotJson,
          utcDay,
          reserveCalls,
          reserveUsdMicros,
          this.settings.maxCostPerCallUsdMicros,
          input.now,
        );
      this.db
        .prepare(
          `UPDATE paid_generation_days
           SET reserved_calls = reserved_calls + ?,
               reserved_usd_micros = reserved_usd_micros + ?
           WHERE utc_day = ?`,
        )
        .run(reserveCalls, reserveUsdMicros, utcDay);
      this.db.exec("COMMIT");
      const job = this.job(id);
      if (!job) throw new Error("Reserved job disappeared");
      return job;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cancel(id: string): PaidJob | null {
    return this.requestStop(id, "cancelled");
  }

  supersede(id: string): PaidJob | null {
    return this.requestStop(id, "superseded");
  }

  failPreflight(id: string, workerId: string): PaidJob {
    this.transaction(() => {
      const job = this.job(id);
      if (!job || job.status !== "leased" || job.leaseOwner !== workerId)
        throw new Error("Job lease is unavailable");
      const inFlight = this.db
        .prepare(
          "SELECT 1 FROM paid_generation_attempts WHERE job_id = ? AND status IN ('started', 'uncertain') LIMIT 1",
        )
        .get(id);
      if (inFlight) throw new Error("Image attempt is already in flight");
      this.releaseRemaining(job, "failed");
    });
    const job = this.job(id);
    if (!job) throw new Error("Failed job disappeared");
    return job;
  }

  private requestStop(
    id: string,
    reason: "cancelled" | "superseded",
  ): PaidJob | null {
    this.transaction(() => {
      const job = this.job(id);
      if (!job || !["queued", "leased", "uncertain"].includes(job.status))
        return;
      const inFlight = this.db
        .prepare(
          "SELECT 1 FROM paid_generation_attempts WHERE job_id = ? AND status IN ('started', 'uncertain') LIMIT 1",
        )
        .get(id);
      if (inFlight) {
        this.db
          .prepare(
            "UPDATE paid_generation_jobs SET stop_reason = ? WHERE id = ?",
          )
          .run(reason, id);
      } else this.releaseRemaining(job, reason);
    });
    return this.job(id);
  }

  day(utcDay: number): {
    reservedCalls: number;
    chargedCalls: number;
    reservedUsdMicros: number;
    chargedUsdMicros: number;
  } {
    const row = this.db
      .prepare("SELECT * FROM paid_generation_days WHERE utc_day = ?")
      .get(utcDay) as
      | {
          reserved_calls: number;
          charged_calls: number;
          reserved_usd_micros: number;
          charged_usd_micros: number;
        }
      | undefined;
    return {
      reservedCalls: row?.reserved_calls ?? 0,
      chargedCalls: row?.charged_calls ?? 0,
      reservedUsdMicros: row?.reserved_usd_micros ?? 0,
      chargedUsdMicros: row?.charged_usd_micros ?? 0,
    };
  }
}
