import assert from "node:assert/strict";
import test from "node:test";
import {
  advancePracticeRun,
  createPracticeRun,
  steerPracticeRun,
} from "./practice-course.js";

test("practice tiers change movement and checkpoints require actual distance", () => {
  const slow = createPracticeRun(1);
  const fast = createPracticeRun(3);
  for (let frame = 0; frame < 40; frame++) {
    advancePracticeRun(slow, 0.1, true);
    advancePracticeRun(fast, 0.1, true);
  }
  assert.ok(fast.distance > slow.distance);
  assert.equal(slow.checkpoints, 0);
  assert.equal(fast.checkpoints, 1);
  assert.equal(slow.finished, false);
});

test("practice cones add time but never award coins or affect parking", () => {
  const hit = createPracticeRun(2);
  const clear = createPracticeRun(2);
  steerPracticeRun(clear, 1);
  for (let frame = 0; frame < 150; frame++) {
    advancePracticeRun(hit, 0.1, true);
    advancePracticeRun(clear, 0.1, true);
  }
  assert.equal(hit.finished, true);
  assert.equal(clear.finished, true);
  assert.equal(hit.checkpoints, 3);
  assert.equal(clear.checkpoints, 3);
  assert.ok(hit.coneHits > clear.coneHits);
  assert.ok(hit.elapsed > clear.elapsed);
  assert.equal(Object.hasOwn(hit, "coins"), false);
});

test("practice time follows slow frames and stops at the finish line", () => {
  const run = createPracticeRun(1);
  advancePracticeRun(run, 0.7, false);
  assert.equal(run.elapsed, 0.7);
  advancePracticeRun(run, 0.5, true);
  assert.equal(run.distance, 36);
  assert.equal(run.elapsed, 1.2);
  run.distance = 1_192;
  const beforeFinish = run.elapsed;
  advancePracticeRun(run, 2, true);
  assert.equal(run.distance, 1_200);
  assert.equal(run.finished, true);
  assert.ok(Math.abs(run.elapsed - beforeFinish - 8 / 72) < 1e-9);
});
