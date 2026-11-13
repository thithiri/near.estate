import type { DatabaseSync } from "node:sqlite";
import type { PlotStats } from "@estate/shared";
import { withReadSnapshot } from "./read-snapshot.js";

function exists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

function hasColumn(db: DatabaseSync, table: string, name: string): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).some((column) => column.name === name);
}

function readPlotStatsUnwrapped(
  db: DatabaseSync,
  plotId: string,
  nowSeconds: number,
): PlotStats {
  const today = Math.floor(nowSeconds / 86_400);
  const startDay = new Date((today - 6) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const endDay = new Date(today * 86_400_000).toISOString().slice(0, 10);
  const link = exists(db, "deed_history_links")
    ? (db
        .prepare(
          "SELECT source_plot_id, cutover_height, cutover_at_ms FROM deed_history_links WHERE target_plot_id = ?",
        )
        .get(plotId) as
        | {
            source_plot_id: string;
            cutover_height: number;
            cutover_at_ms: number;
          }
        | undefined)
    : undefined;
  if (link && !exists(db, "deed_destination_days"))
    throw new Error("Moved deed is missing its destination baseline");
  const baselineRows = link
    ? (db
        .prepare(
          "SELECT day, impressions, dwell_ms, parks, tickets FROM deed_destination_days WHERE source_plot_id = ? AND day BETWEEN ? AND ?",
        )
        .all(link.source_plot_id, startDay, endDay) as Array<{
        day: string;
        impressions: number;
        dwell_ms: number;
        parks: number;
        tickets: number;
      }>)
    : [];
  const baseline = new Map(baselineRows.map((row) => [row.day, row]));
  const adRows = db
    .prepare(
      "SELECT day, impressions, dwell_ms FROM impression_daily_stats WHERE plot_id = ? AND day BETWEEN ? AND ?",
    )
    .all(plotId, startDay, endDay) as Array<{
    day: string;
    impressions: number;
    dwell_ms: number;
  }>;
  const chainRows = exists(db, "plot_daily_stats")
    ? (db
        .prepare(
          "SELECT day, parks, tickets FROM plot_daily_stats WHERE plot_id = ? AND day BETWEEN ? AND ?",
        )
        .all(plotId, startDay, endDay) as Array<{
        day: string;
        parks: number;
        tickets: number;
      }>)
    : [];
  const ads = new Map(adRows.map((row) => [row.day, row]));
  const chain = new Map(chainRows.map((row) => [row.day, row]));
  const income = {
    knownOwnerPayout: 0n,
    meterPayout: 0n,
    ticketPayout: 0n,
    treasuryPayout: 0n,
    unattributedSettlements: 0,
  };
  const traffic = { legalParks: 0, illegalParks: 0 };
  if (
    exists(db, "chain_events") &&
    hasColumn(db, "chain_events", "event_name") &&
    hasColumn(db, "chain_events", "payload_json") &&
    (!link || hasColumn(db, "chain_events", "block_height"))
  ) {
    const cutoverFilter =
      link && hasColumn(db, "chain_events", "block_height")
        ? " AND block_height > ?"
        : "";
    const rows = db
      .prepare(
        `SELECT event_name, payload_json FROM chain_events WHERE location_id = ? AND block_day BETWEEN ? AND ? AND event_name IN ('parked', 'collected', 'expired', 'ticketed')${cutoverFilter}`,
      )
      .all(
        ...(cutoverFilter
          ? [plotId, startDay, endDay, link?.cutover_height ?? 0]
          : [plotId, startDay, endDay]),
      ) as Array<{
      event_name: string;
      payload_json: string;
    }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (row.event_name === "parked") {
        if (payload.legal === true) traffic.legalParks++;
        else if (payload.legal === false) traffic.illegalParks++;
        continue;
      }
      if (
        typeof payload.owner_payout !== "string" ||
        typeof payload.treasury_payout !== "string"
      ) {
        income.unattributedSettlements++;
        continue;
      }
      const owner = BigInt(payload.owner_payout);
      income.knownOwnerPayout += owner;
      income.treasuryPayout += BigInt(payload.treasury_payout);
      if (row.event_name === "ticketed") income.ticketPayout += owner;
      else income.meterPayout += owner;
    }
  }
  const days: PlotStats["days"] = [];
  for (let offset = 6; offset >= 0; offset--) {
    const day = new Date((today - offset) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const before = baseline.get(day);
    const impressions =
      (ads.get(day)?.impressions ?? 0) - (before?.impressions ?? 0);
    const dwellMs = (ads.get(day)?.dwell_ms ?? 0) - (before?.dwell_ms ?? 0);
    const parks = (chain.get(day)?.parks ?? 0) - (before?.parks ?? 0);
    const tickets = (chain.get(day)?.tickets ?? 0) - (before?.tickets ?? 0);
    if ([impressions, dwellMs, parks, tickets].some((value) => value < 0))
      throw new Error(
        `Moved deed totals fell below the frozen baseline on ${day}`,
      );
    days.push({
      day,
      impressions,
      dwellMs,
      averageVisibleMs: impressions ? Math.round(dwellMs / impressions) : 0,
      parks,
      tickets,
    });
  }
  const totals = days.reduce(
    (acc, day) => ({
      impressions: acc.impressions + day.impressions,
      dwellMs: acc.dwellMs + day.dwellMs,
      averageVisibleMs: 0,
      parks: acc.parks + day.parks,
      tickets: acc.tickets + day.tickets,
    }),
    { impressions: 0, dwellMs: 0, averageVisibleMs: 0, parks: 0, tickets: 0 },
  );
  totals.averageVisibleMs = totals.impressions
    ? Math.round(totals.dwellMs / totals.impressions)
    : 0;
  let linkedHistory: PlotStats["linkedHistory"];
  if (link) {
    const priorRows = db
      .prepare(
        "SELECT day, impressions, dwell_ms, parks, tickets FROM deed_history_days WHERE source_plot_id = ? AND day BETWEEN ? AND ?",
      )
      .all(link.source_plot_id, startDay, endDay) as Array<{
      day: string;
      impressions: number;
      dwell_ms: number;
      parks: number;
      tickets: number;
    }>;
    const priorByDay = new Map(priorRows.map((row) => [row.day, row]));
    const priorDays: PlotStats["days"] = days.map(({ day }) => {
      const row = priorByDay.get(day);
      const impressions = row?.impressions ?? 0;
      const dwellMs = row?.dwell_ms ?? 0;
      return {
        day,
        impressions,
        dwellMs,
        averageVisibleMs: impressions ? Math.round(dwellMs / impressions) : 0,
        parks: row?.parks ?? 0,
        tickets: row?.tickets ?? 0,
      };
    });
    const priorTotals = priorDays.reduce(
      (sum, day) => ({
        impressions: sum.impressions + day.impressions,
        dwellMs: sum.dwellMs + day.dwellMs,
        averageVisibleMs: 0,
        parks: sum.parks + day.parks,
        tickets: sum.tickets + day.tickets,
      }),
      {
        impressions: 0,
        dwellMs: 0,
        averageVisibleMs: 0,
        parks: 0,
        tickets: 0,
      },
    );
    priorTotals.averageVisibleMs = priorTotals.impressions
      ? Math.round(priorTotals.dwellMs / priorTotals.impressions)
      : 0;
    linkedHistory = {
      sourcePlotId: link.source_plot_id,
      cutoverHeight: link.cutover_height,
      cutoverAtMs: link.cutover_at_ms,
      days: priorDays,
      totals: priorTotals,
    };
  }
  const impression = db
    .prepare(
      link
        ? "SELECT MAX(received_at_ms) AS received FROM impression_events WHERE plot_id = ? AND received_at_ms > ?"
        : "SELECT MAX(received_at_ms) AS received FROM impression_events WHERE plot_id = ?",
    )
    .get(...(link ? [plotId, link.cutover_at_ms] : [plotId])) as {
    received: number | null;
  };
  const cursor = exists(db, "indexer_state")
    ? (db
        .prepare(
          "SELECT last_height, last_timestamp_ns, updated_at FROM indexer_state WHERE id = 1",
        )
        .get() as
        | {
            last_height: number;
            last_timestamp_ns: string | null;
            updated_at: number;
          }
        | undefined)
    : undefined;
  return {
    plotId,
    days,
    totals,
    traffic: {
      ...traffic,
      unclassifiedParks: Math.max(
        0,
        totals.parks - traffic.legalParks - traffic.illegalParks,
      ),
    },
    income: {
      knownOwnerPayout: income.knownOwnerPayout.toString(),
      meterPayout: income.meterPayout.toString(),
      ticketPayout: income.ticketPayout.toString(),
      treasuryPayout: income.treasuryPayout.toString(),
      unattributedSettlements: income.unattributedSettlements,
    },
    ...(linkedHistory ? { linkedHistory } : {}),
    freshness: {
      impressionReceivedAt: impression.received,
      indexedThroughHeight: cursor?.last_timestamp_ns
        ? cursor.last_height
        : null,
      indexedThroughAt: cursor?.last_timestamp_ns
        ? Number(BigInt(cursor.last_timestamp_ns) / 1_000_000n)
        : null,
      indexerCheckedAt: cursor?.updated_at ?? null,
    },
  };
}

export function readPlotStats(
  db: DatabaseSync,
  plotId: string,
  nowSeconds: number,
): PlotStats {
  return withReadSnapshot(db, () =>
    readPlotStatsUnwrapped(db, plotId, nowSeconds),
  );
}
