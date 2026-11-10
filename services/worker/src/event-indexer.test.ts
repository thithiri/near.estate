import assert from "node:assert/strict";
import test from "node:test";
import { EventIndexer } from "./event-indexer.js";
import { EventStore, type FinalizedBlock } from "./event-store.js";

test("indexer resumes at its durable cursor after a source failure", async () => {
  const store = new EventStore(":memory:", "estate.testnet", 10);
  let fail = true;
  const makeBlock = (height: number): FinalizedBlock => ({
    height,
    hash: `hash-${height}`,
    prevHash: `hash-${height - 1}`,
    timestampNs: "1794316011248367505",
    source: "neardata",
    events: [],
  });
  const source = {
    latestFinalHeight: async () => 12,
    block: async (height: number) => {
      if (height === 11 && fail) throw new Error("Temporary source failure");
      return makeBlock(height);
    },
  };
  try {
    const indexer = new EventIndexer(store, source, 3, 0);
    await assert.rejects(indexer.runOnce(), /Temporary source failure/);
    assert.equal(store.cursor().height, 10);
    fail = false;
    assert.deepEqual(await indexer.runOnce(), {
      from: 11,
      through: 12,
      tip: 12,
      events: 0,
    });
  } finally {
    store.close();
  }
});
