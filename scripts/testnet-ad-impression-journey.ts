import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ImpressionReporter } from "../apps/web/src/impressions.js";
import { createApiApp } from "../services/api/src/app.js";
import { NearChainGateway } from "../services/api/src/chain.js";
import { ApiStore } from "../services/api/src/store.js";

if (process.argv.slice(2).join(" ") !== "--apply")
  throw new Error("Pass --apply to run the published-ad impression journey");
const root = resolve(import.meta.dirname, "..");
const dataDir = process.env.ESTATE_MEDIA_DATA_DIR;
if (!dataDir || !dataDir.startsWith("/"))
  throw new Error("Set ESTATE_MEDIA_DATA_DIR to the private shared-media path");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (realpathSync(dataDir).startsWith(`${root}/`))
  throw new Error("Impression data must stay outside the repository");
const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
) as { contractId: string; network: string };
const billboard = JSON.parse(
  readFileSync(
    resolve(root, "deployments/testnet-shared-billboard-journey.json"),
    "utf8",
  ),
) as { contractId: string; plotId: string; billboardHash: string };
assert.equal(deployment.network, "testnet");
assert.equal(deployment.contractId, billboard.contractId);
const plotId = billboard.plotId;
const chain = new NearChainGateway(deployment.contractId);
const plot = await chain.plot(plotId);
assert.equal(plot?.billboard_eligible, true);
assert.equal(
  plot.plot.billboard.active?.content.asset_hash,
  billboard.billboardHash,
);

const databasePath = resolve(dataDir, "estate.sqlite");
const assetsPath = resolve(dataDir, "assets");
const store = new ApiStore(databasePath, assetsPath);
const origin = "http://localhost:8080";
const app = createApiApp({ store, chain, appOrigin: origin });
type Stats = {
  totals: { impressions: number; dwellMs: number; averageVisibleMs: number };
  freshness: { impressionReceivedAt: number | null };
};
async function stats(api: typeof app): Promise<Stats> {
  const response = await api.request(`/stats/plots/${plotId}`);
  assert.equal(response.status, 200);
  return (await response.json()) as Stats;
}
const before = await stats(app);
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
    removeItem: (name: string) => {
      values.delete(name);
    },
  },
});
const nativeFetch = globalThis.fetch;
let cookie: string | null = null;
let dropOneReply = true;
const sentIds: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("/api/")) return nativeFetch(input, init);
  const headers = new Headers(init?.headers);
  if (init?.method === "POST") headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  const response = await app.request(url.slice(4), { ...init, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie?.startsWith("estate_impression="))
    cookie = setCookie.split(";")[0]!;
  if (url === "/api/impressions") {
    const batch = JSON.parse(String(init?.body)) as {
      events: Array<{ eventId: string }>;
    };
    assert.equal(batch.events.length, 1);
    sentIds.push(batch.events[0]!.eventId);
    if (dropOneReply && response.ok) {
      dropOneReply = false;
      throw new Error("Simulated lost impression reply after commit");
    }
  }
  return response;
}) as typeof fetch;

let after: Stats;
let afterLostReply: Stats;
try {
  const reporter = new ImpressionReporter();
  reporter.observe([{ plotId, surface: "Billboard" }]);
  await new Promise((done) => setTimeout(done, 1_150));
  reporter.pause();
  await reporter.flush();
  assert.equal(sentIds.length, 1);
  assert(
    (values.get("near-estate-impression-queue-v1") ?? "").includes(sentIds[0]!),
    "Lost reply should leave the exact event queued",
  );
  afterLostReply = await stats(app);
  assert.equal(
    afterLostReply.totals.impressions,
    before.totals.impressions + 1,
  );
  await reporter.flush();
  assert.deepEqual(sentIds, [sentIds[0], sentIds[0]]);
  assert.equal(values.get("near-estate-impression-queue-v1"), "[]");
  after = await stats(app);
  assert.equal(after.totals.impressions, afterLostReply.totals.impressions);
  assert.equal(after.totals.dwellMs, afterLostReply.totals.dwellMs);
  assert(after.totals.dwellMs >= before.totals.dwellMs + 1_000);
  assert(after.freshness.impressionReceivedAt);
} finally {
  globalThis.fetch = nativeFetch;
  store.close();
}

const reopenedStore = new ApiStore(databasePath, assetsPath);
let reopened: Stats;
try {
  reopened = await stats(
    createApiApp({ store: reopenedStore, chain, appOrigin: origin }),
  );
  assert.deepEqual(reopened.totals, after.totals);
  assert.equal(
    reopened.freshness.impressionReceivedAt,
    after.freshness.impressionReceivedAt,
  );
} finally {
  reopenedStore.close();
}
const evidence = {
  network: "testnet",
  contractId: deployment.contractId,
  plotId,
  surface: "Billboard",
  billboardHash: billboard.billboardHash,
  approvedOnChain: true,
  impressionsBefore: before.totals.impressions,
  impressionsAfterLostReply: afterLostReply.totals.impressions,
  impressionsAfter: after.totals.impressions,
  dwellMsAdded: after.totals.dwellMs - before.totals.dwellMs,
  sameEventIdRetried: sentIds[0] === sentIds[1],
  countedOnceAfterLostReply: true,
  totalsSurvivedApiReopen: true,
  freshnessReceivedAt: after.freshness.impressionReceivedAt,
};
writeFileSync(
  resolve(root, "deployments/testnet-ad-impression-journey.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence, null, 2));
