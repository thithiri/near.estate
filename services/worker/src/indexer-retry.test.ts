import assert from "node:assert/strict";
import test from "node:test";
import { throttleWaitMs, waitForRetry } from "./indexer-retry.js";

test("repeated provider throttles back off without exceeding two minutes", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((count) => throttleWaitMs(5_000, count)),
    [5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000],
  );
  assert.equal(throttleWaitMs(30_000, 2), 60_000);
});

test("shutdown interrupts a pending provider retry", async () => {
  const shutdown = new AbortController();
  const started = Date.now();
  const pending = waitForRetry(120_000, shutdown.signal);
  shutdown.abort();
  await pending;
  assert.ok(Date.now() - started < 1_000);
});
