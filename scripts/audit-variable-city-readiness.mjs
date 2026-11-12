import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { baseEncode } from "@near-js/utils";

const root = resolve(import.meta.dirname, "..");
const deployment = JSON.parse(
  await readFile(resolve(root, "deployments/testnet.json"), "utf8"),
);
const sourceSeed = JSON.parse(
  await readFile(resolve(root, "contracts/estate/seed.json"), "utf8"),
);
assert.equal(sourceSeed.version, 1);
assert.equal(sourceSeed.plots.length, 80);
assert.equal(sourceSeed.npcSites.length, 7);
assert.equal(deployment.network, "testnet");
assert.match(deployment.contractId, /^[a-z0-9._-]+\.testnet$/);
const rpcUrl =
  process.env.ESTATE_TESTNET_RPC_URL ?? "https://test.rpc.fastnear.com";
assert.match(rpcUrl, /^https:\/\//);

async function rpc(method, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "city-audit",
        method,
        params,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 3)
        throw new Error(`RPC ${method} failed: ${response.status}`);
      await new Promise((done) => setTimeout(done, 300 * 2 ** attempt));
      continue;
    }
    assert.equal(response.ok, true, `RPC ${method} failed: ${response.status}`);
    const body = await response.json();
    if (body.error)
      throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
    assert.ok(body.result, `RPC ${method} returned no result`);
    return body.result;
  }
  throw new Error(`RPC ${method} exhausted retries`);
}

const block = await rpc("block", { finality: "final" });
const blockHash = block.header.hash;
const blockHeight = block.header.height;
assert.equal(typeof blockHash, "string");
assert.ok(Number.isSafeInteger(blockHeight));

async function query(requestType, rest) {
  const result = await rpc("query", {
    request_type: requestType,
    block_id: blockHash,
    account_id: deployment.contractId,
    ...rest,
  });
  assert.equal(
    result.block_hash,
    blockHash,
    `RPC returned a different block for ${requestType}`,
  );
  return result;
}

async function view(method, args = {}) {
  const bytes = Buffer.from(JSON.stringify(args));
  const result = await query("call_function", {
    method_name: method,
    args_base64: bytes.toString("base64"),
  });
  if (result.error) throw new Error(`${method}: ${result.error}`);
  assert.ok(Array.isArray(result.result), `${method} returned no bytes`);
  return JSON.parse(Buffer.from(result.result).toString("utf8"));
}

const [accountRecord, config, paused, plotCount, npcCount, rawState] =
  await Promise.all([
    query("view_account", {}),
    view("get_config"),
    view("is_paused"),
    view("plot_count"),
    view("npc_site_count"),
    query("view_state", { prefix_base64: "" }),
  ]);
const stateEntries = rawState.values
  .map((entry) => [
    Buffer.from(entry.key, "base64"),
    Buffer.from(entry.value, "base64"),
  ])
  .sort((left, right) => Buffer.compare(left[0], right[0]));
assert.ok(stateEntries.length > 0, "Pinned state is empty");
const stateDigest = createHash("sha256");
for (const [key, value] of stateEntries) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(key.length));
  stateDigest.update(length);
  stateDigest.update(key);
  length.writeBigUInt64LE(BigInt(value.length));
  stateDigest.update(length);
  stateDigest.update(value);
}
const stateSha256 = stateDigest.digest("hex");
assert.equal(
  accountRecord.code_hash,
  baseEncode(Buffer.from(deployment.wasmSha256, "hex")),
  "Live code hash differs from the deployment manifest",
);
assert.equal(
  plotCount,
  80,
  "The live city no longer has the expected 80 plots",
);
assert.equal(
  npcCount,
  7,
  "The live city no longer has the expected seven NPC sites",
);

const plots = [];
for (let start = 0; start < plotCount; start += 50) {
  const page = await view("get_plots", {
    from_index: start,
    limit: Math.min(50, plotCount - start),
  });
  assert.equal(page.length, Math.min(50, plotCount - start));
  plots.push(...page);
}
assert.equal(new Set(plots.map((entry) => entry.plot.id)).size, plotCount);
const plotViews = new Map(plots.map((entry) => [entry.plot.id, entry]));
for (const expected of sourceSeed.plots) {
  const actual = plotViews.get(expected.id)?.plot;
  assert.ok(actual, `Seed plot missing from contract: ${expected.id}`);
  assert.equal(actual.road_id, expected.roadId);
  assert.equal(actual.side, expected.side);
  assert.equal(actual.index, expected.index);
  assert.equal(actual.corner, expected.corner);
}

const npcSites = await view("get_npc_sites", { from_index: 0, limit: 20 });
assert.equal(npcSites.length, npcCount);
const sitesById = new Map(npcSites.map((site) => [site.id, site]));
assert.equal(sitesById.size, npcCount, "Civic site IDs are duplicated");
for (const expected of sourceSeed.npcSites) {
  const actual = sitesById.get(expected.id);
  assert.ok(actual, `Seed civic site missing from contract: ${expected.id}`);
  assert.equal(actual.road_id, expected.roadId);
  assert.equal(actual.side, expected.side);
  assert.equal(actual.frontage_index, expected.frontageIndex);
  assert.equal(actual.role, expected.role);
  assert.equal(actual.name, expected.name);
  assert.equal(actual.capacity, expected.capacity);
}
const ownedPlots = plots
  .filter((entry) => entry.plot.owner !== null)
  .map((entry) => entry.plot);
const ownerIds = [...new Set(ownedPlots.map((plot) => plot.owner))];
const ownerAccounts = [];
for (const ownerId of ownerIds) {
  const account = await view("get_account", { account_id: ownerId });
  assert.ok(account, `Owned plot account missing: ${ownerId}`);
  const cars = await view("get_cars", { account_id: ownerId });
  assert.deepEqual(
    cars.map((car) => car.id).sort((a, b) => a - b),
    [...account.car_ids].sort((a, b) => a - b),
  );
  ownerAccounts.push({ account_id: ownerId, account, cars });
}

const roads = ["main", "market", "river", "central", "harbor"];
const curbSessions = [];
const seenStreetPlots = new Set();
for (const road_id of roads) {
  for (const side of ["North", "South"]) {
    const street = await view("get_street_side", { road_id, side });
    assert.equal(
      street.plots.length,
      8,
      `${road_id} ${side} plot count changed`,
    );
    for (const [index, entry] of street.plots.entries()) {
      const id = entry.plot.plot.id;
      assert.equal(
        id,
        `plot-${road_id}-${side === "North" ? "n" : "s"}-${index}`,
        `Unexpected plot at ${road_id} ${side} index ${index}`,
      );
      assert.ok(!seenStreetPlots.has(id), `Duplicate street plot ${id}`);
      seenStreetPlots.add(id);
      assert.deepEqual(
        entry.plot,
        plotViews.get(id),
        `Street and plot-page views differ for ${id}`,
      );
      assert.equal(entry.slots.length, 2);
      for (const session of entry.slots)
        if (session) curbSessions.push(session);
    }
  }
}
assert.equal(seenStreetPlots.size, plotCount);
assert.deepEqual(
  [...seenStreetPlots].sort(),
  [...plotViews.keys()].sort(),
  "Street and plot-page IDs differ",
);
const towers = npcSites.filter((site) => site.role === "ParkingTower");
assert.equal(towers.length, 3, "Expected three parking towers");
const towerSessions = [];
for (const tower of towers) {
  assert.equal(tower.capacity, 32, `Tower capacity changed: ${tower.id}`);
  for (let floor = 0; floor < 4; floor++) {
    const slots = await view("get_tower_floor_sessions", {
      site_id: tower.id,
      floor,
    });
    assert.equal(slots.length, 8);
    for (const session of slots) if (session) towerSessions.push(session);
  }
}

const proposedMoves = [
  ["plot-main-n-2", "plot-main-n-3"],
  ["plot-market-n-1", "plot-market-n-2"],
].map(([from, to]) => ({
  from,
  to,
  currentOwner: ownedPlots.find((plot) => plot.id === from)?.owner ?? null,
  destinationCurrentOwner:
    ownedPlots.find((plot) => plot.id === to)?.owner ?? null,
}));
const unmappedOwnedPlots = ownedPlots
  .map((plot) => plot.id)
  .filter((id) => !proposedMoves.some((move) => move.from === id));
const report = {
  capturedAt: new Date().toISOString(),
  contractId: deployment.contractId,
  finalBlock: { hash: blockHash, height: blockHeight },
  codeHash: accountRecord.code_hash,
  codeSha256: deployment.wasmSha256,
  stateSha256,
  stateEntryCount: stateEntries.length,
  storageUsageBytes: accountRecord.storage_usage,
  configVersion: config.version,
  paused,
  plotCount,
  npcSiteCount: npcCount,
  plotGeometry: plots
    .map((entry) => ({
      id: entry.plot.id,
      roadId: entry.plot.road_id,
      side: entry.plot.side,
      index: entry.plot.index,
      corner: entry.plot.corner,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
  npcSiteGeometry: npcSites
    .map((site) => ({
      id: site.id,
      roadId: site.road_id,
      side: site.side,
      frontageIndex: site.frontage_index,
      role: site.role,
      name: site.name,
      capacity: site.capacity,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
  ownedPlots,
  ownerAccounts,
  curbSessions,
  towerSessions,
  proposedMoves,
  unmappedOwnedPlots,
  gates: {
    pausedForMigration: paused,
    allSpacesEmpty: curbSessions.length === 0 && towerSessions.length === 0,
    proposedMovesCoverOwners:
      unmappedOwnedPlots.length === 0 &&
      proposedMoves.every(
        (move) =>
          move.currentOwner !== null && move.destinationCurrentOwner === null,
      ),
  },
  limitations: [
    "This is a read-only pinned-block inventory, not a purchase/parking freeze.",
    "The contract account map cannot enumerate registered drivers without a plot.",
    "API event cursor, media bytes and database backup are separate checks.",
    "Proposed deed moves require owner and junction review before deployment.",
  ],
};
const output = process.argv[2];
if (!output || !output.startsWith("deployments/"))
  throw new Error("Pass a deployments/ output path");
await writeFile(resolve(root, output), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    output,
    finalBlock: report.finalBlock,
    ownedPlots: ownedPlots.map((plot) => ({ id: plot.id, owner: plot.owner })),
    activeCurbSessions: curbSessions.length,
    activeTowerSessions: towerSessions.length,
    gates: report.gates,
  }),
);
