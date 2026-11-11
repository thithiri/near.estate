import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
const runTag = process.env.ESTATE_CONTEST_RUN_TAG ?? null;
if (runTag) assert.match(runTag, /^[a-z0-9-]{1,32}$/);
const suffix = runTag ? `-${runTag}` : "";
const dataDir = process.env.API_DATA_DIR;
if (!dataDir) throw new Error("Set API_DATA_DIR to the indexed city database");
const journey = JSON.parse(
  readFileSync(
    resolve(root, `deployments/testnet-contested-curb-journey${suffix}.json`),
    "utf8",
  ),
);
const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
);
assert.equal(journey.contractId, deployment.contractId);
const db = new DatabaseSync(join(dataDir, "estate.sqlite"), { readOnly: true });
try {
  const cursor = db
    .prepare(
      "SELECT contract_id, last_height, last_timestamp_ns FROM indexer_state WHERE id = 1",
    )
    .get();
  assert.equal(cursor?.contract_id, journey.contractId);
  assert(
    Date.now() - Number(BigInt(cursor.last_timestamp_ns) / 1_000_000n) <
      600_000,
    "Event indexer is over ten minutes behind",
  );
  const plotEvents = db
    .prepare(
      "SELECT event_name, receipt_id, block_height, payload_json FROM chain_events WHERE location_id = ? AND event_name IN ('parked', 'collected', 'ticketed', 'expired') ORDER BY block_height, event_id",
    )
    .all(journey.plotId)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  const events = plotEvents.filter(
    (entry) => entry.payload.session_id === journey.sessionId,
  );
  assert.deepEqual(
    events.map((entry) => entry.event_name),
    ["parked", "collected"],
    "The failed park must not create an event or a second settlement",
  );
  assert.equal(events[0].payload.session_id, journey.sessionId);
  assert.equal(events[0].payload.driver, journey.winnerId);
  assert.equal(events[0].payload.slot, journey.slot);
  assert.equal(events[1].payload.session_id, journey.sessionId);
  assert(cursor.last_height >= events[1].block_height);
  const loserReceiptEventCount = db
    .prepare("SELECT COUNT(*) AS count FROM chain_events WHERE receipt_id = ?")
    .get(journey.loserReceiptId).count;
  assert.equal(loserReceiptEventCount, 0);
  const totals = db
    .prepare(
      "SELECT SUM(parks) AS parks, SUM(collections) AS collections, SUM(tickets) AS tickets FROM plot_daily_stats WHERE plot_id = ?",
    )
    .get(journey.plotId);
  assert(totals.parks >= 1);
  assert(totals.collections >= 1);
  const evidence = {
    contractId: journey.contractId,
    codeSha256: journey.codeSha256 ?? null,
    runTag,
    plotId: journey.plotId,
    slot: journey.slot,
    sessionId: journey.sessionId,
    winnerId: journey.winnerId,
    loserId: journey.loserId,
    loserReceiptId: journey.loserReceiptId,
    loserReceiptEventCount,
    winnerParkReceiptId: events[0].receipt_id,
    collectionReceiptId: events[1].receipt_id,
    eventNames: events.map((entry) => entry.event_name),
    parks: totals.parks,
    collections: totals.collections,
    tickets: totals.tickets,
    indexedThroughHeight: cursor.last_height,
    observedAt: new Date().toISOString(),
  };
  writeFileSync(
    resolve(root, `deployments/testnet-contested-curb-indexed${suffix}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  db.close();
}
