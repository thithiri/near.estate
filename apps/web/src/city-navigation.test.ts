import assert from "node:assert/strict";
import test from "node:test";
import { validateCitySeed } from "@estate/shared";
import rawSeed from "../../../contracts/estate/seed.json";
import {
  cityMapPoint,
  connectionAtX,
  destination,
  endConnection,
  frontageAtX,
  frontageX,
  INTERSECTION_GAP,
  intersectionX,
  roadWidth,
} from "./city-navigation.js";

const city = validateCitySeed(rawSeed);

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
