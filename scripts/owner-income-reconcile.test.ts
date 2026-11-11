import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { reconcileIndexedOwnerIncome } from "./owner-income-reconcile.js";

test("external settlement needs matching finalized events and exact owner balance", () => {
  const directory = mkdtempSync(join(tmpdir(), "estate-income-"));
  const path = join(directory, "estate.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE indexer_state (id INTEGER PRIMARY KEY, contract_id TEXT);
      CREATE TABLE chain_events (
        block_height INTEGER,
        receipt_id TEXT,
        event_name TEXT,
        payload_json TEXT
      );
    `);
    db.prepare("INSERT INTO indexer_state VALUES (1, ?)").run("city.testnet");
    const insert = db.prepare("INSERT INTO chain_events VALUES (?, ?, ?, ?)");
    insert.run(
      10,
      "park-receipt",
      "parked",
      JSON.stringify({
        session_id: 8,
        driver: "owner.testnet",
        car_id: 3,
        location_id: "plot-river-s-0",
        slot: 0,
        legal: true,
      }),
    );
    insert.run(
      20,
      "settle-receipt",
      "expired",
      JSON.stringify({
        session_id: 8,
        location_id: "plot-river-s-0",
        slot: 0,
        gross: "30000000",
        driver_payout: "30000000",
        recipient_payout: "0",
        forfeited: "0",
      }),
    );
    db.close();
    const cycle = {
      sessionId: 8,
      carId: 3,
      plotId: "plot-river-s-0",
      slot: 0,
      balanceAtPark: "160002222",
    };
    assert.deepEqual(
      reconcileIndexedOwnerIncome(
        path,
        "city.testnet",
        "owner.testnet",
        cycle,
        "190002222",
      ),
      { receiptId: "settle-receipt", earnedAtomic: "30000000" },
    );
    assert.throws(() =>
      reconcileIndexedOwnerIncome(
        path,
        "city.testnet",
        "owner.testnet",
        cycle,
        "190002221",
      ),
    );
    assert.throws(() =>
      reconcileIndexedOwnerIncome(
        path,
        "another-city.testnet",
        "owner.testnet",
        cycle,
        "190002222",
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
