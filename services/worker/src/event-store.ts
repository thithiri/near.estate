import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GameEvent } from "@estate/shared";

export type ChainEvent = {
  id: string;
  receiptId: string;
  logIndex: number;
  dataIndex: number;
  event: GameEvent["event"];
  payload: Record<string, unknown>;
};

export type FinalizedBlock = {
  height: number;
  hash: string;
  prevHash: string;
  timestampNs: string;
  source: "neardata" | "history";
  events: ChainEvent[];
};

export type EventCursor = {
  height: number;
  hash: string | null;
  timestampNs: string | null;
};

function dayOf(timestampNs: string): string {
  const milliseconds = Number(BigInt(timestampNs) / 1_000_000n);
  if (!Number.isSafeInteger(milliseconds))
    throw new Error("Block timestamp is outside the supported date range");
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function coin(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("Invalid indexed coin value");
  return BigInt(value);
}

export class EventStore {
  readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    readonly contractId: string,
    readonly startHeight: number,
  ) {
    if (!contractId || !Number.isSafeInteger(startHeight) || startHeight < 1)
      throw new Error("Indexer needs a contract and positive start height");
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    const hadEconomyTable = Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'economy_daily_stats'",
        )
        .get(),
    );
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS indexer_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        contract_id TEXT NOT NULL,
        start_height INTEGER NOT NULL,
        last_height INTEGER NOT NULL,
        last_hash TEXT,
        last_timestamp_ns TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS indexed_blocks (
        height INTEGER PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        timestamp_ns TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('neardata', 'history'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS chain_events (
        event_id TEXT PRIMARY KEY,
        receipt_id TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        data_index INTEGER NOT NULL,
        block_height INTEGER NOT NULL REFERENCES indexed_blocks(height),
        block_day TEXT NOT NULL,
        event_name TEXT NOT NULL,
        location_id TEXT,
        facility TEXT,
        payload_json TEXT NOT NULL,
        UNIQUE(receipt_id, log_index, data_index)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS chain_event_location_day
        ON chain_events(location_id, block_day, event_name);
      CREATE TABLE IF NOT EXISTS plot_daily_stats (
        plot_id TEXT NOT NULL,
        day TEXT NOT NULL,
        parks INTEGER NOT NULL DEFAULT 0,
        collections INTEGER NOT NULL DEFAULT 0,
        expiries INTEGER NOT NULL DEFAULT 0,
        tickets INTEGER NOT NULL DEFAULT 0,
        gross TEXT NOT NULL DEFAULT '0',
        driver_payout TEXT NOT NULL DEFAULT '0',
        recipient_payout TEXT NOT NULL DEFAULT '0',
        forfeited TEXT NOT NULL DEFAULT '0',
        PRIMARY KEY (plot_id, day)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS economy_daily_stats (
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
        known_coin_costs TEXT NOT NULL DEFAULT '0',
        starter_grants TEXT NOT NULL DEFAULT '0',
        unpriced_cost_events INTEGER NOT NULL DEFAULT 0,
        unpriced_grant_events INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
    const economyColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(economy_daily_stats)").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    let economyNeedsRebuild = !hadEconomyTable;
    for (const [name, definition] of [
      ["starter_grants", "TEXT NOT NULL DEFAULT '0'"],
      ["unpriced_cost_events", "INTEGER NOT NULL DEFAULT 0"],
      ["unpriced_grant_events", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      if (economyColumns.has(name)) continue;
      this.db.exec(
        `ALTER TABLE economy_daily_stats ADD COLUMN ${name} ${definition}`,
      );
      economyNeedsRebuild = true;
    }
    const row = this.db
      .prepare(
        "SELECT contract_id, start_height FROM indexer_state WHERE id = 1",
      )
      .get() as { contract_id: string; start_height: number } | undefined;
    if (
      row &&
      (row.contract_id !== contractId || row.start_height !== startHeight)
    ) {
      this.db.close();
      throw new Error(
        "Indexer database belongs to a different contract or start height",
      );
    }
    if (!row)
      this.db
        .prepare(
          "INSERT INTO indexer_state(id, contract_id, start_height, last_height, updated_at) VALUES (1, ?, ?, ?, ?)",
        )
        .run(contractId, startHeight, startHeight - 1, Date.now());
    if (economyNeedsRebuild) this.rebuildAggregates();
  }

  close(): void {
    this.db.close();
  }

  cursor(): EventCursor {
    const row = this.db
      .prepare(
        "SELECT last_height, last_hash, last_timestamp_ns FROM indexer_state WHERE id = 1",
      )
      .get() as {
      last_height: number;
      last_hash: string | null;
      last_timestamp_ns: string | null;
    };
    return {
      height: row.last_height,
      hash: row.last_hash,
      timestampNs: row.last_timestamp_ns,
    };
  }

  applyAccountRange(
    checkpoint: { height: number; hash: string; timestampNs: string },
    blocks: FinalizedBlock[],
  ): number {
    const current = this.cursor();
    if (checkpoint.height <= current.height)
      throw new Error("Account range must advance the indexer cursor");
    if (
      !Number.isSafeInteger(checkpoint.height) ||
      checkpoint.height < this.startHeight ||
      !checkpoint.hash ||
      !/^\d+$/.test(checkpoint.timestampNs)
    )
      throw new Error("Invalid account backfill checkpoint");
    let priorHeight = current.height;
    for (const block of blocks) {
      if (
        block.source !== "history" ||
        block.height <= priorHeight ||
        block.height > checkpoint.height ||
        !block.hash ||
        !block.prevHash ||
        !/^\d+$/.test(block.timestampNs)
      )
        throw new Error("Invalid or unsorted account backfill block");
      priorHeight = block.height;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let inserted = 0;
      for (const block of blocks) {
        this.db
          .prepare(
            "INSERT INTO indexed_blocks(height, hash, prev_hash, timestamp_ns, source) VALUES (?, ?, ?, ?, 'history')",
          )
          .run(block.height, block.hash, block.prevHash, block.timestampNs);
        const day = dayOf(block.timestampNs);
        for (const entry of block.events) {
          const payload = entry.payload;
          const locationId =
            typeof payload.location_id === "string"
              ? payload.location_id
              : typeof payload.plot_id === "string"
                ? payload.plot_id
                : null;
          const facility =
            typeof payload.facility === "string" ? payload.facility : null;
          this.db
            .prepare(
              "INSERT INTO chain_events(event_id, receipt_id, log_index, data_index, block_height, block_day, event_name, location_id, facility, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              entry.id,
              entry.receiptId,
              entry.logIndex,
              entry.dataIndex,
              block.height,
              day,
              entry.event,
              locationId,
              facility,
              JSON.stringify(payload),
            );
          this.addAggregate(entry, day, locationId, facility);
          this.addEconomyAggregate(entry, day);
          inserted++;
        }
      }
      this.db
        .prepare(
          "UPDATE indexer_state SET last_height = ?, last_hash = ?, last_timestamp_ns = ?, updated_at = ? WHERE id = 1",
        )
        .run(
          checkpoint.height,
          checkpoint.hash,
          checkpoint.timestampNs,
          Date.now(),
        );
      this.db.exec("COMMIT");
      return inserted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  applyHeight(height: number, block: FinalizedBlock | null): number {
    const current = this.cursor();
    if (height <= current.height) {
      const known = this.db
        .prepare("SELECT hash FROM indexed_blocks WHERE height = ?")
        .get(height) as { hash: string } | undefined;
      if (known?.hash !== block?.hash && (known || block))
        throw new Error(`Finalized block changed at height ${height}`);
      return 0;
    }
    if (height !== current.height + 1)
      throw new Error(`Indexer height gap: expected ${current.height + 1}`);
    if (block && block.height !== height)
      throw new Error("Indexed block height mismatch");
    if (block && current.hash && block.prevHash !== current.hash)
      throw new Error(`Finalized chain linkage changed at height ${height}`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let inserted = 0;
      if (block) {
        this.db
          .prepare(
            "INSERT INTO indexed_blocks(height, hash, prev_hash, timestamp_ns, source) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            height,
            block.hash,
            block.prevHash,
            block.timestampNs,
            block.source,
          );
        const day = dayOf(block.timestampNs);
        for (const entry of block.events) {
          const payload = entry.payload;
          const locationId =
            typeof payload.location_id === "string"
              ? payload.location_id
              : typeof payload.plot_id === "string"
                ? payload.plot_id
                : null;
          const facility =
            typeof payload.facility === "string" ? payload.facility : null;
          const result = this.db
            .prepare(
              "INSERT INTO chain_events(event_id, receipt_id, log_index, data_index, block_height, block_day, event_name, location_id, facility, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              entry.id,
              entry.receiptId,
              entry.logIndex,
              entry.dataIndex,
              height,
              day,
              entry.event,
              locationId,
              facility,
              JSON.stringify(payload),
            );
          if (result.changes === 1) {
            inserted++;
            this.addAggregate(entry, day, locationId, facility);
            this.addEconomyAggregate(entry, day);
          }
        }
      }
      this.db
        .prepare(
          "UPDATE indexer_state SET last_height = ?, last_hash = ?, last_timestamp_ns = ?, updated_at = ? WHERE id = 1",
        )
        .run(
          height,
          block?.hash ?? current.hash,
          block?.timestampNs ?? current.timestampNs,
          Date.now(),
        );
      this.db.exec("COMMIT");
      return inserted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private addAggregate(
    entry: ChainEvent,
    day: string,
    locationId: string | null,
    facility: string | null,
  ): void {
    if (!locationId || facility !== "Curb") return;
    if (!["parked", "collected", "expired", "ticketed"].includes(entry.event))
      return;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO plot_daily_stats(plot_id, day) VALUES (?, ?)",
      )
      .run(locationId, day);
    const row = this.db
      .prepare(
        "SELECT parks, collections, expiries, tickets, gross, driver_payout, recipient_payout, forfeited FROM plot_daily_stats WHERE plot_id = ? AND day = ?",
      )
      .get(locationId, day) as {
      parks: number;
      collections: number;
      expiries: number;
      tickets: number;
      gross: string;
      driver_payout: string;
      recipient_payout: string;
      forfeited: string;
    };
    const settled = entry.event !== "parked";
    const payload = entry.payload;
    this.db
      .prepare(
        "UPDATE plot_daily_stats SET parks = ?, collections = ?, expiries = ?, tickets = ?, gross = ?, driver_payout = ?, recipient_payout = ?, forfeited = ? WHERE plot_id = ? AND day = ?",
      )
      .run(
        row.parks + Number(entry.event === "parked"),
        row.collections + Number(entry.event === "collected"),
        row.expiries + Number(entry.event === "expired"),
        row.tickets + Number(entry.event === "ticketed"),
        (coin(row.gross) + (settled ? coin(payload.gross) : 0n)).toString(),
        (
          coin(row.driver_payout) + (settled ? coin(payload.driver_payout) : 0n)
        ).toString(),
        (
          coin(row.recipient_payout) +
          (settled ? coin(payload.recipient_payout) : 0n)
        ).toString(),
        (
          coin(row.forfeited) + (settled ? coin(payload.forfeited) : 0n)
        ).toString(),
        locationId,
        day,
      );
  }

  private addEconomyAggregate(entry: ChainEvent, day: string): void {
    const name = entry.event;
    if (
      ![
        "parked",
        "collected",
        "expired",
        "ticketed",
        "inspection_attempted",
        "car_repaired",
        "car_upgraded",
        "building_updated",
        "player_registered",
        "car_minted",
        "cosmetic_bought",
      ].includes(name)
    )
      return;
    const payload = entry.payload;
    const settled = ["collected", "expired", "ticketed"].includes(name);
    const cost = payload.cost === undefined ? 0n : coin(payload.cost);
    const grant = payload.grant === undefined ? 0n : coin(payload.grant);
    const unpricedCost =
      (name === "car_minted" || name === "cosmetic_bought") &&
      payload.cost === undefined;
    const unpricedGrant =
      name === "player_registered" && payload.grant === undefined;
    this.db
      .prepare("INSERT OR IGNORE INTO economy_daily_stats(day) VALUES (?)")
      .run(day);
    const row = this.db
      .prepare("SELECT * FROM economy_daily_stats WHERE day = ?")
      .get(day) as {
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
      starter_grants: string;
      unpriced_cost_events: number;
      unpriced_grant_events: number;
    };
    this.db
      .prepare(
        "UPDATE economy_daily_stats SET curb_parks = ?, tower_parks = ?, collections = ?, expiries = ?, tickets = ?, inspector_attempts = ?, inspector_successes = ?, gross = ?, driver_payout = ?, recipient_payout = ?, forfeited = ?, known_coin_costs = ?, starter_grants = ?, unpriced_cost_events = ?, unpriced_grant_events = ? WHERE day = ?",
      )
      .run(
        row.curb_parks +
          Number(name === "parked" && payload.facility === "Curb"),
        row.tower_parks +
          Number(name === "parked" && payload.facility === "Tower"),
        row.collections + Number(name === "collected"),
        row.expiries + Number(name === "expired"),
        row.tickets + Number(name === "ticketed"),
        row.inspector_attempts + Number(name === "inspection_attempted"),
        row.inspector_successes +
          Number(name === "inspection_attempted" && payload.success === true),
        (coin(row.gross) + (settled ? coin(payload.gross) : 0n)).toString(),
        (
          coin(row.driver_payout) + (settled ? coin(payload.driver_payout) : 0n)
        ).toString(),
        (
          coin(row.recipient_payout) +
          (settled ? coin(payload.recipient_payout) : 0n)
        ).toString(),
        (
          coin(row.forfeited) + (settled ? coin(payload.forfeited) : 0n)
        ).toString(),
        (coin(row.known_coin_costs) + cost).toString(),
        (coin(row.starter_grants) + grant).toString(),
        row.unpriced_cost_events + Number(unpricedCost),
        row.unpriced_grant_events + Number(unpricedGrant),
        day,
      );
  }

  rebuildAggregates(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM plot_daily_stats");
      this.db.exec("DELETE FROM economy_daily_stats");
      const events = this.db
        .prepare(
          "SELECT event_id, receipt_id, log_index, data_index, block_day, event_name, location_id, facility, payload_json FROM chain_events ORDER BY block_height, receipt_id, log_index, data_index",
        )
        .all() as {
        event_id: string;
        receipt_id: string;
        log_index: number;
        data_index: number;
        block_day: string;
        event_name: GameEvent["event"];
        location_id: string | null;
        facility: string | null;
        payload_json: string;
      }[];
      for (const row of events) {
        const entry: ChainEvent = {
          id: row.event_id,
          receiptId: row.receipt_id,
          logIndex: row.log_index,
          dataIndex: row.data_index,
          event: row.event_name,
          payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        };
        this.addAggregate(entry, row.block_day, row.location_id, row.facility);
        this.addEconomyAggregate(entry, row.block_day);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
