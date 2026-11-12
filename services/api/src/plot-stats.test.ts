import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PlotStats, validateCitySeed } from "@estate/shared";
import { createApiApp } from "./app.js";
import { readEconomyStats } from "./economy-stats.js";
import { ImpressionLedger } from "./impression-ledger.js";
import { readPlotStats } from "./plot-stats.js";
import { ApiStore } from "./store.js";

function updateBeforeCursorRead(
  db: DatabaseSync,
  update: () => void,
): DatabaseSync {
  let updated = false;
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (!updated && sql.includes("SELECT last_height")) {
            updated = true;
            update();
          }
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("plot statistics combine persisted ad and chain totals with freshness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-stats-"));
  const dbPath = join(dir, "estate.sqlite");
  const assets = join(dir, "assets");
  const now = Math.floor(Date.UTC(2026, 10, 11, 12) / 1_000);
  const plotId = "plot-main-n-0";
  let store = new ApiStore(dbPath, assets);
  try {
    const ledger = new ImpressionLedger(store.db);
    ledger.issueSession("session-hash", now);
    ledger.recordBatch(
      "session-hash",
      [
        {
          eventId: randomUUID(),
          plotId,
          surface: "Logo",
          observedAt: now * 1_000 - 2_000,
          msVisible: 1_500,
        },
      ],
      now,
    );
    store.db.exec(`
      CREATE TABLE indexer_state (id INTEGER PRIMARY KEY, last_height INTEGER, last_timestamp_ns TEXT, updated_at INTEGER);
      CREATE TABLE plot_daily_stats (plot_id TEXT, day TEXT, parks INTEGER, tickets INTEGER);
    `);
    store.db
      .prepare("INSERT INTO indexer_state VALUES (1, ?, ?, ?)")
      .run(277_000_001, String(BigInt(now - 12) * 1_000_000_000n), now * 1_000);
    store.db
      .prepare("INSERT INTO plot_daily_stats VALUES (?, ?, ?, ?)")
      .run(plotId, "2026-11-11", 3, 1);
    store.close();

    store = new ApiStore(dbPath, assets);
    const app = createApiApp({
      store,
      chain: null,
      appOrigin: "http://localhost:8080",
      clock: () => now,
    });
    const response = await app.request(
      `http://localhost:8080/stats/plots/${plotId}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const stats = PlotStats.parse(await response.json());
    assert.equal(stats.days.length, 7);
    assert.equal(stats.totals.impressions, 1);
    assert.equal(stats.totals.dwellMs, 1_500);
    assert.equal(stats.totals.averageVisibleMs, 1_500);
    assert.equal(stats.totals.parks, 3);
    assert.equal(stats.totals.tickets, 1);
    assert.equal(stats.freshness.indexedThroughHeight, 277_000_001);
    assert.equal(stats.freshness.indexedThroughAt, (now - 12) * 1_000);
    assert.equal(stats.freshness.impressionReceivedAt, now * 1_000);
    assert.equal(
      (await app.request("http://localhost:8080/stats/plots/invalid")).status,
      404,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version-2 API city and stats include the tenth plot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-v2-stats-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  try {
    const seed = validateCitySeed(
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL("../../../contracts/estate/seed-v2.json", import.meta.url),
          ),
          "utf8",
        ),
      ),
    );
    const app = createApiApp({
      store,
      chain: null,
      appOrigin: "http://localhost:8080",
      citySeed: seed,
    });
    const cityResponse = await app.request("http://localhost:8080/city");
    assert.equal((await cityResponse.json()).version, 2);
    const statsResponse = await app.request(
      "http://localhost:8080/stats/plots/plot-main-n-9",
    );
    assert.equal(statsResponse.status, 200);
    assert.equal((await statsResponse.json()).plotId, "plot-main-n-9");
    assert.equal(
      (await app.request("http://localhost:8080/stats/plots/plot-main-n-10"))
        .status,
      404,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("economy telemetry keeps exact large coin sums and labels incomplete costs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-economy-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const now = Math.floor(Date.UTC(2026, 10, 11, 12) / 1_000);
  try {
    store.db.exec(`CREATE TABLE economy_daily_stats (
      day TEXT PRIMARY KEY, curb_parks INTEGER, tower_parks INTEGER,
      collections INTEGER, expiries INTEGER, tickets INTEGER,
      inspector_attempts INTEGER, inspector_successes INTEGER,
      gross TEXT, driver_payout TEXT, recipient_payout TEXT,
      forfeited TEXT, known_coin_costs TEXT, starter_grants TEXT,
      unpriced_cost_events INTEGER, unpriced_grant_events INTEGER
    )`);
    store.db
      .prepare(
        "INSERT INTO economy_daily_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "2026-11-11",
        2,
        1,
        1,
        0,
        1,
        1,
        1,
        "100000000000000000000",
        "70000000000000000000",
        "20000000000000000000",
        "10000000000000000000",
        "5000000",
        "100000000",
        2,
        1,
      );
    const app = createApiApp({
      store,
      chain: null,
      appOrigin: "http://localhost:8080",
      clock: () => now,
    });
    const response = await app.request("http://localhost:8080/stats/economy");
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      totals: {
        gross: string;
        tickets: number;
        knownCoinCosts: string;
        starterGrants: string;
        unpricedCostEvents: number;
        unpricedGrantEvents: number;
      };
      indexedThroughHeight: number | null;
      amountCoverageComplete: boolean;
      note: string;
    };
    assert.equal(body.totals.gross, "100000000000000000000");
    assert.equal(body.totals.tickets, 1);
    assert.equal(body.totals.knownCoinCosts, "5000000");
    assert.equal(body.totals.starterGrants, "100000000");
    assert.equal(body.totals.unpricedCostEvents, 2);
    assert.equal(body.totals.unpricedGrantEvents, 1);
    assert.equal(body.indexedThroughHeight, null);
    assert.equal(body.amountCoverageComplete, false);
    assert.match(body.note, /historical/);
    store.db.exec(
      "CREATE TABLE indexer_state (id INTEGER PRIMARY KEY, last_height INTEGER, last_timestamp_ns TEXT)",
    );
    store.db
      .prepare("INSERT INTO indexer_state VALUES (1, ?, ?)")
      .run(123, String(BigInt(now) * 1_000_000_000n));
    store.db.exec(
      "UPDATE economy_daily_stats SET unpriced_cost_events = 0, unpriced_grant_events = 0",
    );
    const completeResponse = await app.request(
      "http://localhost:8080/stats/economy",
    );
    const complete = (await completeResponse.json()) as {
      amountCoverageComplete: boolean;
      indexedThroughHeight: number | null;
    };
    assert.equal(complete.amountCoverageComplete, true);
    assert.equal(complete.indexedThroughHeight, 123);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stats totals and cursor stay on one snapshot while the indexer commits", () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-stats-snapshot-"));
  const dbPath = join(dir, "estate.sqlite");
  const store = new ApiStore(dbPath, join(dir, "assets"));
  const writer = new DatabaseSync(dbPath);
  const now = Math.floor(Date.UTC(2026, 10, 11, 12) / 1_000);
  const timestamp = (seconds: number) =>
    String(BigInt(seconds) * 1_000_000_000n);
  try {
    new ImpressionLedger(store.db);
    store.db.exec(`
      CREATE TABLE indexer_state (id INTEGER PRIMARY KEY, last_height INTEGER, last_timestamp_ns TEXT, updated_at INTEGER);
      CREATE TABLE plot_daily_stats (plot_id TEXT, day TEXT, parks INTEGER, tickets INTEGER);
      CREATE TABLE economy_daily_stats (day TEXT, curb_parks INTEGER, tower_parks INTEGER,
        collections INTEGER, expiries INTEGER, tickets INTEGER, inspector_attempts INTEGER,
        inspector_successes INTEGER, gross TEXT, driver_payout TEXT, recipient_payout TEXT,
        forfeited TEXT, known_coin_costs TEXT, starter_grants TEXT,
        unpriced_cost_events INTEGER, unpriced_grant_events INTEGER);
      INSERT INTO plot_daily_stats VALUES ('plot-main-n-0', '2026-11-11', 1, 0);
      INSERT INTO economy_daily_stats VALUES ('2026-11-11', 1, 0, 0, 0, 0, 0, 0,
        '10', '10', '0', '0', '0', '0', 0, 0);
    `);
    store.db
      .prepare("INSERT INTO indexer_state VALUES (1, 100, ?, ?)")
      .run(timestamp(now - 2), now * 1_000);
    const plotReader = updateBeforeCursorRead(store.db, () => {
      writer.exec(`
        BEGIN;
        UPDATE plot_daily_stats SET parks = 2;
        UPDATE indexer_state SET last_height = 101, last_timestamp_ns = '${timestamp(now - 1)}';
        COMMIT;
      `);
    });
    const plot = readPlotStats(plotReader, "plot-main-n-0", now);
    assert.equal(plot.totals.parks, 1);
    assert.equal(plot.freshness.indexedThroughHeight, 100);
    assert.equal(readPlotStats(store.db, "plot-main-n-0", now).totals.parks, 2);

    const economyReader = updateBeforeCursorRead(store.db, () => {
      writer.exec(`
        BEGIN;
        UPDATE economy_daily_stats SET curb_parks = 2;
        UPDATE indexer_state SET last_height = 102, last_timestamp_ns = '${timestamp(now)}';
        COMMIT;
      `);
    });
    const economy = readEconomyStats(economyReader, now);
    assert.equal(economy.totals.curbParks, 1);
    assert.equal(economy.indexedThroughHeight, 101);
    assert.equal(readEconomyStats(store.db, now).totals.curbParks, 2);
  } finally {
    writer.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
