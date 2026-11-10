import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ImpressionError, ImpressionLedger } from "./impression-ledger.js";

const NOW = 1_800_000;
const PLOT = "plot-main-n-0";

test("duplicate batches count once and dwell is capped per plot and minute", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const ledger = new ImpressionLedger(db);
    ledger.issueSession("session-a", NOW);
    const first = {
      eventId: randomUUID(),
      plotId: PLOT,
      surface: "Billboard" as const,
      observedAt: NOW * 1_000 - 5_000,
      msVisible: 40_000,
    };
    const second = {
      ...first,
      eventId: randomUUID(),
      observedAt: NOW * 1_000 - 4_000,
    };
    assert.deepEqual(ledger.recordBatch("session-a", [first, second], NOW), {
      stored: 2,
      duplicates: 0,
      impressions: 1,
      dwellMs: 60_000,
    });
    assert.deepEqual(ledger.recordBatch("session-a", [first, second], NOW), {
      stored: 0,
      duplicates: 2,
      impressions: 0,
      dwellMs: 0,
    });
    const daily = db
      .prepare(
        "SELECT impressions, dwell_ms FROM impression_daily_stats WHERE plot_id = ?",
      )
      .get(PLOT) as { impressions: number; dwell_ms: number };
    assert.deepEqual({ ...daily }, { impressions: 1, dwell_ms: 60_000 });
    const nextMinute = {
      ...first,
      eventId: randomUUID(),
      observedAt: NOW * 1_000 + 1_000,
      msVisible: 1_500,
    };
    assert.equal(
      ledger.recordBatch("session-a", [nextMinute], NOW + 2).impressions,
      1,
    );
    assert.equal(
      (
        db
          .prepare(
            "SELECT impressions FROM impression_daily_stats WHERE plot_id = ?",
          )
          .get(PLOT) as { impressions: number }
      ).impressions,
      2,
    );
    assert.throws(
      () =>
        ledger.recordBatch("session-a", [{ ...first, msVisible: 39_000 }], NOW),
      (error: unknown) =>
        error instanceof ImpressionError && error.code === "CONFLICT",
    );
  } finally {
    db.close();
  }
});

test("session event rate limit rejects overflow without changing totals", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const ledger = new ImpressionLedger(db);
    ledger.issueSession("session-a", NOW);
    const events = Array.from({ length: 61 }, () => ({
      eventId: randomUUID(),
      plotId: PLOT,
      surface: "Logo" as const,
      observedAt: NOW * 1_000 - 1_000,
      msVisible: 1,
    }));
    for (let offset = 0; offset < 60; offset += 20)
      ledger.recordBatch("session-a", events.slice(offset, offset + 20), NOW);
    assert.throws(
      () => ledger.recordBatch("session-a", events.slice(60), NOW),
      (error: unknown) =>
        error instanceof ImpressionError && error.code === "RATE_LIMITED",
    );
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS count FROM impression_events").get() as {
          count: number;
        }
      ).count,
      60,
    );
  } finally {
    db.close();
  }
});

test("stale event rejects the entire batch without partial counts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const ledger = new ImpressionLedger(db);
    ledger.issueSession("session-a", NOW);
    const good = {
      eventId: randomUUID(),
      plotId: PLOT,
      surface: "Logo" as const,
      observedAt: NOW * 1_000 - 2_000,
      msVisible: 1_200,
    };
    const stale = {
      ...good,
      eventId: randomUUID(),
      observedAt: NOW * 1_000 - 301_000,
    };
    assert.throws(
      () => ledger.recordBatch("session-a", [good, stale], NOW),
      (error: unknown) =>
        error instanceof ImpressionError && error.code === "INVALID_EVENT",
    );
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS count FROM impression_events").get() as {
          count: number;
        }
      ).count,
      0,
    );
  } finally {
    db.close();
  }
});

test("expired anonymous sessions release raw rows while keeping daily totals", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const ledger = new ImpressionLedger(db);
    ledger.issueSession("session-a", NOW);
    ledger.recordBatch(
      "session-a",
      [
        {
          eventId: randomUUID(),
          plotId: PLOT,
          surface: "Logo",
          observedAt: NOW * 1_000 - 1_000,
          msVisible: 1_200,
        },
      ],
      NOW,
    );
    ledger.pruneExpiredSessions(NOW + 86_400);
    assert.equal(ledger.recentSessionTotal(NOW), 0);
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS count FROM impression_events").get() as {
          count: number;
        }
      ).count,
      0,
    );
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM impression_minutes")
          .get() as { count: number }
      ).count,
      0,
    );
    const daily = db
      .prepare(
        "SELECT impressions, dwell_ms FROM impression_daily_stats WHERE plot_id = ?",
      )
      .get(PLOT) as { impressions: number; dwell_ms: number };
    assert.deepEqual({ ...daily }, { impressions: 1, dwell_ms: 1_200 });
  } finally {
    db.close();
  }
});
