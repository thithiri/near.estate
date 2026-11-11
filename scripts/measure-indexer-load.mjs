#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../services/worker/dist/event-store.js";

const contractId = "estate-load.testnet";
const timestampNs = "1794316011248367505";
const blockCount = 1_000;
const pairsPerBlock = 5;
const directory = mkdtempSync(join(tmpdir(), "estate-indexer-load-"));
const databasePath = join(directory, "estate.sqlite");

function eventPair(height, pair) {
  const sessionId = (height - 1) * pairsPerBlock + pair + 1;
  const locationId = `plot-${sessionId % 80}`;
  const parkReceipt = `park-${height}-${pair}`;
  const collectReceipt = `collect-${height}-${pair}`;
  return [
    {
      id: `${parkReceipt}:0:0`,
      receiptId: parkReceipt,
      logIndex: 0,
      dataIndex: 0,
      event: "parked",
      payload: {
        session_id: sessionId,
        car_id: sessionId,
        driver: "driver.testnet",
        location_id: locationId,
        slot: 0,
        facility: "Curb",
        legal: true,
        expires_at: 1_800_000,
      },
    },
    {
      id: `${collectReceipt}:0:0`,
      receiptId: collectReceipt,
      logIndex: 0,
      dataIndex: 0,
      event: "collected",
      payload: {
        session_id: sessionId,
        location_id: locationId,
        slot: 0,
        facility: "Curb",
        gross: "1000000",
        driver_payout: "1000000",
        recipient_payout: "0",
        forfeited: "0",
      },
    },
  ];
}

try {
  const store = new EventStore(databasePath, contractId, 1);
  let inserted = 0;
  let insertMs;
  let before;
  try {
    const started = performance.now();
    for (let height = 1; height <= blockCount; height++) {
      const events = Array.from({ length: pairsPerBlock }, (_, pair) =>
        eventPair(height, pair),
      ).flat();
      inserted += store.applyHeight(height, {
        height,
        hash: `hash-${height}`,
        prevHash: `hash-${height - 1}`,
        timestampNs,
        source: "neardata",
        events,
      });
    }
    insertMs = Math.round(performance.now() - started);
    before = store.db.prepare("SELECT * FROM economy_daily_stats").get();
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM chain_events").get()
        .count,
      blockCount * pairsPerBlock * 2,
    );
  } finally {
    store.close();
  }

  const reopened = new EventStore(databasePath, contractId, 1);
  try {
    assert.deepEqual(reopened.cursor(), {
      height: blockCount,
      hash: `hash-${blockCount}`,
      timestampNs,
    });
    const rebuildStarted = performance.now();
    reopened.rebuildAggregates();
    const rebuildMs = Math.round(performance.now() - rebuildStarted);
    const after = reopened.db
      .prepare("SELECT * FROM economy_daily_stats")
      .get();
    assert.deepEqual(after, before);
    assert.equal(after.curb_parks, blockCount * pairsPerBlock);
    assert.equal(after.collections, blockCount * pairsPerBlock);
    assert.equal(after.gross, String(blockCount * pairsPerBlock * 1_000_000));
    const replayed = reopened.applyHeight(blockCount, {
      height: blockCount,
      hash: `hash-${blockCount}`,
      prevHash: `hash-${blockCount - 1}`,
      timestampNs,
      source: "neardata",
      events: [],
    });
    assert.equal(replayed, 0);
    console.log(
      JSON.stringify({
        result: "passed",
        capturedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        scenario:
          "Five curb park/collect pairs per block across 80 plots with a fixed block date; no RPC or provider traffic",
        blocks: blockCount,
        events: inserted,
        insertMs,
        eventsPerSecond: Math.round((inserted * 1_000) / insertMs),
        rebuildMs,
        cursor: reopened.cursor(),
        curbParks: after.curb_parks,
        collections: after.collections,
        gross: after.gross,
        replayed,
        limits:
          "One local process and disk; excludes provider pagination, network throttling, concurrent API traffic and VPS operation",
      }),
    );
  } finally {
    reopened.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
