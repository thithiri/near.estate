import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCitySeed, type ChainPlotV2 } from "@estate/shared";
import { z } from "zod";
import { ChainReader } from "../apps/web/src/chain-reader.js";
import {
  cityMapCurbPoint,
  connectionAtX,
  destination,
  endConnection,
  frontageAtX,
  frontageWidth,
  frontageX,
  INTERSECTION_GAP,
  intersectionX,
  roadWidth,
} from "../apps/web/src/city-navigation.js";
import {
  readActiveVersion2Release,
  repoRelativePath,
} from "./testnet-v2-release-context.js";

const mode = process.argv[2];
if (mode !== "--plan" && mode !== "--verify")
  throw new Error("Pass --plan or --verify");
const recordPath = process.argv[3];
if (!recordPath || !recordPath.startsWith("/"))
  throw new Error("Pass an absolute version-2 release-record path");

const root = resolve(import.meta.dirname, "..");
const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
) as {
  network: string;
  contractId: string;
  wasmSha256: string;
  citySeedVersion: number;
};
assert.equal(deployment.network, "testnet");
const release = JSON.parse(readFileSync(recordPath, "utf8")) as {
  contractId: string;
  status: string;
};
assert.equal(release.contractId, deployment.contractId);
const seed = validateCitySeed(
  JSON.parse(
    readFileSync(resolve(root, "contracts/estate/seed-v2.json"), "utf8"),
  ),
);
assert.equal(seed.version, 2);
const reader = new ChainReader(deployment.contractId);

const NPCSiteView = z.object({
  id: z.string().min(1),
  road_id: z.string().min(1),
  side: z.enum(["North", "South"]),
  frontage_index: z.number().int().nonnegative(),
  role: z.enum([
    "ParkingTower",
    "RepairGarage",
    "Cinema",
    "BurgerStop",
    "PracticeCourse",
  ]),
  name: z.string().min(1),
  capacity: z.number().int().nonnegative(),
});

async function audit() {
  assert.equal(
    await reader.cityVersion(),
    2,
    "Version-2 city has not been deployed",
  );
  assert.equal(
    await reader.view("is_paused", {}, z.boolean()),
    false,
    "City remains paused",
  );
  const active = readActiveVersion2Release(root, recordPath, deployment);
  const views = await reader.plots();
  assert.equal(views.length, seed.plots.length);
  assert(views.every((view) => "frontage_units" in view.plot));
  const plots = views as ChainPlotV2[];
  const byId = new Map(plots.map((view) => [view.plot.id, view.plot]));
  assert.equal(byId.size, seed.plots.length);
  for (const expected of seed.plots) {
    const actual = byId.get(expected.id);
    assert(actual, `Missing chain plot ${expected.id}`);
    assert.equal(actual.road_id, expected.roadId);
    assert.equal(actual.side, expected.side);
    assert.equal(actual.index, expected.index);
    assert.equal(actual.corner, expected.corner);
    assert.equal(actual.frontage_units, expected.frontageUnits);
  }

  let curbSpaces = 0;
  let mapPoints = 0;
  let intersections = 0;
  let endLinks = 0;
  for (const road of seed.streets) {
    assert(roadWidth(road) > 0);
    for (const side of ["North", "South"] as const) {
      const street = await reader.streetSide(road.id, side);
      assert.equal(street.plots.length, 10);
      assert.equal(
        frontageX(road, road.length - 1, side) +
          frontageWidth(road, road.length - 1, side),
        roadWidth(road),
        `Road width differs on ${road.id} ${side}`,
      );
      for (const [index, entry] of street.plots.entries()) {
        const expected = seed.plots.find(
          (plot) =>
            plot.roadId === road.id &&
            plot.side === side &&
            plot.index === index,
        );
        assert(expected && expected.frontageUnits);
        assert("frontage_units" in entry.plot.plot);
        assert(entry.car_appearances);
        assert.equal(entry.plot.plot.id, expected.id);
        assert.equal(entry.plot.plot.frontage_units, expected.frontageUnits);
        assert.equal(entry.slots.length, expected.frontageUnits);
        assert.equal(entry.car_appearances.length, expected.frontageUnits);
        assert.equal(
          byId.get(expected.id)?.frontage_units,
          expected.frontageUnits,
        );
        curbSpaces += entry.slots.length;
        const x =
          frontageX(road, index, side) + frontageWidth(road, index, side) / 2;
        assert.equal(frontageAtX(road, x, side), index);
        const point = cityMapCurbPoint(seed, road.id, x, side);
        const otherSide = side === "North" ? "South" : "North";
        const opposite = cityMapCurbPoint(seed, road.id, x, otherSide);
        assert(Number.isFinite(point.x) && Number.isFinite(point.y));
        assert(point.x >= 0 && point.x <= 500);
        assert(point.y >= 0 && point.y <= 300);
        if (road.id === "central" || road.id === "harbor") {
          assert.equal(point.y, opposite.y);
          assert.equal(Math.abs(point.x - opposite.x), 20);
        } else {
          assert.equal(point.x, opposite.x);
          assert.equal(Math.abs(point.y - opposite.y), 20);
        }
        mapPoints++;
      }
      for (const connection of road.connections) {
        const arrival = destination(seed, connection);
        const arrivalRoad = seed.streets.find(
          (entry) => entry.id === arrival.roadId,
        );
        assert(arrivalRoad);
        assert.equal(arrival.side, connection.toSide);
        assert.equal(
          frontageAtX(arrivalRoad, arrival.x, arrival.side),
          connection.toAt,
        );
        if (connection.kind === "Intersection") {
          const signX = intersectionX(road, connection);
          assert.equal(
            connectionAtX(road, signX + INTERSECTION_GAP / 2),
            connection,
          );
          intersections++;
        } else {
          const direction = connection.at === 0 ? -1 : 1;
          assert.equal(endConnection(road, direction), connection);
          endLinks++;
        }
      }
    }
  }
  assert.equal(curbSpaces, 180);
  assert.equal(mapPoints, 100);

  const sites = await reader.view(
    "get_npc_sites",
    { from_index: 0, limit: 7 },
    z.array(NPCSiteView).length(7),
  );
  const siteById = new Map(sites.map((site) => [site.id, site]));
  assert.equal(siteById.size, 7);
  for (const expected of seed.npcSites) {
    const actual = siteById.get(expected.id);
    assert(actual, `Missing civic site ${expected.id}`);
    assert.equal(actual.road_id, expected.roadId);
    assert.equal(actual.side, expected.side);
    assert.equal(actual.frontage_index, expected.frontageIndex);
    assert.equal(actual.role, expected.role);
    assert.equal(actual.name, expected.name);
    assert.equal(actual.capacity, expected.capacity);
  }
  return {
    network: "testnet",
    contractId: deployment.contractId,
    releaseRecord: repoRelativePath(root, active.path),
    seedVersion: 2,
    roads: seed.streets.length,
    streetSides: seed.streets.length * 2,
    plots: plots.length,
    curbSpaces,
    civicSites: sites.length,
    mapPoints,
    intersectionSignViews: intersections,
    endExitViews: endLinks,
    verifiedAt: new Date().toISOString(),
  };
}

const version = await reader.cityVersion();
if (mode === "--plan" && (version !== 2 || release.status !== "active")) {
  console.log(
    JSON.stringify({
      status: "waiting_for_active_version_2",
      cityVersion: version,
      releaseStatus: release.status,
    }),
  );
} else {
  const evidence = await audit();
  if (mode === "--verify") {
    writeFileSync(
      resolve(root, "deployments/testnet-variable-map-journey.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }
  console.log(JSON.stringify({ status: "verified", ...evidence }, null, 2));
}
