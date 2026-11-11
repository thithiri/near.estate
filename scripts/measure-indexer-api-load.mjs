#!/usr/bin/env node
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiApp } from "../services/api/dist/app.js";
import { ImpressionLedger } from "../services/api/dist/impression-ledger.js";
import { ApiStore } from "../services/api/dist/store.js";
import { EventStore } from "../services/worker/dist/event-store.js";

const contractId = "estate-concurrent-load.testnet";
const blocks = 1_000;
const pairsPerBlock = 5;
const plotIds = JSON.parse(
  readFileSync(
    new URL("../contracts/estate/seed.json", import.meta.url),
    "utf8",
  ),
).plots.map((plot) => plot.id);
assert.equal(plotIds.length, 80);

function blockAt(height, timestampNs) {
  const events = [];
  for (let pair = 0; pair < pairsPerBlock; pair++) {
    const sessionId = (height - 1) * pairsPerBlock + pair + 1;
    const locationId = plotIds[(sessionId - 1) % plotIds.length];
    for (const event of ["parked", "collected"]) {
      const receiptId = `${event}-${height}-${pair}`;
      events.push({
        id: `${receiptId}:0:0`,
        receiptId,
        logIndex: 0,
        dataIndex: 0,
        event,
        payload:
          event === "parked"
            ? {
                session_id: sessionId,
                car_id: sessionId,
                driver: "driver.testnet",
                location_id: locationId,
                slot: 0,
                facility: "Curb",
                legal: true,
                expires_at: 1_800_000,
              }
            : {
                session_id: sessionId,
                location_id: locationId,
                slot: 0,
                facility: "Curb",
                gross: "1000000",
                driver_payout: "1000000",
                recipient_payout: "0",
                forfeited: "0",
              },
      });
    }
  }
  return {
    height,
    hash: `hash-${height}`,
    prevHash: `hash-${height - 1}`,
    timestampNs,
    source: "neardata",
    events,
  };
}

function writeBlocks(databasePath, timestampNs) {
  const store = new EventStore(databasePath, contractId, 1);
  process.send?.({ type: "ready" });
  process.once("message", ({ type }) => {
    if (type !== "start") throw new Error("Unexpected load command");
    try {
      const started = performance.now();
      for (let height = 1; height <= blocks; height++)
        store.applyHeight(height, blockAt(height, timestampNs));
      process.send?.({
        type: "done",
        writerMs: Math.round(performance.now() - started),
      });
      store.close();
      process.disconnect();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
      process.disconnect();
    }
  });
}

function percentile(sorted, fraction) {
  return Number(
    (sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0).toFixed(2),
  );
}

async function readDuringWrite() {
  const directory = mkdtempSync(join(tmpdir(), "estate-api-indexer-load-"));
  const databasePath = join(directory, "estate.sqlite");
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const timestampNs = String(BigInt(nowSeconds) * 1_000_000_000n);
  const store = new ApiStore(databasePath, join(directory, "assets"));
  new ImpressionLedger(store.db);
  const app = createApiApp({
    store,
    chain: null,
    appOrigin: "http://localhost:8080",
    clock: () => nowSeconds,
  });
  const child = fork(
    fileURLToPath(import.meta.url),
    ["--writer", databasePath, timestampNs],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let completed = false;
  let childExitCode = null;
  let childError = "";
  let writerMs = null;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (childError += chunk));
  child.on("exit", (code) => {
    childExitCode = code;
    completed = true;
  });
  child.on("message", (message) => {
    if (message.type === "done") writerMs = message.writerMs;
  });
  const childExit = new Promise((resolve) => child.once("exit", resolve));
  const latencies = [];
  const partialHeights = new Set();
  let requests = 0;
  let minimumHeight = blocks;
  let maximumHeight = 0;
  try {
    await new Promise((resolve, reject) => {
      const exitedBeforeReady = (code) =>
        reject(
          new Error(`Writer exited before ready (${code}): ${childError}`),
        );
      child.once("exit", exitedBeforeReady);
      child.once("message", (message) => {
        child.off("exit", exitedBeforeReady);
        if (message.type === "ready") resolve();
        else reject(new Error("Writer did not initialize"));
      });
      child.once("error", reject);
    });
    child.send({ type: "start" });
    const deadline = Date.now() + 30_000;
    while (!completed || requests < 2) {
      assert.ok(Date.now() < deadline, "Concurrent load exceeded 30 seconds");
      const route =
        requests % 2 ? `/stats/plots/${plotIds[0]}` : "/stats/economy";
      const started = performance.now();
      const response = await app.request(`http://localhost:8080${route}`);
      const body = await response.json();
      latencies.push(performance.now() - started);
      assert.equal(response.status, 200);
      const height = route.endsWith("economy")
        ? (body.indexedThroughHeight ?? 0)
        : (body.freshness.indexedThroughHeight ?? 0);
      const parks = route.endsWith("economy")
        ? body.totals.curbParks
        : body.totals.parks;
      const expected = route.endsWith("economy")
        ? height * pairsPerBlock
        : Math.ceil((height * pairsPerBlock) / plotIds.length);
      assert.equal(parks, expected, `Stats and cursor diverged at ${route}`);
      if (height > 0 && height < blocks) partialHeights.add(height);
      minimumHeight = Math.min(minimumHeight, height);
      maximumHeight = Math.max(maximumHeight, height);
      requests++;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(childExitCode, 0, childError);
    assert.ok(Number.isSafeInteger(writerMs) && writerMs > 0);
    assert.ok(
      partialHeights.size > 0,
      "No reads overlapped with indexer writes",
    );
    for (const route of ["/stats/economy", `/stats/plots/${plotIds[0]}`]) {
      const response = await app.request(`http://localhost:8080${route}`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(
        route.endsWith("economy")
          ? body.indexedThroughHeight
          : body.freshness.indexedThroughHeight,
        blocks,
      );
    }
    const sorted = latencies.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        result: "passed",
        capturedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        blocks,
        events: blocks * pairsPerBlock * 2,
        writerMs,
        apiRequests: requests,
        partialHeightsObserved: partialHeights.size,
        minHeightObserved: minimumHeight,
        maxHeightObserved: maximumHeight,
        requestLatencyMs: {
          median: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
          max: Number((sorted.at(-1) ?? 0).toFixed(2)),
        },
        limits:
          "Local separate SQLite writer process and in-process API route requests; excludes network, provider, VPS disk and long-duration traffic",
      }),
    );
  } finally {
    if (!completed) {
      child.kill("SIGTERM");
      await childExit;
    }
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--writer")
  writeBlocks(process.argv[3], process.argv[4]);
else await readDuringWrite();
