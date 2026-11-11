import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExpiryStatus } from "@estate/shared";
import {
  ExpiryStatusTracker,
  readExpiryStatus,
  writeExpiryStatus,
} from "./expiry-status.js";

test("expiry status persists failed passes across restarts and clears after recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "estate-expiry-status-"));
  const path = join(directory, "sweep.json");
  const contractId = "city.testnet";
  const tracker = new ExpiryStatusTracker(contractId);
  const result = {
    scanned: 1,
    eligible: 1,
    attempted: 1,
    settled: 0,
    raced: 0,
    failed: 1,
  };
  try {
    const first = tracker.completed(result, 100);
    assert.equal(first.consecutiveFailures, 1);
    await writeExpiryStatus(path, first);
    const saved = readExpiryStatus(path, contractId);
    assert.deepEqual(
      saved,
      ExpiryStatus.parse(JSON.parse(await readFile(path, "utf8"))),
    );
    assert.equal(readExpiryStatus(path, "other.testnet"), null);
    const restarted = new ExpiryStatusTracker(
      contractId,
      saved?.consecutiveFailures,
    );
    assert.equal(restarted.failed(101).consecutiveFailures, 2);
    assert.equal(restarted.completed(result, 102).consecutiveFailures, 3);
    const recovered = restarted.completed(
      { ...result, failed: 0, raced: 1 },
      103,
    );
    assert.equal(recovered.consecutiveFailures, 0);
    assert.equal(recovered.outcome, "ok");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
