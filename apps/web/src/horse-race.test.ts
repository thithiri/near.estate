import assert from "node:assert/strict";
import test from "node:test";
import {
  HORSE_RACE_SECONDS,
  HORSES,
  horseProgress,
  horseRaceOrder,
} from "./horse-race.js";

test("every spectator race has one deterministic winner and distinct finishing order", () => {
  for (let race = 0; race < 24; race++) {
    const order = horseRaceOrder(race);
    assert.equal(new Set(order).size, HORSES.length);
    assert.equal(order[0], race % HORSES.length);
    const distances = order.map((horse) =>
      horseProgress(race, horse, HORSE_RACE_SECONDS),
    );
    assert.deepEqual(distances, [1, 0.94, 0.89, 0.84]);
  }
});

test("race progress is bounded and rejects invalid race numbers", () => {
  assert.equal(horseProgress(0, 0, -1), 0);
  assert.equal(horseProgress(0, 0, HORSE_RACE_SECONDS + 1), 1);
  assert.throws(() => horseRaceOrder(-1), /Invalid race number/);
});
