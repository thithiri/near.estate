import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const journey = JSON.parse(
  readFileSync(
    resolve(root, "deployments/testnet-two-account-ticket-journey.json"),
    "utf8",
  ),
);
const origin = process.env.ESTATE_API_ORIGIN ?? "http://localhost:3000";
const response = await fetch(
  new URL(`/stats/plots/${encodeURIComponent(journey.plotId)}`, origin),
  { signal: AbortSignal.timeout(20_000) },
);
assert.equal(response.status, 200, "Plot statistics are unavailable");
const stats = await response.json();
assert.equal(stats.plotId, journey.plotId);
assert(stats.totals.parks >= 1, "Indexed park is missing");
assert(stats.totals.tickets >= 1, "Indexed ticket is missing");
assert(stats.freshness.indexedThroughHeight > 0);
assert(
  Date.now() - stats.freshness.indexedThroughAt < 600_000,
  "Event indexer is over ten minutes behind",
);
const evidence = {
  contractId: journey.contractId,
  plotId: journey.plotId,
  sessionId: journey.sessionId,
  parkTransactionHash: journey.transactions.find(
    (entry) => entry.method === "park",
  )?.hash,
  ticketTransactionHash: journey.transactions.find(
    (entry) => entry.method === "ticket",
  )?.hash,
  parks: stats.totals.parks,
  tickets: stats.totals.tickets,
  indexedThroughHeight: stats.freshness.indexedThroughHeight,
  indexedThroughAt: stats.freshness.indexedThroughAt,
  observedAt: new Date().toISOString(),
};
assert(evidence.parkTransactionHash && evidence.ticketTransactionHash);
writeFileSync(
  resolve(root, "deployments/testnet-two-account-ticket-indexed.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence, null, 2));
