import type { DatabaseSync } from "node:sqlite";
import type { PlotStats } from "@estate/shared";

function exists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

export function readPlotStats(
  db: DatabaseSync,
  plotId: string,
  nowSeconds: number,
): PlotStats {
  const today = Math.floor(nowSeconds / 86_400);
  const startDay = new Date((today - 6) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const endDay = new Date(today * 86_400_000).toISOString().slice(0, 10);
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
  const days: PlotStats["days"] = [];
  for (let offset = 6; offset >= 0; offset--) {
    const day = new Date((today - offset) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const impressions = ads.get(day)?.impressions ?? 0;
    const dwellMs = ads.get(day)?.dwell_ms ?? 0;
    days.push({
      day,
      impressions,
      dwellMs,
      averageVisibleMs: impressions ? Math.round(dwellMs / impressions) : 0,
      parks: chain.get(day)?.parks ?? 0,
      tickets: chain.get(day)?.tickets ?? 0,
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
  const impression = db
    .prepare(
      "SELECT MAX(received_at_ms) AS received FROM impression_events WHERE plot_id = ?",
    )
    .get(plotId) as { received: number | null };
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
