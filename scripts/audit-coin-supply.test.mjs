import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { auditCoinSupply } from "./audit-coin-supply.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE indexer_state (id INTEGER, contract_id TEXT, start_height INTEGER, last_height INTEGER, last_hash TEXT);
    INSERT INTO indexer_state VALUES (1, 'city.testnet', 2, 10, 'final-hash');
    CREATE TABLE chain_events (receipt_id TEXT, block_height INTEGER, event_name TEXT, payload_json TEXT, log_index INTEGER, data_index INTEGER);
  `);
  const insert = db.prepare(
    "INSERT INTO chain_events VALUES (?, ?, ?, ?, 0, 0)",
  );
  insert.run(
    "register",
    2,
    "player_registered",
    JSON.stringify({
      account_id: "driver.testnet",
      starter_car_id: 1,
    }),
  );
  insert.run(
    "register",
    2,
    "car_minted",
    JSON.stringify({
      car_id: 1,
      owner: "driver.testnet",
    }),
  );
  insert.run(
    "collect",
    3,
    "collected",
    JSON.stringify({
      gross: "100000000",
      driver_payout: "90000000",
      recipient_payout: "10000000",
      forfeited: "0",
    }),
  );
  insert.run(
    "purchase",
    4,
    "car_minted",
    JSON.stringify({
      car_id: 2,
      owner: "driver.testnet",
    }),
  );
  insert.run(
    "repair",
    5,
    "car_repaired",
    JSON.stringify({
      car_id: 1,
      points: 2,
      cost: "2000000",
    }),
  );
  return db;
}

function rpc(balance = "38000000", beforeStartMissing = false) {
  return async (method, params) => {
    if (method === "block") return { header: { hash: "final-hash" } };
    if (params.request_type === "view_code")
      return beforeStartMissing
        ? { rpcError: { cause: { name: "UNKNOWN_ACCOUNT" } } }
        : { code_hash: "existing" };
    if (params.method_name === "get_config")
      return {
        result: [
          ...Buffer.from(
            JSON.stringify({
              starter_coins: "100000000",
              buy_car_cost: "150000000",
            }),
          ),
        ],
      };
    if (params.method_name === "get_account")
      return { result: [...Buffer.from(JSON.stringify({ balance }))] };
    if (params.method_name === "get_car") {
      const { car_id: id } = JSON.parse(
        Buffer.from(params.args_base64, "base64").toString("utf8"),
      );
      return {
        result: [
          ...Buffer.from(
            JSON.stringify(id <= 2 ? { id, owner: "driver.testnet" } : null),
          ),
        ],
      };
    }
    if (params.method_name === "get_treasury_coins")
      return { result: [...Buffer.from('"10000000"')] };
    throw new Error("Unexpected RPC call");
  };
}

test("coin audit backfills legacy amounts and reconciles finalized balances", async () => {
  const db = fixture();
  try {
    const report = await auditCoinSupply(db, rpc(), "city.testnet");
    assert.equal(report.archivedAmountBackfills, 3);
    assert.equal(report.observedCars, 2);
    assert.equal(report.grants, "100000000");
    assert.equal(report.settlementPayouts, "100000000");
    assert.equal(report.spending, "152000000");
    assert.equal(report.expectedOutstanding, "48000000");
    assert.equal(report.observedOutstanding, "48000000");
    assert.equal(report.balancesMatch, true);
    assert.equal(report.historyCoverage, "not_proven_by_this_audit");
    assert.equal(report.currentSupplyVerified, false);
    const verified = await auditCoinSupply(
      db,
      rpc("38000000", true),
      "city.testnet",
    );
    assert.equal(verified.currentSupplyVerified, true);
    const mismatch = await auditCoinSupply(db, rpc("37000000"), "city.testnet");
    assert.equal(mismatch.balancesMatch, false);
  } finally {
    db.close();
  }
});

test("coin audit refuses ambiguous historical config changes", async () => {
  const db = fixture();
  try {
    db.prepare(
      "INSERT INTO chain_events VALUES ('config', 4, 'config_updated', '{}', 0, 0)",
    ).run();
    await assert.rejects(
      auditCoinSupply(db, rpc(), "city.testnet"),
      /Config changed in amount-backfill block 4/,
    );
  } finally {
    db.close();
  }
});
