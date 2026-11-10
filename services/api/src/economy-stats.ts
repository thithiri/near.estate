import type { DatabaseSync } from "node:sqlite";

type EconomyDay = {
  day: string;
  curbParks: number;
  towerParks: number;
  collections: number;
  expiries: number;
  tickets: number;
  inspectorAttempts: number;
  inspectorSuccesses: number;
  gross: string;
  driverPayout: string;
  recipientPayout: string;
  forfeited: string;
  knownCoinCosts: string;
  starterGrants: string;
  unpricedCostEvents: number;
  unpricedGrantEvents: number;
};

type Row = {
  day: string;
  curb_parks: number;
  tower_parks: number;
  collections: number;
  expiries: number;
  tickets: number;
  inspector_attempts: number;
  inspector_successes: number;
  gross: string;
  driver_payout: string;
  recipient_payout: string;
  forfeited: string;
  known_coin_costs: string;
  starter_grants?: string;
  unpriced_cost_events?: number;
  unpriced_grant_events?: number;
};

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

export function readEconomyStats(
  db: DatabaseSync,
  nowSeconds: number,
): {
  days: EconomyDay[];
  totals: Omit<EconomyDay, "day">;
  indexedThroughHeight: number | null;
  indexedThroughAt: number | null;
  amountCoverageComplete: boolean;
  note: string;
} {
  const today = Math.floor(nowSeconds / 86_400);
  const start = new Date((today - 6) * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(today * 86_400_000).toISOString().slice(0, 10);
  const rows = hasTable(db, "economy_daily_stats")
    ? (db
        .prepare(
          "SELECT * FROM economy_daily_stats WHERE day BETWEEN ? AND ? ORDER BY day",
        )
        .all(start, end) as Row[])
    : [];
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days: EconomyDay[] = [];
  for (let offset = 6; offset >= 0; offset--) {
    const day = new Date((today - offset) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const row = byDay.get(day);
    days.push({
      day,
      curbParks: row?.curb_parks ?? 0,
      towerParks: row?.tower_parks ?? 0,
      collections: row?.collections ?? 0,
      expiries: row?.expiries ?? 0,
      tickets: row?.tickets ?? 0,
      inspectorAttempts: row?.inspector_attempts ?? 0,
      inspectorSuccesses: row?.inspector_successes ?? 0,
      gross: row?.gross ?? "0",
      driverPayout: row?.driver_payout ?? "0",
      recipientPayout: row?.recipient_payout ?? "0",
      forfeited: row?.forfeited ?? "0",
      knownCoinCosts: row?.known_coin_costs ?? "0",
      starterGrants: row?.starter_grants ?? "0",
      unpricedCostEvents: row?.unpriced_cost_events ?? 0,
      unpricedGrantEvents: row?.unpriced_grant_events ?? 0,
    });
  }
  const totals = days.reduce<Omit<EconomyDay, "day">>(
    (acc, day) => ({
      curbParks: acc.curbParks + day.curbParks,
      towerParks: acc.towerParks + day.towerParks,
      collections: acc.collections + day.collections,
      expiries: acc.expiries + day.expiries,
      tickets: acc.tickets + day.tickets,
      inspectorAttempts: acc.inspectorAttempts + day.inspectorAttempts,
      inspectorSuccesses: acc.inspectorSuccesses + day.inspectorSuccesses,
      gross: (BigInt(acc.gross) + BigInt(day.gross)).toString(),
      driverPayout: (
        BigInt(acc.driverPayout) + BigInt(day.driverPayout)
      ).toString(),
      recipientPayout: (
        BigInt(acc.recipientPayout) + BigInt(day.recipientPayout)
      ).toString(),
      forfeited: (BigInt(acc.forfeited) + BigInt(day.forfeited)).toString(),
      knownCoinCosts: (
        BigInt(acc.knownCoinCosts) + BigInt(day.knownCoinCosts)
      ).toString(),
      starterGrants: (
        BigInt(acc.starterGrants) + BigInt(day.starterGrants)
      ).toString(),
      unpricedCostEvents: acc.unpricedCostEvents + day.unpricedCostEvents,
      unpricedGrantEvents: acc.unpricedGrantEvents + day.unpricedGrantEvents,
    }),
    {
      curbParks: 0,
      towerParks: 0,
      collections: 0,
      expiries: 0,
      tickets: 0,
      inspectorAttempts: 0,
      inspectorSuccesses: 0,
      gross: "0",
      driverPayout: "0",
      recipientPayout: "0",
      forfeited: "0",
      knownCoinCosts: "0",
      starterGrants: "0",
      unpricedCostEvents: 0,
      unpricedGrantEvents: 0,
    },
  );
  const cursor = hasTable(db, "indexer_state")
    ? (db
        .prepare(
          "SELECT last_height, last_timestamp_ns FROM indexer_state WHERE id = 1",
        )
        .get() as
        | { last_height: number; last_timestamp_ns: string | null }
        | undefined)
    : undefined;
  return {
    days,
    totals,
    indexedThroughHeight: cursor?.last_timestamp_ns ? cursor.last_height : null,
    indexedThroughAt: cursor?.last_timestamp_ns
      ? Number(BigInt(cursor.last_timestamp_ns) / 1_000_000n)
      : null,
    amountCoverageComplete:
      Boolean(cursor?.last_timestamp_ns) &&
      totals.unpricedCostEvents === 0 &&
      totals.unpricedGrantEvents === 0,
    note:
      totals.unpricedCostEvents || totals.unpricedGrantEvents
        ? "Some historical registration, car or cosmetic events lack amounts. Costs and starter grants are partial for this seven-day window."
        : "Recorded costs and starter grants cover indexed events in this seven-day window; activity after the indexer cursor is not included.",
  };
}
