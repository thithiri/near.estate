import assert from "node:assert/strict";
import test from "node:test";
import { validateCitySeed } from "@estate/shared";
import rawSeed from "../../../contracts/estate/seed-v2-horse.json";
import {
  markTripActivity,
  markTripCollection,
  parkedNearStop,
  readTripProgress,
  todaysTrip,
} from "./todays-trip.js";

const city = validateCitySeed(rawSeed);
const day = new Date("2026-11-13T12:00:00Z");

test("daily route has two distinct game-owned activities and rotates", () => {
  const stops = todaysTrip(city, day);
  assert.equal(stops.length, 2);
  assert.notEqual(stops[0]!.id, stops[1]!.id);
  assert.ok(stops.every((stop) => stop.role !== "ParkingTower"));
  assert.notEqual(
    todaysTrip(city, new Date("2026-11-14T12:00:00Z"))[0]!.id,
    stops[0]!.id,
  );
});

test("trip only counts a car parked near the destination on its curb", () => {
  const stop = todaysTrip(city, day)[0]!;
  const nearby = city.plots.find(
    (plot) =>
      plot.roadId === stop.roadId &&
      plot.side === stop.side &&
      Math.abs(plot.index - stop.frontageIndex) <= 2,
  )!;
  assert.ok(nearby);
  assert.equal(
    parkedNearStop(city, stop, { facility: "Curb", locationId: nearby.id }),
    true,
  );
  const opposite = city.plots.find(
    (plot) => plot.roadId === stop.roadId && plot.side !== stop.side,
  )!;
  assert.equal(
    parkedNearStop(city, stop, { facility: "Curb", locationId: opposite.id }),
    false,
  );
  assert.equal(parkedNearStop(city, stop, null), false);
});

test("local trip progress ignores stale and unknown stamps", () => {
  const stops = todaysTrip(city, day);
  const key = "trip";
  const storage = {
    getItem: () =>
      JSON.stringify({
        day: "2026-11-13",
        completed: [stops[0]!.id, "unknown-stop"],
      }),
  };
  assert.deepEqual(readTripProgress(storage, key, stops, day).completed, [
    stops[0]!.id,
  ]);
  assert.deepEqual(readTripProgress(storage, key, stops, day).collected, []);
  assert.deepEqual(
    readTripProgress(storage, key, stops, new Date("2026-11-14T00:00:00Z"))
      .completed,
    [],
  );
});

test("a stop completes only after the activity's own parked session is collected", () => {
  const stopId = todaysTrip(city, day)[0]!.id;
  const fresh = readTripProgress({ getItem: () => null }, "trip", [], day);
  const activity = markTripActivity(fresh, stopId, "session-7");
  assert.deepEqual(activity.completed, [stopId]);
  assert.deepEqual(activity.collected, []);
  assert.equal(markTripCollection(activity, "different-session"), activity);
  const complete = markTripCollection(activity, "session-7");
  assert.deepEqual(complete.collected, [stopId]);
  assert.deepEqual(complete.parkedSessions, {});
});
