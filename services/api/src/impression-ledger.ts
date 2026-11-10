import { DatabaseSync } from "node:sqlite";
import { IMPRESSION_RULES, type ImpressionEvent } from "@estate/shared";

export class ImpressionError extends Error {
  constructor(
    readonly code:
      | "INVALID_EVENT"
      | "CONFLICT"
      | "RATE_LIMITED"
      | "SESSION_EXPIRED",
    message: string,
  ) {
    super(message);
  }
}

type StoredEvent = {
  session_hash: string;
  plot_id: string;
  surface: string;
  observed_at_ms: number;
  ms_visible: number;
};

export class ImpressionLedger {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS impression_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS impression_session_created
        ON impression_sessions(created_at);
      CREATE INDEX IF NOT EXISTS impression_session_expiry
        ON impression_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS impression_events (
        event_id TEXT PRIMARY KEY,
        session_hash TEXT NOT NULL REFERENCES impression_sessions(token_hash),
        plot_id TEXT NOT NULL,
        surface TEXT NOT NULL CHECK (surface IN ('Logo', 'Billboard')),
        observed_at_ms INTEGER NOT NULL,
        minute_ms INTEGER NOT NULL,
        ms_visible INTEGER NOT NULL,
        credited_ms INTEGER NOT NULL,
        counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
        received_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS impression_session_received
        ON impression_events(session_hash, received_at_ms);
      CREATE TABLE IF NOT EXISTS impression_minutes (
        session_hash TEXT NOT NULL REFERENCES impression_sessions(token_hash),
        plot_id TEXT NOT NULL,
        minute_ms INTEGER NOT NULL,
        dwell_ms INTEGER NOT NULL,
        impressions INTEGER NOT NULL CHECK (impressions IN (0, 1)),
        PRIMARY KEY (session_hash, plot_id, minute_ms)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS impression_daily_stats (
        plot_id TEXT NOT NULL,
        day TEXT NOT NULL,
        impressions INTEGER NOT NULL,
        dwell_ms INTEGER NOT NULL,
        PRIMARY KEY (plot_id, day)
      ) STRICT;
    `);
  }

  issueSession(tokenHash: string, nowSeconds: number): number {
    const expiresAt = nowSeconds + IMPRESSION_RULES.sessionTtlSeconds;
    this.db
      .prepare(
        "INSERT INTO impression_sessions(token_hash, created_at, expires_at) VALUES (?, ?, ?)",
      )
      .run(tokenHash, nowSeconds, expiresAt);
    return expiresAt;
  }

  recentSessionTotal(since: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM impression_sessions WHERE created_at >= ?",
      )
      .get(since) as { count: number };
    return row.count;
  }

  pruneExpiredSessions(nowSeconds: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const expired =
        "SELECT token_hash FROM impression_sessions WHERE expires_at <= ?";
      this.db
        .prepare(
          `DELETE FROM impression_events WHERE session_hash IN (${expired})`,
        )
        .run(nowSeconds);
      this.db
        .prepare(
          `DELETE FROM impression_minutes WHERE session_hash IN (${expired})`,
        )
        .run(nowSeconds);
      this.db
        .prepare("DELETE FROM impression_sessions WHERE expires_at <= ?")
        .run(nowSeconds);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  sessionExpiry(tokenHash: string, nowSeconds: number): number | null {
    const row = this.db
      .prepare(
        "SELECT expires_at FROM impression_sessions WHERE token_hash = ? AND expires_at > ?",
      )
      .get(tokenHash, nowSeconds) as { expires_at: number } | undefined;
    return row?.expires_at ?? null;
  }

  private storedEvent(eventId: string): StoredEvent | null {
    return (
      (this.db
        .prepare(
          "SELECT session_hash, plot_id, surface, observed_at_ms, ms_visible FROM impression_events WHERE event_id = ?",
        )
        .get(eventId) as StoredEvent | undefined) ?? null
    );
  }

  private sameEvent(
    stored: StoredEvent,
    tokenHash: string,
    event: ImpressionEvent,
  ): boolean {
    return (
      stored.session_hash === tokenHash &&
      stored.plot_id === event.plotId &&
      stored.surface === event.surface &&
      stored.observed_at_ms === event.observedAt &&
      stored.ms_visible === event.msVisible
    );
  }

  newPlotSurfaces(
    tokenHash: string,
    events: ImpressionEvent[],
    nowSeconds: number,
  ): Array<{ plotId: string; surface: ImpressionEvent["surface"] }> {
    const surfaces = new Map<
      string,
      { plotId: string; surface: ImpressionEvent["surface"] }
    >();
    const nowMs = nowSeconds * 1_000;
    const freshIds = new Set<string>();
    for (const event of events) {
      const existing = this.storedEvent(event.eventId);
      if (existing) {
        if (!this.sameEvent(existing, tokenHash, event))
          throw new ImpressionError(
            "CONFLICT",
            "Event ID was reused with different data",
          );
      } else {
        if (
          event.observedAt < nowMs - IMPRESSION_RULES.maxEventAgeMs ||
          event.observedAt > nowMs + IMPRESSION_RULES.maxFutureSkewMs
        )
          throw new ImpressionError(
            "INVALID_EVENT",
            "Impression event is stale or in the future",
          );
        freshIds.add(event.eventId);
        surfaces.set(`${event.plotId}:${event.surface}`, {
          plotId: event.plotId,
          surface: event.surface,
        });
      }
    }
    const recent = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM impression_events WHERE session_hash = ? AND received_at_ms >= ?",
      )
      .get(tokenHash, nowMs - 60_000) as { count: number };
    const daily = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM impression_events WHERE session_hash = ? AND received_at_ms >= ?",
      )
      .get(tokenHash, Math.floor(nowMs / 86_400_000) * 86_400_000) as {
      count: number;
    };
    if (
      recent.count + freshIds.size >
        IMPRESSION_RULES.maxEventsPerSessionMinute ||
      daily.count + freshIds.size > IMPRESSION_RULES.maxEventsPerSessionDay
    )
      throw new ImpressionError(
        "RATE_LIMITED",
        "Impression session limit reached",
      );
    return [...surfaces.values()];
  }

  recordBatch(
    tokenHash: string,
    events: ImpressionEvent[],
    nowSeconds: number,
  ): {
    stored: number;
    duplicates: number;
    impressions: number;
    dwellMs: number;
  } {
    const nowMs = nowSeconds * 1_000;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.sessionExpiry(tokenHash, nowSeconds))
        throw new ImpressionError(
          "SESSION_EXPIRED",
          "Impression session expired",
        );
      let lastMinuteCount = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM impression_events WHERE session_hash = ? AND received_at_ms >= ?",
          )
          .get(tokenHash, nowMs - 60_000) as { count: number }
      ).count;
      let dailyCount = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM impression_events WHERE session_hash = ? AND received_at_ms >= ?",
          )
          .get(tokenHash, Math.floor(nowMs / 86_400_000) * 86_400_000) as {
          count: number;
        }
      ).count;
      let stored = 0;
      let duplicates = 0;
      let impressions = 0;
      let dwellMs = 0;
      for (const event of events) {
        const existing = this.storedEvent(event.eventId);
        if (existing) {
          if (!this.sameEvent(existing, tokenHash, event))
            throw new ImpressionError(
              "CONFLICT",
              "Event ID was reused with different data",
            );
          duplicates++;
          continue;
        }
        if (
          event.observedAt < nowMs - IMPRESSION_RULES.maxEventAgeMs ||
          event.observedAt > nowMs + IMPRESSION_RULES.maxFutureSkewMs
        )
          throw new ImpressionError(
            "INVALID_EVENT",
            "Impression event is stale or in the future",
          );
        if (
          ++lastMinuteCount > IMPRESSION_RULES.maxEventsPerSessionMinute ||
          ++dailyCount > IMPRESSION_RULES.maxEventsPerSessionDay
        )
          throw new ImpressionError(
            "RATE_LIMITED",
            "Impression session limit reached",
          );
        const minuteMs = Math.floor(event.observedAt / 60_000) * 60_000;
        const day = new Date(event.observedAt).toISOString().slice(0, 10);
        const previous = this.db
          .prepare(
            "SELECT dwell_ms, impressions FROM impression_minutes WHERE session_hash = ? AND plot_id = ? AND minute_ms = ?",
          )
          .get(tokenHash, event.plotId, minuteMs) as
          | { dwell_ms: number; impressions: number }
          | undefined;
        const currentDwell = previous?.dwell_ms ?? 0;
        const credited = Math.min(
          event.msVisible,
          Math.max(0, IMPRESSION_RULES.maxDwellPerPlotMinuteMs - currentDwell),
        );
        const counted =
          !previous?.impressions &&
          event.msVisible >= IMPRESSION_RULES.visibleThresholdMs
            ? 1
            : 0;
        this.db
          .prepare(
            "INSERT INTO impression_events(event_id, session_hash, plot_id, surface, observed_at_ms, minute_ms, ms_visible, credited_ms, counted, received_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            event.eventId,
            tokenHash,
            event.plotId,
            event.surface,
            event.observedAt,
            minuteMs,
            event.msVisible,
            credited,
            counted,
            nowMs,
          );
        this.db
          .prepare(
            "INSERT INTO impression_minutes(session_hash, plot_id, minute_ms, dwell_ms, impressions) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_hash, plot_id, minute_ms) DO UPDATE SET dwell_ms = dwell_ms + excluded.dwell_ms, impressions = impressions + excluded.impressions",
          )
          .run(tokenHash, event.plotId, minuteMs, credited, counted);
        this.db
          .prepare(
            "INSERT INTO impression_daily_stats(plot_id, day, impressions, dwell_ms) VALUES (?, ?, ?, ?) ON CONFLICT(plot_id, day) DO UPDATE SET impressions = impressions + excluded.impressions, dwell_ms = dwell_ms + excluded.dwell_ms",
          )
          .run(event.plotId, day, counted, credited);
        stored++;
        impressions += counted;
        dwellMs += credited;
      }
      this.db.exec("COMMIT");
      return { stored, duplicates, impressions, dwellMs };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
