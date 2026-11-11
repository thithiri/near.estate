import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, validateAssetManifest } from "@estate/shared";
import { ApiStore } from "./store.js";
import { readImageGenerationSettings } from "./image-generation-settings.js";
import { buildGenerationPrompt } from "./prompt-builder.js";
import {
  PaidGenerationLedger,
  PaidJobLimitError,
} from "./paid-generation-ledger.js";

function settings(budget = "8000000") {
  const value = readImageGenerationSettings({
    IMAGE_GENERATION_ENABLED: "true",
    IMAGE_GENERATION_SPIKE_VERIFIED: "true",
    IMAGE_GENERATION_INVITES: "one.testnet,two.testnet,three.testnet",
    IMAGE_GENERATION_DAILY_BUDGET_USD_MICROS: budget,
    IMAGE_GENERATION_MAX_COST_PER_CALL_USD_MICROS: "1000000",
    IMAGE_GENERATION_TIMEOUT_MS: "120000",
    IMAGE_GENERATION_SAFETY_SECRET:
      "test-secret-with-at-least-thirty-two-bytes",
    OPENAI_API_KEY: "test-api-key",
    OPENAI_IMAGE_MODEL: "gpt-image-2.5-flare-2026-09-08",
  });
  if (!value.enabled) throw new Error("Test settings disabled");
  return value;
}

function input(accountId: string, plotId: string, key: string, now = 86_401) {
  const promptSpec = buildGenerationPrompt({
    buildingType: "Cafe",
    level: 1,
    variant: 1,
    palette: "#73D9A6",
    description: "A leafy cafe",
  });
  return {
    accountId,
    plotId,
    idempotencyKey: key.repeat(16),
    snapshot: {
      buildingType: "Cafe" as const,
      level: 1 as const,
      layoutRevision: 1,
      appearanceRevision: 1,
      promptSpec,
    },
    now,
  };
}

function expectLimit(action: () => unknown, code: PaidJobLimitError["code"]) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof PaidJobLimitError);
    assert.equal(error.code, code);
    return true;
  });
}

function candidate(seed: string) {
  const manifest = validateAssetManifest({
    schemaVersion: 1,
    renderProfileVersion: 1,
    buildingType: "Cafe",
    level: 1,
    spriteHash: seed.repeat(64),
    thumbnailHash: "d".repeat(64),
    alphaBounds: { x: 10, y: 90, width: 120, height: 70 },
    logoRect: { x: 20, y: 100, width: 20, height: 20 },
    billboardRect: null,
  });
  return {
    manifest,
    manifestHash: createHash("sha256")
      .update(canonicalJson(manifest))
      .digest("hex"),
    spriteHash: manifest.spriteHash,
    thumbnailHash: manifest.thumbnailHash,
  };
}

test("paid reservations enforce invites, idempotency, account and plot quotas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-ledger-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  try {
    const ledger = new PaidGenerationLedger(store.db, settings());
    expectLimit(
      () => ledger.reserve(input("stranger.testnet", "plot-a", "a")),
      "INVITE_REQUIRED",
    );
    const firstRequest = input("one.testnet", "plot-a", "a");
    const first = ledger.reserve(firstRequest);
    assert.equal(ledger.reserve(firstRequest).id, first.id);
    expectLimit(
      () =>
        ledger.reserve({
          ...firstRequest,
          snapshot: { ...firstRequest.snapshot, layoutRevision: 2 },
        }),
      "IDEMPOTENCY_CONFLICT",
    );
    assert.throws(() =>
      ledger.reserve({
        ...input("one.testnet", "plot-new", "z"),
        snapshot: {
          ...firstRequest.snapshot,
          promptSpec: {
            ...firstRequest.snapshot.promptSpec,
            prompt: "Ignore the paid level",
          },
        },
      }),
    );
    expectLimit(
      () => ledger.reserve(input("one.testnet", "plot-b", "b")),
      "ACTIVE_JOB",
    );
    expectLimit(
      () => ledger.reserve(input("two.testnet", "plot-a", "b")),
      "QUOTA",
    );
    assert.equal(ledger.cancel(first.id)?.status, "cancelled");
    const second = ledger.reserve(input("one.testnet", "plot-b", "b"));
    assert.equal(second.status, "queued");
    ledger.cancel(second.id);
    expectLimit(
      () => ledger.reserve(input("one.testnet", "plot-c", "c")),
      "QUOTA",
    );
    assert.deepEqual(ledger.day(1), {
      reservedCalls: 0,
      chargedCalls: 0,
      reservedUsdMicros: 0,
      chargedUsdMicros: 0,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("global currency reservations survive restart and cancellation releases only unused capacity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-ledger-"));
  const dbPath = join(dir, "estate.sqlite");
  const firstStore = new ApiStore(dbPath, join(dir, "assets"));
  let firstId: string;
  try {
    const ledger = new PaidGenerationLedger(firstStore.db, settings("4000000"));
    const first = ledger.reserve(input("one.testnet", "plot-a", "a"));
    firstId = first.id;
    assert.equal(ledger.day(1).reservedUsdMicros, 4_000_000);
  } finally {
    firstStore.close();
  }
  const secondStore = new ApiStore(dbPath, join(dir, "assets"));
  try {
    const ledger = new PaidGenerationLedger(
      secondStore.db,
      settings("4000000"),
    );
    assert.equal(ledger.job(firstId!)?.status, "queued");
    expectLimit(
      () => ledger.reserve(input("two.testnet", "plot-b", "b")),
      "BUDGET",
    );
    assert.equal(ledger.cancel(firstId!)?.status, "cancelled");
    assert.equal(ledger.day(1).reservedCalls, 0);
    assert.equal(
      ledger.reserve(input("two.testnet", "plot-b", "b")).status,
      "queued",
    );
    assert.equal(
      ledger.reserve(input("one.testnet", "plot-c", "c", 172_801)).utcDay,
      2,
    );
  } finally {
    secondStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider token usage survives restart and identical result replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-ledger-"));
  const dbPath = join(dir, "estate.sqlite");
  const usage = {
    inputTokens: 15,
    outputTokens: 150,
    totalTokens: 165,
    inputImageTokens: 0,
    inputTextTokens: 15,
    outputImageTokens: 150,
    outputTextTokens: 0,
  };
  let jobId: string;
  let clientRequestId: string;
  const firstStore = new ApiStore(dbPath, join(dir, "assets"));
  try {
    const ledger = new PaidGenerationLedger(firstStore.db, settings());
    jobId = ledger.reserve(input("one.testnet", "plot-a", "a")).id;
    ledger.claim("worker_a", 86_402);
    clientRequestId = ledger.beginAttempt(
      jobId,
      "worker_a",
      86_403,
    ).clientRequestId;
    const result = {
      jobId,
      workerId: "worker_a",
      clientRequestId,
      providerRequestId: "provider_123",
      outcome: "rejected" as const,
      usage,
      now: 86_404,
    };
    ledger.finishAttempt(result);
    assert.deepEqual(ledger.attempts(jobId)[0]?.usage, usage);
    ledger.finishAttempt(result);
    assert.throws(() =>
      ledger.finishAttempt({
        ...result,
        usage: { ...usage, outputTokens: -1 },
      }),
    );
  } finally {
    firstStore.close();
  }
  const secondStore = new ApiStore(dbPath, join(dir, "assets"));
  try {
    const ledger = new PaidGenerationLedger(secondStore.db, settings());
    assert.deepEqual(ledger.attempts(jobId!)[0]?.usage, usage);
  } finally {
    secondStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing paid-attempt tables gain nullable token usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-ledger-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  try {
    store.db.exec(`
      CREATE TABLE paid_generation_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        client_request_id TEXT NOT NULL UNIQUE,
        provider_request_id TEXT,
        status TEXT NOT NULL,
        asset_hash TEXT,
        resolution_note TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE(job_id, attempt_no)
      ) STRICT;
    `);
    new PaidGenerationLedger(store.db, settings());
    const columns = store.db
      .prepare("PRAGMA table_info(paid_generation_attempts)")
      .all() as {
      name: string;
    }[];
    assert(columns.some((column) => column.name === "usage_json"));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("global sixty-call cap applies even when the currency budget is larger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-ledger-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  try {
    const inviteAccounts = Array.from(
      { length: 16 },
      (_, index) => `member${index}.testnet`,
    );
    const enabled = {
      ...settings("100000000"),
      invites: new Set(inviteAccounts),
    };
    const ledger = new PaidGenerationLedger(store.db, enabled);
    for (let index = 0; index < 15; index++)
      ledger.reserve(
        input(inviteAccounts[index]!, `plot-${index}`, `key${index}`),
      );
    assert.equal(ledger.day(1).reservedCalls, 60);
    expectLimit(
      () => ledger.reserve(input(inviteAccounts[15]!, "plot-15", "key15")),
      "BUDGET",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("leases allow two workers, persist attempt IDs before calls, and cap paid attempts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-ledger-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  try {
    const ledger = new PaidGenerationLedger(store.db, settings("12000000"));
    const first = ledger.reserve(input("one.testnet", "plot-a", "a"));
    const second = ledger.reserve(input("two.testnet", "plot-b", "b"));
    const third = ledger.reserve(input("three.testnet", "plot-c", "c"));
    assert.equal(ledger.claim("worker_a", 86_402)?.id, first.id);
    assert.equal(ledger.claim("worker_b", 86_402)?.id, second.id);
    assert.equal(ledger.claim("worker_c", 86_402), null);
    const attempt1 = ledger.beginAttempt(first.id, "worker_a", 86_403);
    assert.match(attempt1.clientRequestId, /^[0-9a-f-]{36}$/);
    assert.equal(ledger.day(1).chargedCalls, 1);
    assert.equal(ledger.day(1).reservedCalls, 11);
    assert.throws(() => ledger.beginAttempt(first.id, "worker_a", 86_404));
    const rejected = ledger.finishAttempt({
      jobId: first.id,
      workerId: "worker_a",
      clientRequestId: attempt1.clientRequestId,
      outcome: "rejected",
      now: 86_405,
    });
    assert.equal(rejected.status, "leased");
    assert.equal(
      ledger.finishAttempt({
        jobId: first.id,
        workerId: "worker_a",
        clientRequestId: attempt1.clientRequestId,
        outcome: "rejected",
        now: 86_405,
      }).attemptsStarted,
      1,
    );
    assert.throws(() =>
      ledger.finishAttempt({
        jobId: first.id,
        workerId: "worker_a",
        clientRequestId: attempt1.clientRequestId,
        outcome: "uncertain",
        now: 86_405,
      }),
    );
    const attempt2 = ledger.beginAttempt(first.id, "worker_a", 86_406);
    const accepted = ledger.finishAttempt({
      jobId: first.id,
      workerId: "worker_a",
      clientRequestId: attempt2.clientRequestId,
      outcome: "accepted",
      candidate: candidate("b"),
      now: 86_407,
    });
    assert.equal(accepted.acceptedCount, 1);
    assert.equal(ledger.claim("worker_c", 86_408), null);
    const attempt3 = ledger.beginAttempt(first.id, "worker_a", 86_408);
    ledger.finishAttempt({
      jobId: first.id,
      workerId: "worker_a",
      clientRequestId: attempt3.clientRequestId,
      outcome: "accepted",
      candidate: candidate("c"),
      now: 86_409,
    });
    const attempt4 = ledger.beginAttempt(first.id, "worker_a", 86_410);
    const partial = ledger.finishAttempt({
      jobId: first.id,
      workerId: "worker_a",
      clientRequestId: attempt4.clientRequestId,
      outcome: "rejected",
      now: 86_411,
    });
    assert.equal(partial.status, "complete");
    assert.equal(partial.acceptedCount, 2);
    assert.deepEqual(
      ledger.candidates(first.id).map((entry) => entry.manifestHash),
      [candidate("b").manifestHash, candidate("c").manifestHash],
    );
    assert.equal(ledger.pendingCandidateReviews(20).length, 2);
    assert.equal(
      ledger.canReadCandidateAsset(candidate("b").spriteHash, "one.testnet"),
      false,
    );
    const rejectedCandidate = ledger.reviewCandidate({
      jobId: first.id,
      ordinal: 1,
      decision: "rejected",
      reason: "Perspective does not match the street",
      reviewer: "reviewer",
      now: 86_412,
    });
    assert.equal(rejectedCandidate.reviewStatus, "rejected");
    assert.equal(
      rejectedCandidate.reviewReason,
      "Perspective does not match the street",
    );
    const approvedCandidate = ledger.reviewCandidate({
      jobId: first.id,
      ordinal: 2,
      decision: "approved",
      reason: null,
      reviewer: "reviewer",
      now: 86_413,
    });
    assert.equal(approvedCandidate.reviewStatus, "approved");
    assert.equal(approvedCandidate.reviewedBy, "reviewer");
    assert.equal(ledger.pendingCandidateReviews(20).length, 0);
    assert.equal(
      ledger.canReadCandidateAsset(candidate("b").spriteHash, "one.testnet"),
      false,
    );
    assert.equal(
      ledger.canReadCandidateAsset(candidate("c").spriteHash, "one.testnet"),
      true,
    );
    assert.throws(() =>
      ledger.reviewCandidate({
        jobId: first.id,
        ordinal: 2,
        decision: "approved",
        reason: null,
        reviewer: "reviewer",
        now: 86_414,
      }),
    );
    assert.equal(partial.reservedCalls, 0);
    assert.equal(ledger.claim("worker_c", 86_412)?.id, third.id);
    assert.throws(() => ledger.beginAttempt(first.id, "worker_a", 86_413));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an expired idle lease is safely reclaimed without charging a call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-ledger-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  try {
    const ledger = new PaidGenerationLedger(store.db, settings());
    const job = ledger.reserve(input("one.testnet", "plot-a", "a"));
    const lease = ledger.claim("worker_a", 86_402);
    assert.equal(lease?.id, job.id);
    assert.equal(ledger.sweepExpired(86_583), 1);
    assert.equal(ledger.job(job.id)?.status, "queued");
    assert.equal(ledger.day(1).chargedCalls, 0);
    assert.equal(ledger.claim("worker_b", 86_584)?.id, job.id);
    assert.equal(
      ledger.renewLease(job.id, "worker_b", 86_585).status,
      "leased",
    );
    assert.throws(() => ledger.beginAttempt(job.id, "worker_a", 86_586));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("expired in-flight attempt stays uncertain across restart until manual reconciliation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-ledger-"));
  const dbPath = join(dir, "estate.sqlite");
  const firstStore = new ApiStore(dbPath, join(dir, "assets"));
  let jobId: string;
  let clientRequestId: string;
  try {
    const ledger = new PaidGenerationLedger(firstStore.db, settings());
    jobId = ledger.reserve(input("one.testnet", "plot-a", "a")).id;
    ledger.claim("worker_a", 86_402);
    clientRequestId = ledger.beginAttempt(
      jobId,
      "worker_a",
      86_403,
    ).clientRequestId;
  } finally {
    firstStore.close();
  }
  const secondStore = new ApiStore(dbPath, join(dir, "assets"));
  try {
    const ledger = new PaidGenerationLedger(secondStore.db, settings());
    assert.equal(ledger.sweepExpired(86_583), 1);
    assert.equal(ledger.job(jobId!)?.status, "uncertain");
    assert.equal(ledger.attempts(jobId!)[0]?.status, "uncertain");
    assert.equal(ledger.claim("worker_b", 86_584), null);
    assert.equal(ledger.day(1).chargedCalls, 1);
    assert.throws(() =>
      ledger.resolveUncertain({
        jobId: jobId!,
        clientRequestId: clientRequestId!,
        outcome: "confirmed_not_received",
        note: "",
        now: 86_585,
      }),
    );
    const requeued = ledger.resolveUncertain({
      jobId: jobId!,
      clientRequestId: clientRequestId!,
      outcome: "confirmed_not_received",
      note: "Provider support confirmed no request was received",
      now: 86_585,
    });
    assert.equal(requeued.status, "queued");
    assert.equal(ledger.day(1).chargedCalls, 0);
    assert.equal(ledger.claim("worker_b", 86_586)?.id, jobId!);
    assert.equal(ledger.beginAttempt(jobId!, "worker_b", 86_587).attemptNo, 2);
  } finally {
    secondStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("attempts retain the original cost ceiling after operator settings change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-ledger-"));
  const dbPath = join(dir, "estate.sqlite");
  const firstStore = new ApiStore(dbPath, join(dir, "assets"));
  let jobId: string;
  try {
    const ledger = new PaidGenerationLedger(firstStore.db, settings("8000000"));
    jobId = ledger.reserve(input("one.testnet", "plot-a", "a")).id;
  } finally {
    firstStore.close();
  }
  const secondStore = new ApiStore(dbPath, join(dir, "assets"));
  try {
    const changed = {
      ...settings("8000000"),
      maxCostPerCallUsdMicros: 500_000,
    };
    const ledger = new PaidGenerationLedger(secondStore.db, changed);
    ledger.claim("worker_a", 86_402);
    const attempt = ledger.beginAttempt(jobId!, "worker_a", 86_403);
    assert.equal(ledger.job(jobId!)?.costCeilingUsdMicros, 1_000_000);
    assert.equal(ledger.day(1).chargedUsdMicros, 1_000_000);
    ledger.finishAttempt({
      jobId: jobId!,
      workerId: "worker_a",
      clientRequestId: attempt.clientRequestId,
      outcome: "uncertain",
      now: 86_404,
    });
    ledger.resolveUncertain({
      jobId: jobId!,
      clientRequestId: attempt.clientRequestId,
      outcome: "confirmed_not_received",
      note: "Provider support confirmed no request was received",
      now: 86_405,
    });
    assert.equal(ledger.day(1).chargedUsdMicros, 0);
  } finally {
    secondStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy reservations without a saved prompt are cancelled during migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-ledger-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  try {
    store.db.exec(`
      CREATE TABLE paid_generation_days (
        utc_day INTEGER PRIMARY KEY,
        reserved_calls INTEGER NOT NULL,
        charged_calls INTEGER NOT NULL,
        reserved_usd_micros INTEGER NOT NULL,
        charged_usd_micros INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE paid_generation_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        plot_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        utc_day INTEGER NOT NULL REFERENCES paid_generation_days(utc_day),
        status TEXT NOT NULL,
        reserved_calls INTEGER NOT NULL,
        charged_calls INTEGER NOT NULL,
        reserved_usd_micros INTEGER NOT NULL,
        charged_usd_micros INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(account_id, idempotency_key)
      ) STRICT;
      INSERT INTO paid_generation_days VALUES (1, 4, 0, 4000000, 0);
      INSERT INTO paid_generation_jobs VALUES
        ('legacy-job', 'one.testnet', 'plot-a', 'legacy-key',
         '${"a".repeat(64)}', 1, 'queued', 4, 0, 4000000, 0, 86401);
    `);
    const ledger = new PaidGenerationLedger(store.db, settings());
    assert.equal(ledger.job("legacy-job")?.status, "cancelled");
    assert.equal(ledger.day(1).reservedUsdMicros, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancellation and supersession wait for in-flight outcome and release unused reservations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-ledger-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  try {
    const ledger = new PaidGenerationLedger(store.db, settings());
    const job = ledger.reserve(input("one.testnet", "plot-a", "a"));
    ledger.claim("worker_a", 86_402);
    const attempt = ledger.beginAttempt(job.id, "worker_a", 86_403);
    assert.equal(ledger.supersede(job.id)?.stopReason, "superseded");
    assert.equal(ledger.day(1).reservedCalls, 3);
    const stopped = ledger.finishAttempt({
      jobId: job.id,
      workerId: "worker_a",
      clientRequestId: attempt.clientRequestId,
      outcome: "rejected",
      now: 86_404,
    });
    assert.equal(stopped.status, "superseded");
    assert.equal(ledger.day(1).reservedCalls, 0);
    assert.equal(ledger.day(1).chargedCalls, 1);
    assert.equal(ledger.cancel(job.id)?.status, "superseded");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
