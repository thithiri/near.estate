import { join } from "node:path";
import { EventIndexer } from "./event-indexer.js";
import { FastNearEventSource } from "./event-source.js";
import { EventStore } from "./event-store.js";

const contractId = process.env.ESTATE_CONTRACT_ID?.trim();
const startHeight = Number(process.env.INDEXER_START_HEIGHT);
if (!contractId || !Number.isSafeInteger(startHeight) || startHeight < 1)
  throw new Error("Set ESTATE_CONTRACT_ID and positive INDEXER_START_HEIGHT");
const dataDir = process.env.API_DATA_DIR ?? join(process.cwd(), "data");
const store = new EventStore(
  join(dataDir, "estate.sqlite"),
  contractId,
  startHeight,
);
const source = new FastNearEventSource(contractId, {
  apiKey: process.env.ESTATE_FASTNEAR_API_KEY,
  neardataUrl: process.env.NEARDATA_URL,
  historyUrl: process.env.FASTNEAR_HISTORY_URL,
  archiveRpcUrl: process.env.FASTNEAR_ARCHIVE_RPC_URL,
});
try {
  const current = store.cursor();
  const backfill = await source.accountBackfill(
    current.height + 1,
    current.hash,
  );
  const events = store.applyAccountRange(backfill.checkpoint, backfill.blocks);
  const resumed = await new EventIndexer(store, source).runOnce();
  console.log(
    JSON.stringify({
      checkpoint: backfill.checkpoint.height,
      transactions: backfill.transactions,
      eventBlocks: backfill.blocks.length,
      events,
      resumed,
    }),
  );
} finally {
  store.close();
}
