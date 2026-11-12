import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export type DeedMove = { from: string; to: string };

const PLOT_ID = /^plot-(main|market|river|central|harbor)-(n|s)-[0-9]$/;

function requireTable(db: DatabaseSync, name: string): void {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)
  )
    throw new Error(`Deed history needs the ${name} table`);
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

type DailyTotals = {
  impressions: number;
  dwellMs: number;
  parks: number;
  tickets: number;
};

function dailyTotals(
  db: DatabaseSync,
  plotId: string,
): Map<string, DailyTotals> {
  const rows = new Map<string, DailyTotals>();
  for (const row of db
    .prepare(
      "SELECT day, impressions, dwell_ms FROM impression_daily_stats WHERE plot_id = ?",
    )
    .all(plotId) as Array<{
    day: string;
    impressions: number;
    dwell_ms: number;
  }>)
    rows.set(row.day, {
      impressions: row.impressions,
      dwellMs: row.dwell_ms,
      parks: 0,
      tickets: 0,
    });
  for (const row of db
    .prepare(
      "SELECT day, parks, tickets FROM plot_daily_stats WHERE plot_id = ?",
    )
    .all(plotId) as Array<{ day: string; parks: number; tickets: number }>) {
    const current = rows.get(row.day) ?? {
      impressions: 0,
      dwellMs: 0,
      parks: 0,
      tickets: 0,
    };
    current.parks = row.parks;
    current.tickets = row.tickets;
    rows.set(row.day, current);
  }
  return rows;
}

function createDestinationDaysTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deed_destination_days (
      source_plot_id TEXT NOT NULL REFERENCES deed_history_links(source_plot_id),
      day TEXT NOT NULL,
      impressions INTEGER NOT NULL,
      dwell_ms INTEGER NOT NULL,
      parks INTEGER NOT NULL,
      tickets INTEGER NOT NULL,
      PRIMARY KEY (source_plot_id, day)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS deed_destination_days_no_update
      BEFORE UPDATE ON deed_destination_days
      BEGIN SELECT RAISE(ABORT, 'deed history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS deed_destination_days_no_delete
      BEFORE DELETE ON deed_destination_days
      BEGIN SELECT RAISE(ABORT, 'deed history is immutable'); END;
  `);
}

function validateCutoverInput(
  contractId: string,
  moves: DeedMove[],
  cutoverHeight: number,
  cutoverAtMs: number,
): void {
  if (
    !/^[a-z0-9._-]+\.testnet$/.test(contractId) ||
    !Number.isSafeInteger(cutoverHeight) ||
    cutoverHeight < 1 ||
    !Number.isSafeInteger(cutoverAtMs) ||
    cutoverAtMs < 1 ||
    !moves.length
  )
    throw new Error("Invalid deed-history cutover input");
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const move of moves) {
    if (
      !PLOT_ID.test(move.from) ||
      !PLOT_ID.test(move.to) ||
      move.from === move.to ||
      move.from.slice(0, -1) !== move.to.slice(0, -1) ||
      sources.has(move.from) ||
      targets.has(move.to)
    )
      throw new Error("Invalid or duplicate deed move");
    sources.add(move.from);
    targets.add(move.to);
  }
  if ([...targets].some((target) => sources.has(target)))
    throw new Error("Deed move sources and targets must not overlap");
}

export function captureDeedHistory(
  db: DatabaseSync,
  contractId: string,
  moves: DeedMove[],
  cutoverHeight: number,
  cutoverAtMs: number,
): { cursorHeight: number; links: number; days: number } {
  validateCutoverInput(contractId, moves, cutoverHeight, cutoverAtMs);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of [
      "indexer_state",
      "chain_events",
      "plot_daily_stats",
      "impression_events",
      "impression_daily_stats",
      "media_uploads",
      "media_upload_attempts",
      "media_proposals",
      "generation_jobs",
    ])
      requireTable(db, table);
    const cursor = db
      .prepare(
        "SELECT contract_id, last_height FROM indexer_state WHERE id = 1",
      )
      .get() as { contract_id: string; last_height: number } | undefined;
    if (
      !cursor ||
      cursor.contract_id !== contractId ||
      cursor.last_height < cutoverHeight
    )
      throw new Error("Indexer has not reached the frozen contract block");
    db.exec(`
      CREATE TABLE IF NOT EXISTS deed_history_links (
        source_plot_id TEXT PRIMARY KEY,
        target_plot_id TEXT NOT NULL UNIQUE,
        cutover_height INTEGER NOT NULL,
        cutover_at_ms INTEGER NOT NULL,
        captured_cursor_height INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deed_history_days (
        source_plot_id TEXT NOT NULL REFERENCES deed_history_links(source_plot_id),
        day TEXT NOT NULL,
        impressions INTEGER NOT NULL,
        dwell_ms INTEGER NOT NULL,
        parks INTEGER NOT NULL,
        tickets INTEGER NOT NULL,
        PRIMARY KEY (source_plot_id, day)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deed_history_workflow_rows (
        source_plot_id TEXT NOT NULL REFERENCES deed_history_links(source_plot_id),
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        PRIMARY KEY (source_plot_id, table_name, row_id)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS deed_history_links_no_update
        BEFORE UPDATE ON deed_history_links
        BEGIN SELECT RAISE(ABORT, 'deed history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS deed_history_links_no_delete
        BEFORE DELETE ON deed_history_links
        BEGIN SELECT RAISE(ABORT, 'deed history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS deed_history_days_no_update
        BEFORE UPDATE ON deed_history_days
        BEGIN SELECT RAISE(ABORT, 'deed history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS deed_history_days_no_delete
        BEFORE DELETE ON deed_history_days
        BEGIN SELECT RAISE(ABORT, 'deed history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS deed_history_workflow_rows_no_update
        BEFORE UPDATE ON deed_history_workflow_rows
        BEGIN SELECT RAISE(ABORT, 'deed history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS deed_history_workflow_rows_no_delete
        BEFORE DELETE ON deed_history_workflow_rows
        BEGIN SELECT RAISE(ABORT, 'deed history is immutable'); END;
    `);
    createDestinationDaysTable(db);
    let days = 0;
    for (const move of moves) {
      const laterEvent = db
        .prepare(
          "SELECT 1 FROM chain_events WHERE location_id = ? AND block_height > ? LIMIT 1",
        )
        .get(move.from, cutoverHeight);
      if (laterEvent)
        throw new Error(`Events after the frozen block exist on ${move.from}`);
      const laterImpression = db
        .prepare(
          "SELECT 1 FROM impression_events WHERE plot_id = ? AND received_at_ms > ? LIMIT 1",
        )
        .get(move.from, cutoverAtMs);
      if (laterImpression)
        throw new Error(`Impressions after the cutover exist on ${move.from}`);
      const existing = db
        .prepare(
          "SELECT 1 FROM deed_history_links WHERE source_plot_id = ? OR target_plot_id = ?",
        )
        .get(move.from, move.to);
      if (existing) throw new Error("Deed history was already captured");
      db.prepare("INSERT INTO deed_history_links VALUES (?, ?, ?, ?, ?)").run(
        move.from,
        move.to,
        cutoverHeight,
        cutoverAtMs,
        cursor.last_height,
      );
      for (const [day, row] of dailyTotals(db, move.from)) {
        db.prepare(
          "INSERT INTO deed_history_days VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          move.from,
          day,
          row.impressions,
          row.dwellMs,
          row.parks,
          row.tickets,
        );
        days++;
      }
      for (const [day, row] of dailyTotals(db, move.to))
        db.prepare(
          "INSERT INTO deed_destination_days VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          move.from,
          day,
          row.impressions,
          row.dwellMs,
          row.parks,
          row.tickets,
        );
      // These rows describe the deed and its moderation workflow, rather than
      // physical street activity. Keep raw events and impressions at the old ID.
      const workflowTables = [
        "media_uploads",
        "media_upload_attempts",
        "media_proposals",
        "generation_jobs",
      ];
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'paid_generation_jobs'",
          )
          .get()
      )
        workflowTables.push("paid_generation_jobs");
      for (const table of workflowTables) {
        const occupied = db
          .prepare(`SELECT 1 FROM ${table} WHERE plot_id = ? LIMIT 1`)
          .get(move.to);
        if (occupied)
          throw new Error(
            `Destination ${move.to} already has ${table} records`,
          );
      }
      for (const table of workflowTables) {
        const ids = db
          .prepare(`SELECT id FROM ${table} WHERE plot_id = ?`)
          .all(move.from) as Array<{ id: string }>;
        for (const row of ids)
          db.prepare(
            "INSERT INTO deed_history_workflow_rows VALUES (?, ?, ?)",
          ).run(move.from, table, row.id);
        db.prepare(`UPDATE ${table} SET plot_id = ? WHERE plot_id = ?`).run(
          move.to,
          move.from,
        );
      }
    }
    db.exec("COMMIT");
    return { cursorHeight: cursor.last_height, links: moves.length, days };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Repair a release performed before destination baselines were captured. */
export function backfillDeedDestinationDays(
  db: DatabaseSync,
  frozenDb: DatabaseSync,
  contractId: string,
  moves: DeedMove[],
  cutoverHeight: number,
  cutoverAtMs: number,
): number {
  validateCutoverInput(contractId, moves, cutoverHeight, cutoverAtMs);
  if (hasTable(db, "deed_destination_days"))
    throw new Error("Destination baselines already exist");
  requireTable(db, "deed_history_links");
  for (const table of [
    "indexer_state",
    "chain_events",
    "impression_events",
    "plot_daily_stats",
    "impression_daily_stats",
  ])
    requireTable(frozenDb, table);
  const cursor = frozenDb
    .prepare("SELECT contract_id, last_height FROM indexer_state WHERE id = 1")
    .get() as { contract_id: string; last_height: number } | undefined;
  if (
    !cursor ||
    cursor.contract_id !== contractId ||
    cursor.last_height < cutoverHeight
  )
    throw new Error("Frozen database does not cover the deed cutover");
  const liveLinks = db
    .prepare("SELECT COUNT(*) AS count FROM deed_history_links")
    .get() as { count: number };
  if (liveLinks.count !== moves.length)
    throw new Error("Live deed links differ from the reviewed move map");
  for (const move of moves) {
    const link = db
      .prepare(
        "SELECT cutover_height, cutover_at_ms FROM deed_history_links WHERE source_plot_id = ? AND target_plot_id = ?",
      )
      .get(move.from, move.to) as
      | { cutover_height: number; cutover_at_ms: number }
      | undefined;
    if (
      !link ||
      link.cutover_height !== cutoverHeight ||
      link.cutover_at_ms !== cutoverAtMs
    )
      throw new Error("Live deed link differs from the frozen release");
    if (
      frozenDb
        .prepare(
          "SELECT 1 FROM chain_events WHERE location_id = ? AND block_height > ? LIMIT 1",
        )
        .get(move.to, cutoverHeight) ||
      frozenDb
        .prepare(
          "SELECT 1 FROM impression_events WHERE plot_id = ? AND received_at_ms > ? LIMIT 1",
        )
        .get(move.to, cutoverAtMs)
    )
      throw new Error("Frozen destination has post-cutover activity");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    createDestinationDaysTable(db);
    let days = 0;
    for (const move of moves)
      for (const [day, row] of dailyTotals(frozenDb, move.to)) {
        db.prepare(
          "INSERT INTO deed_destination_days VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          move.from,
          day,
          row.impressions,
          row.dwellMs,
          row.parks,
          row.tickets,
        );
        days++;
      }
    db.exec("COMMIT");
    return days;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function verifyDeedHistoryCutover(
  db: DatabaseSync,
  contractId: string,
  moves: DeedMove[],
  cutoverHeight: number,
  cutoverAtMs: number,
  options: { allowReusedSourceActivity?: boolean } = {},
): {
  cursorHeight: number;
  links: number;
  days: number;
  workflowRowsVerified: number;
} {
  validateCutoverInput(contractId, moves, cutoverHeight, cutoverAtMs);
  for (const table of [
    "indexer_state",
    "deed_history_links",
    "deed_history_days",
    "deed_history_workflow_rows",
    "chain_events",
    "impression_events",
    "media_uploads",
    "media_upload_attempts",
    "media_proposals",
    "generation_jobs",
  ])
    requireTable(db, table);
  const cursor = db
    .prepare("SELECT contract_id, last_height FROM indexer_state WHERE id = 1")
    .get() as { contract_id: string; last_height: number } | undefined;
  if (
    !cursor ||
    cursor.contract_id !== contractId ||
    cursor.last_height < cutoverHeight
  )
    throw new Error("Indexer has not reached the frozen contract block");
  const links = db
    .prepare(
      "SELECT source_plot_id, target_plot_id, cutover_height, cutover_at_ms, captured_cursor_height FROM deed_history_links",
    )
    .all() as Array<{
    source_plot_id: string;
    target_plot_id: string;
    cutover_height: number;
    cutover_at_ms: number;
    captured_cursor_height: number;
  }>;
  if (links.length !== moves.length)
    throw new Error("Deed history link count differs from the move map");
  let workflowRowsVerified = 0;
  for (const move of moves) {
    const link = links.find((row) => row.source_plot_id === move.from);
    if (
      !link ||
      link.target_plot_id !== move.to ||
      link.cutover_height !== cutoverHeight ||
      link.cutover_at_ms !== cutoverAtMs ||
      link.captured_cursor_height < cutoverHeight ||
      link.captured_cursor_height > cursor.last_height
    )
      throw new Error(`Deed history link differs for ${move.from}`);
    if (
      !options.allowReusedSourceActivity &&
      db
        .prepare(
          "SELECT 1 FROM chain_events WHERE location_id = ? AND block_height > ? LIMIT 1",
        )
        .get(move.from, cutoverHeight)
    )
      throw new Error(`Events after the frozen block exist on ${move.from}`);
    if (
      !options.allowReusedSourceActivity &&
      db
        .prepare(
          "SELECT 1 FROM impression_events WHERE plot_id = ? AND received_at_ms > ? LIMIT 1",
        )
        .get(move.from, cutoverAtMs)
    )
      throw new Error(`Impressions after the cutover exist on ${move.from}`);
    const workflowTables = [
      "media_uploads",
      "media_upload_attempts",
      "media_proposals",
      "generation_jobs",
    ];
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'paid_generation_jobs'",
        )
        .get()
    )
      workflowTables.push("paid_generation_jobs");
    for (const table of workflowTables)
      if (
        !options.allowReusedSourceActivity &&
        db
          .prepare(`SELECT 1 FROM ${table} WHERE plot_id = ? LIMIT 1`)
          .get(move.from)
      )
        throw new Error(`Deed workflow remains on ${move.from} in ${table}`);
    const recordedRows = db
      .prepare(
        "SELECT table_name, row_id FROM deed_history_workflow_rows WHERE source_plot_id = ?",
      )
      .all(move.from) as Array<{ table_name: string; row_id: string }>;
    for (const row of recordedRows) {
      if (!workflowTables.includes(row.table_name))
        throw new Error(`Unknown deed workflow table ${row.table_name}`);
      const current = db
        .prepare(`SELECT plot_id FROM ${row.table_name} WHERE id = ? LIMIT 1`)
        .get(row.row_id) as { plot_id: string } | undefined;
      const prunedRateLimit =
        row.table_name === "media_upload_attempts" && !current;
      const prunedUnusedUpload =
        row.table_name === "media_uploads" &&
        !current &&
        !db
          .prepare("SELECT 1 FROM media_proposals WHERE upload_id = ? LIMIT 1")
          .get(row.row_id);
      if (
        current?.plot_id !== move.to &&
        !prunedRateLimit &&
        !prunedUnusedUpload
      )
        throw new Error(
          `Moved deed workflow row missing from ${move.to} in ${row.table_name}`,
        );
      workflowRowsVerified++;
    }
  }
  const integrity = db.prepare("PRAGMA integrity_check").get() as {
    integrity_check: string;
  };
  if (integrity.integrity_check !== "ok")
    throw new Error("Deed-history database failed SQLite integrity check");
  const days = (
    db.prepare("SELECT COUNT(*) AS total FROM deed_history_days").get() as {
      total: number;
    }
  ).total;
  return {
    cursorHeight: cursor.last_height,
    links: links.length,
    days,
    workflowRowsVerified,
  };
}

export function verifyActiveCityCutover(
  db: DatabaseSync,
  contractId: string,
  moveMap: unknown,
  deedCutoverAtMs: number,
  impressionAcceptAfterMs: number,
  impressionIntakeEnabled: boolean,
): ReturnType<typeof verifyDeedHistoryCutover> {
  const map = z
    .object({
      sourceCityVersion: z.literal(1),
      targetCityVersion: z.literal(2),
      status: z.literal("reviewed"),
      moves: z.array(z.object({ from: z.string(), to: z.string() })).min(1),
    })
    .parse(moveMap);
  if (!Number.isSafeInteger(deedCutoverAtMs) || deedCutoverAtMs < 1)
    throw new Error("Version-2 API needs the recorded deed cutover time");
  if (
    impressionIntakeEnabled &&
    (!Number.isSafeInteger(impressionAcceptAfterMs) ||
      impressionAcceptAfterMs < deedCutoverAtMs)
  )
    throw new Error("Version-2 impression cutoff must follow the deed cutover");
  requireTable(db, "deed_history_links");
  const first = db
    .prepare(
      "SELECT cutover_height FROM deed_history_links WHERE source_plot_id = ?",
    )
    .get(map.moves[0]!.from) as { cutover_height: number } | undefined;
  if (!first)
    throw new Error("Version-2 API needs the applied deed-history move");
  return verifyDeedHistoryCutover(
    db,
    contractId,
    map.moves,
    first.cutover_height,
    deedCutoverAtMs,
    { allowReusedSourceActivity: true },
  );
}
