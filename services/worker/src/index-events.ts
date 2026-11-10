import { join } from "node:path";
import { EventIndexer } from "./event-indexer.js";
import { FastNearEventSource, SourceThrottleError } from "./event-source.js";
import { EventStore } from "./event-store.js";

const contractId = process.env.ESTATE_CONTRACT_ID?.trim();
const startHeight = Number(process.env.INDEXER_START_HEIGHT);
if (!contractId || !Number.isSafeInteger(startHeight) || startHeight < 1)
  throw new Error("Set ESTATE_CONTRACT_ID and positive INDEXER_START_HEIGHT");
const dataDir = process.env.API_DATA_DIR ?? join(process.cwd(), "data");
const dbPath = join(dataDir, "estate.sqlite");
const store = new EventStore(dbPath, contractId, startHeight);
const source = new FastNearEventSource(contractId, {
  apiKey: process.env.ESTATE_FASTNEAR_API_KEY,
  neardataUrl: process.env.NEARDATA_URL,
  historyUrl: process.env.FASTNEAR_HISTORY_URL,
  archiveRpcUrl: process.env.FASTNEAR_ARCHIVE_RPC_URL,
});
const indexer = new EventIndexer(store, source);
const mode = process.argv[2] ?? "--run";

async function runPass(): Promise<Record<string, number | string>> {
  const cursor = store.cursor();
  const tip = await source.latestFinalHeight();
  if (tip - cursor.height > 100) {
    const backfill = await source.accountBackfill(
      cursor.height + 1,
      cursor.hash,
    );
    const events = store.applyAccountRange(
      backfill.checkpoint,
      backfill.blocks,
    );
    return {
      mode: "sparse_history",
      from: cursor.height + 1,
      through: backfill.checkpoint.height,
      tip,
      events,
      transactions: backfill.transactions,
      eventBlocks: backfill.blocks.length,
    };
  }
  return { mode: "recent_blocks", ...(await indexer.runOnce()) };
}

if (mode === "--rebuild") {
  store.rebuildAggregates();
  console.log("Rebuilt plot statistics from indexed receipt events");
  store.close();
} else if (mode === "--once") {
  try {
    console.log(JSON.stringify(await runPass()));
  } finally {
    store.close();
  }
} else if (mode === "--run") {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    while (!stopped) {
      let delayMs = 5_000;
      try {
        const result = await runPass();
        if (
          Number(result.events) ||
          Number(result.through) >= Number(result.from)
        )
          console.log(JSON.stringify(result));
      } catch (error) {
        console.error("Event indexer retrying:", error);
        if (error instanceof SourceThrottleError) delayMs = error.retryAfterMs;
      }
      if (!stopped)
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
    }
  } finally {
    store.close();
  }
} else {
  store.close();
  throw new Error("Unknown indexer mode");
}
