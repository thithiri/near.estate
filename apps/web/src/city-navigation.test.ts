import assert from "node:assert/strict";
import test from "node:test";
import { validateCitySeed } from "@estate/shared";
import rawSeed from "../../../contracts/estate/seed.json";
import rawSeedV2 from "../../../contracts/estate/seed-v2.json";
import {
  arrivalDirection,
  cityMapCurbPoint,
  cityMapPoint,
  connectionAtX,
  curbDirection,
  destination,
  endConnection,
  frontageAtX,
  frontageX,
  INTERSECTION_GAP,
  intersectionX,
  roadWidth,
} from "./city-navigation.js";

const city = validateCitySeed(rawSeed);

test("map shows the selected curb on the geographic side of each road", () => {
  const mainCenter = cityMapPoint(city, "main", 100);
  const mainNorth = cityMapCurbPoint(city, "main", 100, "North");
  const mainSouth = cityMapCurbPoint(city, "main", 100, "South");
  assert.deepEqual(mainNorth, { x: mainCenter.x, y: mainCenter.y - 10 });
  assert.deepEqual(mainSouth, { x: mainCenter.x, y: mainCenter.y + 10 });
  assert.equal(curbDirection("main", "North"), "North");
  assert.equal(curbDirection("main", "South"), "South");

  const avenueCenter = cityMapPoint(city, "central", 100);
  const avenueWest = cityMapCurbPoint(city, "central", 100, "North");
  const avenueEast = cityMapCurbPoint(city, "central", 100, "South");
  assert.deepEqual(avenueWest, { x: avenueCenter.x - 10, y: avenueCenter.y });
  assert.deepEqual(avenueEast, { x: avenueCenter.x + 10, y: avenueCenter.y });
  assert.equal(curbDirection("central", "North"), "West");
  assert.equal(curbDirection("central", "South"), "East");
});

test("intersection creates a real gap and resolves both sides of it", () => {
  const main = city.streets.find((road) => road.id === "main")!;
  const cross = main.connections.find(
    (connection) => connection.kind === "Intersection" && connection.at === 2,
  )!;
  const start = intersectionX(main, cross);
  assert.equal(frontageAtX(main, start - 1), 2);
  assert.equal(frontageAtX(main, start), undefined);
  assert.equal(connectionAtX(main, start + INTERSECTION_GAP / 2), cross);
  assert.equal(frontageAtX(main, start + INTERSECTION_GAP), 3);
  assert.equal(frontageX(main, 3), start + INTERSECTION_GAP);
  assert.equal(roadWidth(main), main.length * 170 + 2 * INTERSECTION_GAP);
});

test("map marker meets both sides of every cross-street intersection", () => {
  for (const road of city.streets) {
    for (const connection of road.connections) {
      if (connection.kind !== "Intersection") continue;
      const from = cityMapPoint(
        city,
        road.id,
        intersectionX(road, connection) + INTERSECTION_GAP / 2,
      );
      const other = city.streets.find(
        (entry) => entry.id === connection.toRoadId,
      )!;
      const reverse = other.connections.find(
        (entry) => entry.kind === "Intersection" && entry.toRoadId === road.id,
      )!;
      const to = cityMapPoint(
        city,
        other.id,
        intersectionX(other, reverse) + INTERSECTION_GAP / 2,
      );
      assert.deepEqual(from, to);
    }
  }
});

test("end exits and cross-street destination preserve a reachable position", () => {
  const main = city.streets.find((road) => road.id === "main")!;
  const market = city.streets.find((road) => road.id === "market")!;
  const leftExit = endConnection(main, -1)!;
  assert.equal(leftExit.toRoadId, "market");
  assert.equal(endConnection(main, 1), undefined);
  const arrival = destination(city, leftExit);
  assert.equal(arrival.roadId, "market");
  assert.equal(arrival.side, "North");
  assert.equal(frontageAtX(market, arrival.x), 0);
  const rightExit = endConnection(market, 1)!;
  assert.equal(rightExit.toRoadId, "river");
  const river = city.streets.find((road) => road.id === "river")!;
  assert.equal(frontageAtX(river, destination(city, rightExit).x), 11);
});

test("every road-end arrival faces inward and keeps the selected curb", () => {
  for (const seed of [city, validateCitySeed(rawSeedV2)]) {
    for (const road of seed.streets) {
      for (const connection of road.connections) {
        if (connection.kind !== "End") continue;
        const target = seed.streets.find(
          (entry) => entry.id === connection.toRoadId,
        )!;
        const expectedDirection = connection.toAt === 0 ? 1 : -1;
        assert.equal(arrivalDirection(connection), expectedDirection);
        for (const side of ["North", "South"] as const) {
          const arrival = destination(seed, connection, side);
          assert.equal(arrival.side, side);
          assert.equal(frontageAtX(target, arrival.x, side), connection.toAt);
        }
      }
    }
  }
});

test("unconnected street ends stop instead of silently changing roads", () => {
  for (const seed of [city, validateCitySeed(rawSeedV2)]) {
    const roads = new Map(seed.streets.map((road) => [road.id, road]));
    for (const [id, directions] of [
      ["main", [1]],
      ["river", [-1]],
      ["central", [-1, 1]],
      ["harbor", [-1, 1]],
    ] as const) {
      const road = roads.get(id)!;
      for (const direction of directions)
        assert.equal(endConnection(road, direction as -1 | 1), undefined);
    }
  }
});
