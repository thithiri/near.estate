import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const dataDir = process.env.API_DATA_DIR;
if (!dataDir) throw new Error("Set API_DATA_DIR to the indexed city database");
const journey = JSON.parse(
  readFileSync(
    new URL("../deployments/testnet-tower-floor-journey.json", import.meta.url),
    "utf8",
  ),
);
const deployment = JSON.parse(
  readFileSync(new URL("../deployments/testnet.json", import.meta.url), "utf8"),
);
assert.equal(journey.contractId, deployment.contractId);
assert.equal(journey.space, 16);

const db = new DatabaseSync(join(dataDir, "estate.sqlite"), {
  readOnly: true,
});
try {
  const cursor = db
    .prepare(
      "SELECT contract_id, last_height, last_hash FROM indexer_state WHERE id = 1",
    )
    .get();
  assert.equal(cursor.contract_id, journey.contractId);
  assert.ok(cursor.last_height > 0 && cursor.last_hash);

  const towerEvents = db
    .prepare(
      "SELECT event_name, receipt_id, block_height, block_day, payload_json FROM chain_events WHERE facility = 'Tower' AND location_id = ? ORDER BY block_height",
    )
    .all("npc-main-tower")
    .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }))
    .filter((row) => row.payload.session_id === journey.sessionId);
  assert.deepEqual(
    towerEvents.map((event) => event.event_name),
    ["parked", "collected"],
    "one tower session must have exactly one park and one collection",
  );
  const [parked, collected] = towerEvents;
  assert.equal(parked.payload.driver, journey.driverId);
  assert.equal(parked.payload.slot, journey.space);
  assert.equal(parked.payload.legal, true);
  assert.equal(collected.payload.slot, journey.space);
  assert.equal(collected.payload.gross, journey.gross);
  assert.equal(collected.payload.driver_payout, journey.driverPayout);
  assert.ok(cursor.last_height >= collected.block_height);

  const allEvents = db
    .prepare(
      "SELECT event_name, block_day, facility, payload_json FROM chain_events",
    )
    .all();
  const expectedByDay = new Map();
  for (const entry of allEvents) {
    const totals = expectedByDay.get(entry.block_day) ?? {
      towerParks: 0,
      collections: 0,
      gross: 0n,
      driverPayout: 0n,
    };
    if (entry.event_name === "parked" && entry.facility === "Tower")
      totals.towerParks++;
    if (entry.event_name === "collected") totals.collections++;
    if (["collected", "expired", "ticketed"].includes(entry.event_name)) {
      const payload = JSON.parse(entry.payload_json);
      totals.gross += BigInt(payload.gross);
      totals.driverPayout += BigInt(payload.driver_payout);
    }
    expectedByDay.set(entry.block_day, totals);
  }
  const economy = db
    .prepare(
      "SELECT day, tower_parks, collections, gross, driver_payout FROM economy_daily_stats ORDER BY day",
    )
    .all();
  for (const day of economy) {
    const expected = expectedByDay.get(day.day);
    assert.ok(expected, `economy day ${day.day} has no indexed events`);
    assert.equal(day.tower_parks, expected.towerParks);
    assert.equal(day.collections, expected.collections);
    assert.equal(day.gross, expected.gross.toString());
    assert.equal(day.driver_payout, expected.driverPayout.toString());
  }
  assert.ok(economy.some((day) => day.tower_parks >= 1));
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM plot_daily_stats WHERE plot_id = ?",
      )
      .get("npc-main-tower").count,
    0,
    "tower activity must not enter player-plot statistics",
  );

  const evidence = {
    network: "testnet",
    contractId: journey.contractId,
    indexedThroughHeight: cursor.last_height,
    indexedThroughHash: cursor.last_hash,
    towerSessionId: journey.sessionId,
    towerSpace: journey.space,
    parkReceiptId: parked.receipt_id,
    parkBlockHeight: parked.block_height,
    collectReceiptId: collected.receipt_id,
    collectBlockHeight: collected.block_height,
    towerParks: economy.reduce((sum, day) => sum + day.tower_parks, 0),
    collections: economy.reduce((sum, day) => sum + day.collections, 0),
    gross: economy.reduce((sum, day) => sum + BigInt(day.gross), 0n).toString(),
    driverPayout: economy
      .reduce((sum, day) => sum + BigInt(day.driver_payout), 0n)
      .toString(),
  };
  writeFileSync(
    new URL("../deployments/testnet-tower-floor-indexed.json", import.meta.url),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence));
} finally {
  db.close();
}
