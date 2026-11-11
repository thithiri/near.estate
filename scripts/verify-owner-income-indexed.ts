import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApiApp } from "../services/api/src/app.js";
import { ApiStore } from "../services/api/src/store.js";

const root = resolve(import.meta.dirname, "..");
const dataDir = process.env.ESTATE_MEDIA_DATA_DIR;
if (!dataDir || !dataDir.startsWith("/") || dataDir.startsWith(`${root}/`))
  throw new Error("Set ESTATE_MEDIA_DATA_DIR outside the repository");
const journey = JSON.parse(
  readFileSync(
    resolve(root, "deployments/testnet-owner-income-journey.json"),
    "utf8",
  ),
) as {
  contractId: string;
  ownerId: string;
  balanceAtomic: string;
  completedCycles: Array<{
    sessionId: number;
    carId: number;
    plotId: string;
    slot: number;
    parkHash: string;
    settleHash: string;
    earnedAtomic: string;
  }>;
};
assert(journey.completedCycles.length > 0, "No settled income cycles");

type EventRow = {
  block_height: number;
  event_name: string;
  location_id: string | null;
  payload_json: string;
};
const db = new DatabaseSync(join(dataDir, "estate.sqlite"), {
  readOnly: true,
});
const verified: Array<{
  sessionId: number;
  plotId: string;
  parkBlock: number;
  settlementBlock: number;
  settlementEvent: string;
  driverPayoutAtomic: string;
}> = [];
try {
  const findEvents = db.prepare(
    "SELECT block_height, event_name, location_id, payload_json FROM chain_events WHERE json_extract(payload_json, '$.session_id') = ? ORDER BY block_height",
  );
  for (const cycle of journey.completedCycles) {
    assert(cycle.parkHash && cycle.settleHash);
    const events = findEvents.all(cycle.sessionId) as EventRow[];
    const parked = events.filter((event) => event.event_name === "parked");
    const settled = events.filter((event) =>
      ["collected", "expired"].includes(event.event_name),
    );
    assert.equal(parked.length, 1, `Session ${cycle.sessionId} park event`);
    assert.equal(
      settled.length,
      1,
      `Session ${cycle.sessionId} settlement event`,
    );
    assert(!events.some((event) => event.event_name === "ticketed"));
    const park = JSON.parse(parked[0]!.payload_json) as {
      car_id: number;
      driver: string;
      location_id: string;
      slot: number;
      legal: boolean;
    };
    const settlement = JSON.parse(settled[0]!.payload_json) as {
      location_id: string;
      slot: number;
      gross: string;
      driver_payout: string;
      recipient_payout: string;
      forfeited: string;
    };
    assert.equal(park.driver, journey.ownerId);
    assert.equal(park.car_id, cycle.carId);
    assert.equal(park.location_id, cycle.plotId);
    assert.equal(park.slot, cycle.slot);
    assert.equal(park.legal, true);
    assert.equal(settlement.location_id, cycle.plotId);
    assert.equal(settlement.slot, cycle.slot);
    assert.equal(settlement.gross, cycle.earnedAtomic);
    assert.equal(settlement.driver_payout, cycle.earnedAtomic);
    assert.equal(settlement.recipient_payout, "0");
    assert.equal(settlement.forfeited, "0");
    verified.push({
      sessionId: cycle.sessionId,
      plotId: cycle.plotId,
      parkBlock: parked[0]!.block_height,
      settlementBlock: settled[0]!.block_height,
      settlementEvent: settled[0]!.event_name,
      driverPayoutAtomic: settlement.driver_payout,
    });
  }
} finally {
  db.close();
}

const store = new ApiStore(
  join(dataDir, "estate.sqlite"),
  join(dataDir, "assets"),
);
try {
  const app = createApiApp({
    store,
    chain: null,
    appOrigin: "http://localhost:8080",
  });
  const plotId = journey.completedCycles[0]!.plotId;
  assert(journey.completedCycles.every((cycle) => cycle.plotId === plotId));
  const response = await app.request(`/stats/plots/${plotId}`);
  assert.equal(response.status, 200);
  const stats = (await response.json()) as {
    totals: { parks: number; tickets: number };
    freshness: { indexedThroughHeight: number | null };
  };
  assert(stats.totals.parks >= journey.completedCycles.length);
  assert.equal(stats.totals.tickets, 0);
  assert(
    stats.freshness.indexedThroughHeight !== null &&
      stats.freshness.indexedThroughHeight >=
        Math.max(...verified.map((cycle) => cycle.settlementBlock)),
  );
  const evidence = {
    network: "testnet",
    contractId: journey.contractId,
    ownerId: journey.ownerId,
    plotId,
    verifiedCycles: verified,
    publicPlotStats: {
      totals: stats.totals,
      freshness: stats.freshness,
    },
  };
  writeFileSync(
    resolve(root, "deployments/testnet-owner-income-indexed.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  store.close();
}
