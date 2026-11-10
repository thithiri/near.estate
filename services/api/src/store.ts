import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssetManifest } from "@estate/shared";
import type { GenerationPromptSpec } from "./prompt-builder.js";

export type Challenge = {
  id: string;
  account_id: string;
  nonce: string;
  message: string;
  recipient: string;
  callback_url: string;
  expires_at: number;
  used_at: number | null;
};

export type Upload = {
  id: string;
  accountId: string;
  plotId: string;
  kind: "Logo" | "Billboard";
  hash: string;
  layoutRevision: number;
  createdAt: number;
};

export type MediaProposalRecord = {
  id: string;
  uploadId: string;
  accountId: string;
  plotId: string;
  kind: "Logo" | "Billboard";
  assetHash: string;
  link: string | null;
  buildingType: string;
  level: number;
  layoutRevision: number;
  expectedMediaRevision: number;
  proposalRevision: number | null;
  status:
    | "selected"
    | "submitted"
    | "approved"
    | "rejected"
    | "revoked"
    | "superseded";
  decidedAt: number | null;
  decisionReason: string | null;
  createdAt: number;
};

export type MockCandidate = {
  id: 1 | 2 | 3;
  variant: 1 | 2;
  palette: string;
  manifest: AssetManifest;
  manifestHash: string;
  spriteHash: string;
  thumbnailHash: string;
};
export type GenerationJob = {
  id: string;
  mode: "curated_mock" | "paid";
  accountId: string;
  plotId: string;
  buildingType: string;
  level: number;
  layoutRevision: number;
  appearanceRevision: number | null;
  description: string;
  promptSpec: GenerationPromptSpec | null;
  status:
    | "ready"
    | "selected"
    | "submitted"
    | "approved"
    | "rejected"
    | "revoked"
    | "expired";
  selectedCandidateId: 1 | 2 | 3 | null;
  proposalRevision: number | null;
  decidedAt: number | null;
  decisionReason: string | null;
  candidates: MockCandidate[];
  createdAt: number;
};

export class ApiStore {
  readonly db: DatabaseSync;
  private assetMutationQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly dbPath: string,
    readonly assetDir: string,
  ) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(assetDir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS auth_challenges (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        message TEXT NOT NULL,
        recipient TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS challenge_account_time
        ON auth_challenges(account_id, created_at);
      CREATE INDEX IF NOT EXISTS challenge_created_time
        ON auth_challenges(created_at);
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS auth_session_expiry
        ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS media_uploads (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        plot_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('Logo', 'Billboard')),
        hash TEXT NOT NULL,
        layout_revision INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        UNIQUE(account_id, plot_id, kind, hash, layout_revision)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS upload_hash ON media_uploads(hash);
      CREATE INDEX IF NOT EXISTS upload_account_plot_time
        ON media_uploads(account_id, plot_id, created_at);
      CREATE TABLE IF NOT EXISTS media_upload_attempts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        plot_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS upload_attempt_account_time
        ON media_upload_attempts(account_id, created_at);
      CREATE INDEX IF NOT EXISTS upload_attempt_plot_time
        ON media_upload_attempts(account_id, plot_id, created_at);
      CREATE TABLE IF NOT EXISTS media_proposals (
        id TEXT PRIMARY KEY,
        upload_id TEXT NOT NULL REFERENCES media_uploads(id),
        account_id TEXT NOT NULL,
        plot_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('Logo', 'Billboard')),
        asset_hash TEXT NOT NULL,
        link TEXT,
        building_type TEXT NOT NULL,
        level INTEGER NOT NULL,
        layout_revision INTEGER NOT NULL,
        expected_media_revision INTEGER NOT NULL,
        proposal_revision INTEGER,
        status TEXT NOT NULL DEFAULT 'selected',
        decided_at INTEGER,
        decision_reason TEXT,
        last_checked_at INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS media_proposal_account_plot_time
        ON media_proposals(account_id, plot_id, kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS media_proposal_status
        ON media_proposals(status, created_at);
      CREATE INDEX IF NOT EXISTS media_proposal_upload_time
        ON media_proposals(upload_id, created_at);
      CREATE INDEX IF NOT EXISTS media_proposal_account_time
        ON media_proposals(account_id, created_at);
      CREATE TABLE IF NOT EXISTS generation_jobs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'curated_mock' CHECK (mode IN ('curated_mock', 'paid')),
        account_id TEXT NOT NULL,
        plot_id TEXT NOT NULL,
        building_type TEXT NOT NULL,
        level INTEGER NOT NULL,
        layout_revision INTEGER NOT NULL,
        appearance_revision INTEGER,
        description TEXT NOT NULL,
        prompt_json TEXT,
        candidates_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ready_at INTEGER,
        status TEXT NOT NULL DEFAULT 'ready',
        selected_candidate_id INTEGER,
        proposal_revision INTEGER,
        decided_at INTEGER,
        decision_reason TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS generation_account_plot_time
        ON generation_jobs(account_id, plot_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS generation_assets (
        job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
        hash TEXT NOT NULL,
        is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
        PRIMARY KEY (job_id, hash)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS generation_asset_hash
        ON generation_assets(hash);
    `);
    const sessionColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(auth_sessions)").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    if (!sessionColumns.has("public_key"))
      this.db.exec("ALTER TABLE auth_sessions ADD COLUMN public_key TEXT");
    this.db.prepare("DELETE FROM auth_sessions WHERE public_key IS NULL").run();
    const mediaColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(media_proposals)").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    if (!mediaColumns.has("last_checked_at"))
      this.db.exec(
        "ALTER TABLE media_proposals ADD COLUMN last_checked_at INTEGER",
      );
    const jobColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(generation_jobs)").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    for (const [name, declaration] of [
      ["status", "TEXT NOT NULL DEFAULT 'ready'"],
      ["appearance_revision", "INTEGER"],
      ["selected_candidate_id", "INTEGER"],
      ["proposal_revision", "INTEGER"],
      ["decided_at", "INTEGER"],
      ["decision_reason", "TEXT"],
      ["prompt_json", "TEXT"],
      ["mode", "TEXT NOT NULL DEFAULT 'curated_mock'"],
      ["ready_at", "INTEGER"],
    ] as const) {
      if (!jobColumns.has(name))
        this.db.exec(
          `ALTER TABLE generation_jobs ADD COLUMN ${name} ${declaration}`,
        );
    }
  }

  async withAssetMutation<T>(action: () => Promise<T>): Promise<T> {
    const prior = this.assetMutationQueue;
    let release: () => void = () => undefined;
    this.assetMutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }

  close(): void {
    this.db.close();
  }

  recentChallenges(accountId: string, since: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM auth_challenges WHERE account_id = ? AND created_at >= ?",
      )
      .get(accountId, since) as { count: number };
    return row.count;
  }

  recentChallengeTotal(since: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM auth_challenges WHERE created_at >= ?",
      )
      .get(since) as { count: number };
    return row.count;
  }

  pruneExpiredAuth(now: number): void {
    this.db
      .prepare("DELETE FROM auth_challenges WHERE expires_at <= ?")
      .run(now);
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
  }

  createChallenge(challenge: Omit<Challenge, "used_at">, now: number): void {
    this.db
      .prepare(
        `INSERT INTO auth_challenges
         (id, account_id, nonce, message, recipient, callback_url, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        challenge.id,
        challenge.account_id,
        challenge.nonce,
        challenge.message,
        challenge.recipient,
        challenge.callback_url,
        now,
        challenge.expires_at,
      );
  }

  challenge(id: string): Challenge | null {
    return (
      (this.db.prepare("SELECT * FROM auth_challenges WHERE id = ?").get(id) as
        | Challenge
        | undefined) ?? null
    );
  }

  consumeChallenge(id: string, now: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?",
        )
        .run(now, id, now).changes === 1
    );
  }

  createSession(
    tokenHash: string,
    accountId: string,
    publicKey: string,
    now: number,
    expiresAt: number,
  ): void {
    this.db
      .prepare(
        "INSERT INTO auth_sessions (token_hash, account_id, public_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(tokenHash, accountId, publicKey, now, expiresAt);
  }

  sessionIdentity(
    tokenHash: string,
    now: number,
  ): { accountId: string; publicKey: string } | null {
    const row = this.db
      .prepare(
        "SELECT account_id, public_key FROM auth_sessions WHERE token_hash = ? AND expires_at > ?",
      )
      .get(tokenHash, now) as
      | { account_id: string; public_key: string }
      | undefined;
    return row
      ? { accountId: row.account_id, publicKey: row.public_key }
      : null;
  }

  sessionAccount(tokenHash: string, now: number): string | null {
    return this.sessionIdentity(tokenHash, now)?.accountId ?? null;
  }

  deleteSession(tokenHash: string): void {
    this.db
      .prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
      .run(tokenHash);
  }

  recentGenerations(accountId: string, since: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM generation_jobs WHERE account_id = ? AND created_at >= ?",
      )
      .get(accountId, since) as { count: number };
    return row.count;
  }

  createGeneration(
    input: Omit<
      GenerationJob,
      | "id"
      | "status"
      | "selectedCandidateId"
      | "proposalRevision"
      | "decidedAt"
      | "decisionReason"
      | "promptSpec"
      | "mode"
    > & {
      promptSpec?: GenerationPromptSpec | null;
      mode?: GenerationJob["mode"];
      id?: string;
      readyAt?: number;
    },
  ): GenerationJob {
    const id = input.id ?? randomUUID();
    const mode = input.mode ?? "curated_mock";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO generation_jobs
         (id, mode, account_id, plot_id, building_type, level, layout_revision,
          appearance_revision, description, prompt_json, candidates_json, created_at, ready_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          mode,
          input.accountId,
          input.plotId,
          input.buildingType,
          input.level,
          input.layoutRevision,
          input.appearanceRevision,
          input.description,
          input.promptSpec ? JSON.stringify(input.promptSpec) : null,
          JSON.stringify(input.candidates),
          input.createdAt,
          input.readyAt ?? input.createdAt,
        );
      const insertAsset = this.db.prepare(
        "INSERT INTO generation_assets (job_id, hash) VALUES (?, ?)",
      );
      for (const candidate of input.candidates) {
        insertAsset.run(id, candidate.spriteHash);
        insertAsset.run(id, candidate.thumbnailHash);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      ...input,
      id,
      mode,
      promptSpec: input.promptSpec ?? null,
      status: "ready",
      selectedCandidateId: null,
      proposalRevision: null,
      decidedAt: null,
      decisionReason: null,
    };
  }

  selectGeneration(
    id: string,
    accountId: string,
    candidateId: 1 | 2 | 3,
  ): GenerationJob | null {
    const changed = this.db
      .prepare(
        `UPDATE generation_jobs SET status = 'selected', selected_candidate_id = ?
         WHERE id = ? AND account_id = ?
           AND (status = 'ready' OR (status = 'selected' AND selected_candidate_id = ?))`,
      )
      .run(candidateId, id, accountId, candidateId).changes;
    return changed === 1 ? this.generation(id) : null;
  }

  markGenerationSubmitted(id: string, proposalRevision: number): void {
    const changed = this.db
      .prepare(
        `UPDATE generation_jobs SET status = 'submitted', proposal_revision = ?
         WHERE id = ? AND status IN ('selected', 'submitted')
           AND (proposal_revision IS NULL OR proposal_revision = ?)`,
      )
      .run(proposalRevision, id, proposalRevision).changes;
    if (changed !== 1) throw new Error("Design job cannot be reconciled");
  }

  reviewQueue(): GenerationJob[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM generation_jobs WHERE status = 'submitted' ORDER BY created_at ASC, rowid ASC",
        )
        .all() as unknown[]
    ).map((row) => this.generationFromRow(row));
  }

  recentApprovedGenerations(limit: number): GenerationJob[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM generation_jobs WHERE status = 'approved' ORDER BY decided_at DESC, rowid DESC LIMIT ?",
        )
        .all(limit) as unknown[]
    ).map((row) => this.generationFromRow(row));
  }

  generationHistory(
    accountId: string,
    plotId: string,
    limit: number,
  ): GenerationJob[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM generation_jobs WHERE account_id = ? AND plot_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(accountId, plotId, limit) as unknown[]
    ).map((row) => this.generationFromRow(row));
  }

  markGenerationDecided(
    id: string,
    status: "approved" | "rejected",
    decidedAt: number,
    reason: string | null,
  ): GenerationJob {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.generation(id);
      if (!job || !job.selectedCandidateId || job.proposalRevision === null)
        throw new Error("Design job cannot be decided");
      if (job.status === status) {
        this.db.exec("COMMIT");
        return job;
      }
      if (job.status !== "submitted")
        throw new Error("Design job cannot be decided");
      const changed = this.db
        .prepare(
          `UPDATE generation_jobs SET status = ?, decided_at = ?, decision_reason = ?
           WHERE id = ? AND status = 'submitted'`,
        )
        .run(status, decidedAt, reason, id).changes;
      if (changed !== 1) throw new Error("Design job changed during decision");
      if (status === "approved") {
        const candidate = job.candidates.find(
          (entry) => entry.id === job.selectedCandidateId,
        );
        if (!candidate) throw new Error("Selected design is missing");
        this.db
          .prepare(
            `UPDATE generation_assets SET is_public = 1
             WHERE job_id = ? AND hash IN (?, ?)`,
          )
          .run(id, candidate.spriteHash, candidate.thumbnailHash);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const decided = this.generation(id);
    if (!decided) throw new Error("Decided design job disappeared");
    return decided;
  }

  markGenerationRevoked(
    id: string,
    decidedAt: number,
    reason: string,
  ): GenerationJob {
    const changed = this.db
      .prepare(
        `UPDATE generation_jobs SET status = 'revoked', decided_at = ?, decision_reason = ?
         WHERE id = ? AND status = 'approved'`,
      )
      .run(decidedAt, reason, id).changes;
    if (changed !== 1) throw new Error("Approved design cannot be revoked");
    const job = this.generation(id);
    if (!job) throw new Error("Revoked design job disappeared");
    return job;
  }

  publicManifest(manifestHash: string): AssetManifest | null {
    const approved = this.db
      .prepare(
        "SELECT * FROM generation_jobs WHERE status IN ('approved', 'revoked')",
      )
      .all() as unknown[];
    for (const row of approved) {
      const job = this.generationFromRow(row);
      const candidate = job.candidates.find(
        (entry) => entry.id === job.selectedCandidateId,
      );
      if (candidate?.manifestHash === manifestHash) return candidate.manifest;
    }
    return null;
  }

  approvedReference(
    accountId: string,
    plotId: string,
    buildingType: string,
    maxLevel: number,
    manifestHash: string | null = null,
  ): MockCandidate | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM generation_jobs
         WHERE account_id = ? AND plot_id = ? AND building_type = ?
           AND level <= ? AND status = 'approved'
         ORDER BY decided_at DESC, rowid DESC`,
      )
      .all(accountId, plotId, buildingType, maxLevel) as unknown[];
    for (const row of rows) {
      const job = this.generationFromRow(row);
      const candidate = job.candidates.find(
        (entry) => entry.id === job.selectedCandidateId,
      );
      if (
        candidate &&
        (manifestHash === null || candidate.manifestHash === manifestHash)
      )
        return candidate;
    }
    return null;
  }

  expirePrivateCandidates(cutoff: number): number {
    if (!Number.isSafeInteger(cutoff) || cutoff < 0)
      throw new Error("Invalid candidate expiry time");
    const rows = this.db
      .prepare(
        `SELECT id, status, selected_candidate_id, candidates_json
         FROM generation_jobs WHERE COALESCE(ready_at, created_at) <= ?`,
      )
      .all(cutoff) as {
      id: string;
      status: GenerationJob["status"];
      selected_candidate_id: number | null;
      candidates_json: string;
    }[];
    let removed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const expire = this.db.prepare(
        "UPDATE generation_jobs SET status = 'expired' WHERE id = ? AND status = 'ready'",
      );
      const remove = this.db.prepare(
        "DELETE FROM generation_assets WHERE job_id = ? AND hash = ? AND is_public = 0",
      );
      for (const row of rows) {
        if (row.status === "ready") expire.run(row.id);
        const selected = row.selected_candidate_id;
        const candidates = JSON.parse(row.candidates_json) as MockCandidate[];
        for (const candidate of candidates) {
          if (selected === candidate.id) continue;
          removed += Number(remove.run(row.id, candidate.spriteHash).changes);
          removed += Number(
            remove.run(row.id, candidate.thumbnailHash).changes,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return removed;
  }

  retainsAsset(hash: string, cutoff: number): boolean {
    const direct = Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM generation_assets WHERE hash = ?
           UNION ALL SELECT 1 FROM media_uploads
           WHERE hash = ? AND status != 'expired' LIMIT 1`,
        )
        .get(hash, hash),
    );
    if (direct) return true;
    const paidTable = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'paid_generation_candidates'",
      )
      .get();
    if (!paidTable) return false;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM paid_generation_candidates AS candidate
           WHERE (candidate.sprite_hash = ? OR candidate.thumbnail_hash = ?)
             AND (
               candidate.review_status = 'pending'
               OR (candidate.review_status = 'rejected' AND candidate.reviewed_at > ?)
               OR (candidate.review_status = 'approved' AND (
                 NOT EXISTS (
                   SELECT 1 FROM generation_jobs AS design WHERE design.id = candidate.job_id
                 )
                 OR EXISTS (
                   SELECT 1 FROM generation_assets AS asset
                   WHERE asset.job_id = candidate.job_id AND asset.hash = ?
                 )
               ))
             ) LIMIT 1`,
        )
        .get(hash, hash, cutoff, hash),
    );
  }

  expireStaleUploads(cutoff: number): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rejected = Number(
        this.db
          .prepare(
            `UPDATE media_uploads SET status = 'expired'
             WHERE status = 'pending' AND created_at <= ?
               AND EXISTS (
                 SELECT 1 FROM media_proposals
                 WHERE upload_id = media_uploads.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM media_proposals
                 WHERE upload_id = media_uploads.id
                   AND (status NOT IN ('rejected', 'superseded') OR decided_at IS NULL OR decided_at > ?)
               )`,
          )
          .run(cutoff, cutoff).changes,
      );
      const unused = Number(
        this.db
          .prepare(
            `DELETE FROM media_uploads
             WHERE created_at <= ? AND status = 'pending'
               AND NOT EXISTS (
                 SELECT 1 FROM media_proposals
                 WHERE media_proposals.upload_id = media_uploads.id
               )`,
          )
          .run(cutoff).changes,
      );
      this.db.exec("COMMIT");
      return rejected + unused;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reserveUploadAttempt(
    accountId: string,
    plotId: string,
    now: number,
    windowSeconds: number,
    perPlot: number,
    perAccount: number,
  ): boolean {
    const since = now - windowSeconds;
    this.db
      .prepare("DELETE FROM media_upload_attempts WHERE created_at < ?")
      .run(since);
    return (
      this.db
        .prepare(
          `INSERT INTO media_upload_attempts (id, account_id, plot_id, created_at)
           SELECT ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM media_upload_attempts
                  WHERE account_id = ? AND created_at >= ?) < ?
             AND (SELECT COUNT(*) FROM media_upload_attempts
                  WHERE account_id = ? AND plot_id = ? AND created_at >= ?) < ?`,
        )
        .run(
          randomUUID(),
          accountId,
          plotId,
          now,
          accountId,
          since,
          perAccount,
          accountId,
          plotId,
          since,
          perPlot,
        ).changes === 1
    );
  }

  generation(id: string): GenerationJob | null {
    const row = this.db
      .prepare("SELECT * FROM generation_jobs WHERE id = ?")
      .get(id);
    return row ? this.generationFromRow(row) : null;
  }

  latestGeneration(accountId: string, plotId: string): GenerationJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM generation_jobs
         WHERE account_id = ? AND plot_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(accountId, plotId);
    return row ? this.generationFromRow(row) : null;
  }

  private generationFromRow(row: unknown): GenerationJob {
    const value = row as {
      id: string;
      mode: GenerationJob["mode"];
      account_id: string;
      plot_id: string;
      building_type: string;
      level: number;
      layout_revision: number;
      appearance_revision: number | null;
      description: string;
      prompt_json: string | null;
      candidates_json: string;
      created_at: number;
      status: GenerationJob["status"];
      selected_candidate_id: GenerationJob["selectedCandidateId"];
      proposal_revision: number | null;
      decided_at: number | null;
      decision_reason: string | null;
    };
    return {
      id: value.id,
      mode: value.mode,
      accountId: value.account_id,
      plotId: value.plot_id,
      buildingType: value.building_type,
      level: value.level,
      layoutRevision: value.layout_revision,
      appearanceRevision: value.appearance_revision,
      description: value.description,
      promptSpec: value.prompt_json
        ? (JSON.parse(value.prompt_json) as GenerationPromptSpec)
        : null,
      status: value.status,
      selectedCandidateId: value.selected_candidate_id,
      proposalRevision: value.proposal_revision,
      decidedAt: value.decided_at,
      decisionReason: value.decision_reason,
      candidates: (
        JSON.parse(value.candidates_json) as GenerationJob["candidates"]
      ).filter((candidate) => {
        const sprite = this.db
          .prepare(
            "SELECT 1 FROM generation_assets WHERE job_id = ? AND hash = ? LIMIT 1",
          )
          .get(value.id, candidate.spriteHash);
        const thumbnail = this.db
          .prepare(
            "SELECT 1 FROM generation_assets WHERE job_id = ? AND hash = ? LIMIT 1",
          )
          .get(value.id, candidate.thumbnailHash);
        return Boolean(sprite && thumbnail);
      }),
      createdAt: value.created_at,
    };
  }

  recordUpload(input: Omit<Upload, "id">): Upload {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO media_uploads
         (id, account_id, plot_id, kind, hash, layout_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, plot_id, kind, hash, layout_revision)
         DO UPDATE SET created_at = MAX(media_uploads.created_at, excluded.created_at),
                       status = CASE WHEN media_uploads.status = 'expired'
                                     THEN 'pending' ELSE media_uploads.status END`,
      )
      .run(
        id,
        input.accountId,
        input.plotId,
        input.kind,
        input.hash,
        input.layoutRevision,
        input.createdAt,
      );
    const row = this.db
      .prepare(
        `SELECT id, account_id, plot_id, kind, hash, layout_revision, created_at
         FROM media_uploads
         WHERE account_id = ? AND plot_id = ? AND kind = ? AND hash = ? AND layout_revision = ?`,
      )
      .get(
        input.accountId,
        input.plotId,
        input.kind,
        input.hash,
        input.layoutRevision,
      ) as {
      id: string;
      account_id: string;
      plot_id: string;
      kind: "Logo" | "Billboard";
      hash: string;
      layout_revision: number;
      created_at: number;
    };
    return {
      id: row.id,
      accountId: row.account_id,
      plotId: row.plot_id,
      kind: row.kind,
      hash: row.hash,
      layoutRevision: row.layout_revision,
      createdAt: row.created_at,
    };
  }

  upload(id: string): Upload | null {
    const row = this.db
      .prepare(
        `SELECT id, account_id, plot_id, kind, hash, layout_revision, created_at
         FROM media_uploads WHERE id = ? AND status != 'expired'`,
      )
      .get(id) as
      | {
          id: string;
          account_id: string;
          plot_id: string;
          kind: Upload["kind"];
          hash: string;
          layout_revision: number;
          created_at: number;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          accountId: row.account_id,
          plotId: row.plot_id,
          kind: row.kind,
          hash: row.hash,
          layoutRevision: row.layout_revision,
          createdAt: row.created_at,
        }
      : null;
  }

  latestUpload(
    accountId: string,
    plotId: string,
    kind: Upload["kind"],
  ): Upload | null {
    const row = this.db
      .prepare(
        `SELECT id FROM media_uploads WHERE account_id = ? AND plot_id = ? AND kind = ?
           AND status != 'expired'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(accountId, plotId, kind) as { id: string } | undefined;
    return row ? this.upload(row.id) : null;
  }

  createMediaProposal(
    input: Omit<
      MediaProposalRecord,
      "id" | "proposalRevision" | "status" | "decidedAt" | "decisionReason"
    >,
  ): MediaProposalRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO media_proposals
         (id, upload_id, account_id, plot_id, kind, asset_hash, link,
          building_type, level, layout_revision, expected_media_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.uploadId,
        input.accountId,
        input.plotId,
        input.kind,
        input.assetHash,
        input.link,
        input.buildingType,
        input.level,
        input.layoutRevision,
        input.expectedMediaRevision,
        input.createdAt,
      );
    return {
      ...input,
      id,
      proposalRevision: null,
      status: "selected",
      decidedAt: null,
      decisionReason: null,
    };
  }

  createOrReuseMediaProposal(
    input: Omit<
      MediaProposalRecord,
      "id" | "proposalRevision" | "status" | "decidedAt" | "decisionReason"
    >,
    since: number,
    maxPerUpload: number,
    maxPerAccount: number,
    maxUnresolvedPerSlot: number,
  ):
    | { record: MediaProposalRecord; created: boolean }
    | { limit: "upload" | "account" | "slot" } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          `SELECT * FROM media_proposals
           WHERE upload_id = ? AND account_id = ? AND plot_id = ? AND kind = ?
             AND asset_hash = ? AND link IS ? AND building_type = ?
             AND level = ? AND layout_revision = ? AND expected_media_revision = ?
             AND status != 'superseded'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(
          input.uploadId,
          input.accountId,
          input.plotId,
          input.kind,
          input.assetHash,
          input.link,
          input.buildingType,
          input.level,
          input.layoutRevision,
          input.expectedMediaRevision,
        );
      if (existing) {
        const record = this.mediaProposalFromRow(existing);
        this.db.exec("COMMIT");
        return { record, created: false };
      }
      const unresolvedCount = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM media_proposals
           WHERE plot_id = ? AND kind = ? AND layout_revision = ?
             AND expected_media_revision = ? AND status = 'selected'`,
        )
        .get(
          input.plotId,
          input.kind,
          input.layoutRevision,
          input.expectedMediaRevision,
        ) as { count: number };
      if (unresolvedCount.count >= maxUnresolvedPerSlot) {
        this.db.exec("COMMIT");
        return { limit: "slot" };
      }
      const uploadCount = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM media_proposals WHERE upload_id = ? AND created_at >= ?",
        )
        .get(input.uploadId, since) as { count: number };
      if (uploadCount.count >= maxPerUpload) {
        this.db.exec("COMMIT");
        return { limit: "upload" };
      }
      const accountCount = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM media_proposals WHERE account_id = ? AND created_at >= ?",
        )
        .get(input.accountId, since) as { count: number };
      if (accountCount.count >= maxPerAccount) {
        this.db.exec("COMMIT");
        return { limit: "account" };
      }
      const record = this.createMediaProposal(input);
      this.db.exec("COMMIT");
      return { record, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  mediaProposal(id: string): MediaProposalRecord | null {
    const row = this.db
      .prepare("SELECT * FROM media_proposals WHERE id = ?")
      .get(id);
    return row ? this.mediaProposalFromRow(row) : null;
  }

  staleSelectedMediaProposals(
    cutoff: number,
    checkedBefore: number,
    limit: number,
  ): MediaProposalRecord[] {
    if (
      !Number.isSafeInteger(cutoff) ||
      cutoff < 0 ||
      !Number.isSafeInteger(checkedBefore) ||
      checkedBefore < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      throw new Error("Invalid media proposal expiry scan");
    return (
      this.db
        .prepare(
          `SELECT * FROM media_proposals WHERE status = 'selected' AND created_at <= ?
           AND (last_checked_at IS NULL OR last_checked_at <= ?)
           ORDER BY COALESCE(last_checked_at, created_at) ASC, rowid ASC LIMIT ?`,
        )
        .all(cutoff, checkedBefore, limit) as unknown[]
    ).map((row) => this.mediaProposalFromRow(row));
  }

  markMediaChecked(id: string, checkedAt: number): void {
    this.db
      .prepare(
        "UPDATE media_proposals SET last_checked_at = ? WHERE id = ? AND status = 'selected'",
      )
      .run(checkedAt, id);
  }

  markMediaSuperseded(id: string, decidedAt: number): MediaProposalRecord {
    const changed = this.db
      .prepare(
        `UPDATE media_proposals SET status = 'superseded', decided_at = ?,
         decision_reason = 'Building or media revision changed'
         WHERE id = ? AND status = 'selected'`,
      )
      .run(decidedAt, id).changes;
    if (changed !== 1) throw new Error("Media proposal cannot be superseded");
    const record = this.mediaProposal(id);
    if (!record) throw new Error("Media proposal disappeared");
    return record;
  }

  latestMediaProposal(
    accountId: string,
    plotId: string,
    kind: Upload["kind"],
  ): MediaProposalRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM media_proposals WHERE account_id = ? AND plot_id = ? AND kind = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(accountId, plotId, kind);
    return row ? this.mediaProposalFromRow(row) : null;
  }

  mediaReviewQueue(): MediaProposalRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM media_proposals WHERE status = 'submitted' ORDER BY created_at ASC, rowid ASC",
        )
        .all() as unknown[]
    ).map((row) => this.mediaProposalFromRow(row));
  }

  activeMediaProposals(limit: number): MediaProposalRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM media_proposals WHERE status = 'approved' ORDER BY decided_at DESC, rowid DESC LIMIT ?",
        )
        .all(limit) as unknown[]
    ).map((row) => this.mediaProposalFromRow(row));
  }

  markMediaSubmitted(id: string, revision: number): MediaProposalRecord {
    const changed = this.db
      .prepare(
        `UPDATE media_proposals SET status = 'submitted', proposal_revision = ?
         WHERE id = ? AND status IN ('selected', 'submitted')
           AND (proposal_revision IS NULL OR proposal_revision = ?)`,
      )
      .run(revision, id, revision).changes;
    if (changed !== 1) throw new Error("Media proposal cannot be reconciled");
    const record = this.mediaProposal(id);
    if (!record) throw new Error("Media proposal disappeared");
    return record;
  }

  markMediaDecided(
    id: string,
    status: "approved" | "rejected",
    decidedAt: number,
    reason: string | null,
  ): MediaProposalRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const record = this.mediaProposal(id);
      if (!record || record.status !== "submitted")
        throw new Error("Media proposal cannot be decided");
      const changed = this.db
        .prepare(
          `UPDATE media_proposals SET status = ?, decided_at = ?, decision_reason = ?
           WHERE id = ? AND status = 'submitted'`,
        )
        .run(status, decidedAt, reason, id).changes;
      if (changed !== 1)
        throw new Error("Media proposal changed during decision");
      if (status === "approved")
        this.db
          .prepare("UPDATE media_uploads SET status = 'approved' WHERE id = ?")
          .run(record.uploadId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const record = this.mediaProposal(id);
    if (!record) throw new Error("Media proposal disappeared");
    return record;
  }

  markMediaRevoked(
    id: string,
    decidedAt: number,
    reason: string,
  ): MediaProposalRecord {
    const changed = this.db
      .prepare(
        `UPDATE media_proposals SET status = 'revoked', decided_at = ?, decision_reason = ?
         WHERE id = ? AND status = 'approved'`,
      )
      .run(decidedAt, reason, id).changes;
    if (changed !== 1) throw new Error("Approved media cannot be revoked");
    const record = this.mediaProposal(id);
    if (!record) throw new Error("Media proposal disappeared");
    return record;
  }

  private mediaProposalFromRow(row: unknown): MediaProposalRecord {
    const value = row as {
      id: string;
      upload_id: string;
      account_id: string;
      plot_id: string;
      kind: Upload["kind"];
      asset_hash: string;
      link: string | null;
      building_type: string;
      level: number;
      layout_revision: number;
      expected_media_revision: number;
      proposal_revision: number | null;
      status: MediaProposalRecord["status"];
      decided_at: number | null;
      decision_reason: string | null;
      created_at: number;
    };
    return {
      id: value.id,
      uploadId: value.upload_id,
      accountId: value.account_id,
      plotId: value.plot_id,
      kind: value.kind,
      assetHash: value.asset_hash,
      link: value.link,
      buildingType: value.building_type,
      level: value.level,
      layoutRevision: value.layout_revision,
      expectedMediaRevision: value.expected_media_revision,
      proposalRevision: value.proposal_revision,
      status: value.status,
      decidedAt: value.decided_at,
      decisionReason: value.decision_reason,
      createdAt: value.created_at,
    };
  }

  canReadAsset(hash: string, accountId: string | null): boolean {
    const media = this.db
      .prepare(
        "SELECT 1 FROM media_uploads WHERE hash = ? AND status != 'expired' AND (status = 'approved' OR account_id = ?) LIMIT 1",
      )
      .get(hash, accountId ?? "") as { "1": number } | undefined;
    if (media) return true;
    const generated = this.db
      .prepare(
        `SELECT 1 FROM generation_assets AS asset
         JOIN generation_jobs AS job ON job.id = asset.job_id
         WHERE asset.hash = ? AND (asset.is_public = 1 OR job.account_id = ?)
         LIMIT 1`,
      )
      .get(hash, accountId ?? "") as { "1": number } | undefined;
    return Boolean(generated);
  }

  isPublicAsset(hash: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM generation_assets WHERE hash = ? AND is_public = 1
           UNION ALL SELECT 1 FROM media_uploads WHERE hash = ? AND status = 'approved'
           LIMIT 1`,
        )
        .get(hash, hash),
    );
  }

  canReviewAsset(hash: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM generation_assets AS asset
           JOIN generation_jobs AS job ON job.id = asset.job_id
           WHERE asset.hash = ? AND job.status IN ('submitted', 'approved', 'rejected')
           LIMIT 1`,
        )
        .get(hash),
    );
  }
}
