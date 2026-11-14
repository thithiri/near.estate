import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FinalizedBlock } from "./event-store.js";
import { EventStore } from "./event-store.js";

const timestampNs = "1794316011248367505";
function block(height: number, hash: string, prevHash: string): FinalizedBlock {
  return {
    height,
    hash,
    prevHash,
    timestampNs,
    source: "neardata",
    events: [],
  };
}

test("receipt replay, restart and aggregate rebuild preserve one count", () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-indexer-"));
  const path = join(dir, "estate.sqlite");
  try {
    const store = new EventStore(path, "estate.testnet", 10);
    const parked = block(10, "hash-10", "hash-9");
    parked.events.push({
      id: "receipt-a:0:0",
      receiptId: "receipt-a",
      logIndex: 0,
      dataIndex: 0,
      event: "parked",
      payload: {
        session_id: 1,
        car_id: 2,
        driver: "alice.testnet",
        location_id: "plot-a",
        slot: 0,
        facility: "Curb",
        legal: true,
        expires_at: 123,
      },
    });
    assert.equal(store.applyHeight(10, parked), 1);
    assert.equal(store.applyHeight(10, parked), 0);
    assert.equal(store.applyHeight(11, null), 0);
    const settled = block(12, "hash-12", "hash-10");
    settled.events.push({
      id: "receipt-b:0:0",
      receiptId: "receipt-b",
      logIndex: 0,
      dataIndex: 0,
      event: "collected",
      payload: {
        session_id: 1,
        location_id: "plot-a",
        slot: 0,
        facility: "Curb",
        gross: "100000000000000000000",
        driver_payout: "80000000000000000000",
        recipient_payout: "20000000000000000000",
        forfeited: "0",
      },
    });
    assert.equal(store.applyHeight(12, settled), 1);
    const first = store.db
      .prepare("SELECT * FROM plot_daily_stats WHERE plot_id = 'plot-a'")
      .get() as Record<string, unknown>;
    assert.equal(first.parks, 1);
    assert.equal(first.collections, 1);
    assert.equal(first.gross, "100000000000000000000");
    const economy = store.db
      .prepare("SELECT * FROM economy_daily_stats")
      .get() as Record<string, unknown>;
    assert.equal(economy.curb_parks, 1);
    assert.equal(economy.gross, "100000000000000000000");
    store.close();

    const oldDatabase = new DatabaseSync(path);
    oldDatabase.exec(`
      DROP TABLE economy_daily_stats;
      CREATE TABLE economy_daily_stats (
        day TEXT PRIMARY KEY,
        curb_parks INTEGER NOT NULL DEFAULT 0,
        tower_parks INTEGER NOT NULL DEFAULT 0,
        collections INTEGER NOT NULL DEFAULT 0,
        expiries INTEGER NOT NULL DEFAULT 0,
        tickets INTEGER NOT NULL DEFAULT 0,
        inspector_attempts INTEGER NOT NULL DEFAULT 0,
        inspector_successes INTEGER NOT NULL DEFAULT 0,
        gross TEXT NOT NULL DEFAULT '0',
        driver_payout TEXT NOT NULL DEFAULT '0',
        recipient_payout TEXT NOT NULL DEFAULT '0',
        forfeited TEXT NOT NULL DEFAULT '0',
        known_coin_costs TEXT NOT NULL DEFAULT '0'
      ) STRICT;
    `);
    oldDatabase.close();

    const reopened = new EventStore(path, "estate.testnet", 10);
    assert.deepEqual(reopened.cursor(), {
      height: 12,
      hash: "hash-12",
      timestampNs,
    });
    reopened.rebuildAggregates();
    const rebuilt = reopened.db
      .prepare("SELECT * FROM plot_daily_stats WHERE plot_id = 'plot-a'")
      .get();
    assert.deepEqual(rebuilt, first);
    assert.deepEqual(
      reopened.db.prepare("SELECT * FROM economy_daily_stats").get(),
      economy,
    );
    reopened.rebuildAggregates();
    assert.deepEqual(
      reopened.db
        .prepare("SELECT * FROM plot_daily_stats WHERE plot_id = 'plot-a'")
        .get(),
      first,
    );
    assert.throws(
      () => new EventStore(path, "another.testnet", 10),
      /different contract/,
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid event batch rolls back cursor, rows and aggregates", () => {
  const store = new EventStore(":memory:", "estate.testnet", 4);
  try {
    const bad = block(4, "hash-4", "hash-3");
    bad.events.push({
      id: "receipt-bad:0:0",
      receiptId: "receipt-bad",
      logIndex: 0,
      dataIndex: 0,
      event: "ticketed",
      payload: {
        location_id: "plot-a",
        facility: "Curb",
        gross: "broken",
        driver_payout: "0",
        recipient_payout: "0",
        forfeited: "0",
      },
    });
    assert.throws(() => store.applyHeight(4, bad), /Invalid indexed coin/);
    assert.equal(store.cursor().height, 3);
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM chain_events")
          .get() as {
          count: number;
        }
      ).count,
      0,
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM indexed_blocks")
          .get() as {
          count: number;
        }
      ).count,
      0,
    );
    assert.equal(store.applyHeight(4, block(4, "hash-4", "hash-3")), 0);
    assert.throws(
      () => store.applyHeight(5, block(5, "hash-5", "wrong")),
      /linkage/,
    );
  } finally {
    store.close();
  }
});

test("ticket totals count once and tower events stay out of plot stats", () => {
  const store = new EventStore(":memory:", "estate.testnet", 20);
  try {
    const current = block(20, "hash-20", "hash-19");
    current.events.push(
      {
        id: "receipt-ticket:0:0",
        receiptId: "receipt-ticket",
        logIndex: 0,
        dataIndex: 0,
        event: "ticketed",
        payload: {
          session_id: 3,
          location_id: "plot-a",
          slot: 1,
          facility: "Curb",
          gross: "100",
          driver_payout: "0",
          recipient_payout: "70",
          forfeited: "30",
        },
      },
      {
        id: "receipt-tower:0:0",
        receiptId: "receipt-tower",
        logIndex: 0,
        dataIndex: 0,
        event: "parked",
        payload: { location_id: "tower-a", facility: "Tower" },
      },
    );
    assert.equal(store.applyHeight(20, current), 2);
    assert.equal(store.applyHeight(20, current), 0);
    const stats = store.db
      .prepare("SELECT * FROM plot_daily_stats")
      .all() as Record<string, unknown>[];
    assert.equal(stats.length, 1);
    assert.equal(stats[0]?.plot_id, "plot-a");
    assert.equal(stats[0]?.tickets, 1);
    assert.equal(stats[0]?.recipient_payout, "70");
    assert.equal(stats[0]?.forfeited, "30");
    const economy = store.db
      .prepare("SELECT * FROM economy_daily_stats")
      .get() as Record<string, unknown>;
    assert.equal(economy.tower_parks, 1);
    assert.equal(economy.tickets, 1);
    assert.equal(economy.forfeited, "30");
  } finally {
    store.close();
  }
});

test("economy telemetry counts inspection attempts and known coin costs once", () => {
  const store = new EventStore(":memory:", "estate.testnet", 30);
  try {
    const current = block(30, "hash-30", "hash-29");
    current.events.push(
      {
        id: "receipt-inspect:0:0",
        receiptId: "receipt-inspect",
        logIndex: 0,
        dataIndex: 0,
        event: "inspection_attempted",
        payload: { session_id: 5, success: true },
      },
      {
        id: "receipt-repair:0:0",
        receiptId: "receipt-repair",
        logIndex: 0,
        dataIndex: 0,
        event: "car_repaired",
        payload: { car_id: 5, points: 2, cost: "2000000" },
      },
      {
        id: "receipt-upgrade:0:0",
        receiptId: "receipt-upgrade",
        logIndex: 0,
        dataIndex: 0,
        event: "building_updated",
        payload: {
          plot_id: "plot-a",
          revision: 2,
          change: "level",
          level: 2,
          cost: "200000000",
        },
      },
      {
        id: "receipt-heart:0:0",
        receiptId: "receipt-heart",
        logIndex: 0,
        dataIndex: 0,
        event: "visit_bonus_paid",
        payload: {
          owner: "driver.testnet",
          car_id: 5,
          session_id: 5,
          amount: "2000000",
        },
      },
    );
    assert.equal(store.applyHeight(30, current), 4);
    assert.equal(store.applyHeight(30, current), 0);
    const row = store.db.prepare("SELECT * FROM economy_daily_stats").get() as {
      inspector_attempts: number;
      inspector_successes: number;
      known_coin_costs: string;
      heart_bonus: string;
    };
    assert.equal(row.inspector_attempts, 1);
    assert.equal(row.inspector_successes, 1);
    assert.equal(row.known_coin_costs, "202000000");
    assert.equal(row.heart_bonus, "2000000");
  } finally {
    store.close();
  }
});

test("new economy events add exact costs and grants while legacy amounts remain visibly unknown", () => {
  const store = new EventStore(":memory:", "estate.testnet", 40);
  try {
    const current = block(40, "hash-40", "hash-39");
    const entries = [
      [
        "player_registered",
        { account_id: "new.testnet", starter_car_id: 1, grant: "100000000" },
      ],
      [
        "car_minted",
        { car_id: 1, owner: "new.testnet", source: "starter", cost: "0" },
      ],
      [
        "car_minted",
        {
          car_id: 2,
          owner: "new.testnet",
          source: "purchase",
          cost: "150000000",
        },
      ],
      [
        "cosmetic_bought",
        {
          account_id: "new.testnet",
          cosmetic: "burger_decal",
          cost: "30000000",
        },
      ],
      ["player_registered", { account_id: "old.testnet", starter_car_id: 3 }],
      ["car_minted", { car_id: 3, owner: "old.testnet" }],
      [
        "cosmetic_bought",
        { account_id: "old.testnet", cosmetic: "burger_decal" },
      ],
    ] as const;
    current.events.push(
      ...entries.map(([event, payload], index) => ({
        id: `receipt-economy:${index}:0`,
        receiptId: "receipt-economy",
        logIndex: index,
        dataIndex: 0,
        event,
        payload,
      })),
    );
    assert.equal(store.applyHeight(40, current), entries.length);
    const row = store.db
      .prepare("SELECT * FROM economy_daily_stats")
      .get() as Record<string, unknown>;
    assert.equal(row.known_coin_costs, "180000000");
    assert.equal(row.starter_grants, "100000000");
    assert.equal(row.unpriced_cost_events, 2);
    assert.equal(row.unpriced_grant_events, 1);
    store.rebuildAggregates();
    assert.deepEqual(
      store.db.prepare("SELECT * FROM economy_daily_stats").get(),
      row,
    );
  } finally {
    store.close();
  }
});

test("sparse account range advances atomically and rejects replay", () => {
  const store = new EventStore(":memory:", "estate.testnet", 10);
  try {
    const seeded = block(10, "hash-10", "hash-9");
    seeded.source = "history";
    seeded.events.push({
      id: "receipt-seed:0:0",
      receiptId: "receipt-seed",
      logIndex: 0,
      dataIndex: 0,
      event: "plot_seeded",
      payload: { plot_id: "plot-a" },
    });
    assert.equal(
      store.applyAccountRange({ height: 15, hash: "hash-15", timestampNs }, [
        seeded,
      ]),
      1,
    );
    assert.deepEqual(store.cursor(), {
      height: 15,
      hash: "hash-15",
      timestampNs,
    });
    assert.equal(
      store.applyAccountRange({ height: 20, hash: "hash-20", timestampNs }, []),
      0,
    );
    assert.throws(
      () =>
        store.applyAccountRange({ height: 21, hash: "hash-21", timestampNs }, [
          seeded,
        ]),
      /Invalid or unsorted/,
    );
    assert.equal(store.cursor().height, 20);
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM chain_events")
          .get() as {
          count: number;
        }
      ).count,
      1,
    );
  } finally {
    store.close();
  }
});
