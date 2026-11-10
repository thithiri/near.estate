import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readImageGenerationSettings } from "./image-generation-settings.js";
import { PaidGenerationLedger } from "./paid-generation-ledger.js";
import { buildGenerationPrompt } from "./prompt-builder.js";
import { reconcileUncertainCommand } from "./reconcile-uncertain.js";
import { ApiStore } from "./store.js";

const env = {
  IMAGE_GENERATION_ENABLED: "true",
  IMAGE_GENERATION_INVITES: "owner.testnet",
  IMAGE_GENERATION_DAILY_BUDGET_USD_MICROS: "8000000",
  IMAGE_GENERATION_MAX_COST_PER_CALL_USD_MICROS: "1000000",
  IMAGE_GENERATION_TIMEOUT_MS: "120000",
  IMAGE_GENERATION_SAFETY_SECRET: "test-secret-with-at-least-thirty-two-bytes",
  OPENAI_API_KEY: "test-api-key",
  OPENAI_IMAGE_MODEL: "test-model",
};

test("offline reconciliation shows the held attempt and records provider evidence once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-reconcile-"));
  const store = new ApiStore(join(dir, "estate.sqlite"), join(dir, "assets"));
  try {
    const settings = readImageGenerationSettings(env);
    assert.equal(settings.enabled, true);
    if (!settings.enabled) throw new Error("Test settings disabled");
    const ledger = new PaidGenerationLedger(store.db, settings);
    const job = ledger.reserve({
      accountId: "owner.testnet",
      plotId: "plot-main-n-0",
      idempotencyKey: "a".repeat(16),
      snapshot: {
        buildingType: "Cafe",
        level: 1,
        layoutRevision: 1,
        appearanceRevision: 1,
        promptSpec: buildGenerationPrompt({
          buildingType: "Cafe",
          level: 1,
          variant: 1,
          palette: "#73D9A6",
          description: "A leafy cafe",
        }),
      },
      now: 86_401,
    });
    assert.equal(ledger.claim("worker", 86_402)?.id, job.id);
    const attempt = ledger.beginAttempt(job.id, "worker", 86_403);
    ledger.finishAttempt({
      jobId: job.id,
      workerId: "worker",
      clientRequestId: attempt.clientRequestId,
      providerRequestId: "provider_123",
      outcome: "uncertain",
      now: 86_404,
    });
    store.close();

    const target = [dir, job.id, attempt.clientRequestId];
    assert.deepEqual(reconcileUncertainCommand(["--plan", ...target], env), {
      mode: "plan",
      jobId: job.id,
      clientRequestId: attempt.clientRequestId,
      providerRequestId: "provider_123",
      attemptNo: 1,
      chargedCalls: 1,
      chargedUsdMicros: 1_000_000,
      costCeilingUsdMicros: 1_000_000,
    });
    assert.throws(() =>
      reconcileUncertainCommand(
        ["--apply", ...target, "confirmed_not_received", ""],
        env,
      ),
    );
    assert.throws(() =>
      reconcileUncertainCommand(
        [
          "--apply",
          ...target,
          "confirmed_charged",
          "Provider charge confirmed",
        ],
        env,
      ),
    );
    assert.throws(() =>
      reconcileUncertainCommand(
        [
          "--apply",
          dir,
          job.id,
          "wrong-id",
          "confirmed_charged",
          "Evidence checked",
        ],
        env,
      ),
    );
    const applied = reconcileUncertainCommand(
      [
        "--apply",
        ...target,
        "confirmed_not_received",
        "Provider support confirmed no request or charge",
      ],
      { ...env, ESTATE_RECONCILE_OFFLINE: "true" },
      86_405,
    );
    assert.equal(applied.jobStatus, "queued");
    assert.equal(applied.chargedCalls, 0);
    assert.throws(() => reconcileUncertainCommand(["--plan", ...target], env));

    const reopened = new ApiStore(
      join(dir, "estate.sqlite"),
      join(dir, "assets"),
    );
    try {
      assert.equal(
        reopened.db
          .prepare(
            "SELECT charged_calls FROM paid_generation_days WHERE utc_day = 1",
          )
          .get()?.charged_calls,
        0,
      );
      const resolved = reopened.db
        .prepare(
          "SELECT status, resolution_note FROM paid_generation_attempts WHERE client_request_id = ?",
        )
        .get(attempt.clientRequestId);
      assert.equal(resolved?.status, "confirmed_not_received");
      assert.equal(
        resolved?.resolution_note,
        "Provider support confirmed no request or charge",
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a confirmed provider charge keeps the conservative debit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-reconcile-charged-"));
  const store = new ApiStore(join(dir, "estate.sqlite"), join(dir, "assets"));
  try {
    const settings = readImageGenerationSettings(env);
    if (!settings.enabled) throw new Error("Test settings disabled");
    const ledger = new PaidGenerationLedger(store.db, settings);
    const job = ledger.reserve({
      accountId: "owner.testnet",
      plotId: "plot-main-n-1",
      idempotencyKey: "b".repeat(16),
      snapshot: {
        buildingType: "Cafe",
        level: 1,
        layoutRevision: 1,
        appearanceRevision: 1,
        promptSpec: buildGenerationPrompt({
          buildingType: "Cafe",
          level: 1,
          variant: 1,
          palette: "#73D9A6",
          description: "A leafy cafe",
        }),
      },
      now: 86_401,
    });
    ledger.claim("worker", 86_402);
    const attempt = ledger.beginAttempt(job.id, "worker", 86_403);
    ledger.finishAttempt({
      jobId: job.id,
      workerId: "worker",
      clientRequestId: attempt.clientRequestId,
      outcome: "uncertain",
      now: 86_404,
    });
    store.close();

    const result = reconcileUncertainCommand(
      [
        "--apply",
        dir,
        job.id,
        attempt.clientRequestId,
        "confirmed_charged",
        "Provider billing record confirms this request was charged",
      ],
      { ...env, ESTATE_RECONCILE_OFFLINE: "true" },
      86_405,
    );
    assert.equal(result.jobStatus, "queued");
    assert.equal(result.chargedCalls, 1);
    assert.equal(result.chargedUsdMicros, 1_000_000);
    const reopened = new ApiStore(
      join(dir, "estate.sqlite"),
      join(dir, "assets"),
    );
    try {
      assert.equal(
        reopened.db
          .prepare(
            "SELECT charged_calls FROM paid_generation_days WHERE utc_day = 1",
          )
          .get()?.charged_calls,
        1,
      );
      assert.equal(
        reopened.db
          .prepare(
            "SELECT status FROM paid_generation_attempts WHERE client_request_id = ?",
          )
          .get(attempt.clientRequestId)?.status,
        "confirmed_charged",
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
