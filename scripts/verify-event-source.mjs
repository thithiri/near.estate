import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { parseGameEventLog } from "@estate/shared";

const manifestPath = new URL(
  "../deployments/testnet-event-source.json",
  import.meta.url,
);
const probe = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(probe.network, "testnet");
const archive = "https://archival-rpc.testnet.fastnear.com";
const neardata = "https://testnet.neardata.xyz";
const apiKey = process.env.ESTATE_FASTNEAR_API_KEY;
const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

async function readJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `${url} returned HTTP ${response.status}`);
  return response.json();
}

async function rpc(method, params) {
  const response = await readJson(archive, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "estate-event-probe",
      method,
      params,
    }),
  });
  assert.equal(
    response.error,
    undefined,
    `${method}: ${JSON.stringify(response.error)}`,
  );
  return response.result;
}

const archivedEventBlock = await rpc("block", {
  block_id: probe.receiptBlockHash,
});
const height = archivedEventBlock.header.height;
assert.ok(Number.isSafeInteger(height) && height > 0);
assert.equal(archivedEventBlock.header.hash, probe.receiptBlockHash);

const oldHeight = 277_000_000;
assert.ok(oldHeight < height, "probe must be newer than the archive sample");
const [recent, replay, archivedTx, oldBlock] = await Promise.all([
  readJson(`${neardata}/v0/block/${height}`),
  readJson(`${neardata}/v0/block/${height}`),
  rpc("tx", {
    tx_hash: probe.transactionHash,
    sender_account_id: probe.ownerId,
    wait_until: "FINAL",
  }),
  rpc("block", { block_id: oldHeight }),
]);

for (const block of [recent, replay]) {
  assert.equal(block?.block?.header?.height, height);
  assert.equal(block.block.header.hash, probe.receiptBlockHash);
}
assert.equal(oldBlock.header.height, oldHeight);
assert.equal(archivedTx.final_execution_status, "FINAL");
assert.equal(archivedTx.transaction.hash, probe.transactionHash);
assert.equal(archivedTx.transaction.receiver_id, probe.contractId);
assert.equal(archivedTx.transaction.signer_id, probe.ownerId);

const inclusionBlock = await rpc("block", {
  block_id: archivedTx.transaction_outcome.block_hash,
});
const emptyTxRoot = "11111111111111111111111111111111";
const transactionChunks = inclusionBlock.chunks.filter(
  (chunk) => chunk.tx_root !== emptyTxRoot,
);
assert.ok(transactionChunks.length > 0, "inclusion block has no transactions");
const chunks = await Promise.all(
  transactionChunks.map((chunk) =>
    rpc("chunk", { chunk_id: chunk.chunk_hash }),
  ),
);
const discovered = chunks
  .flatMap((chunk) => chunk.transactions)
  .filter((transaction) => transaction.hash === probe.transactionHash);
assert.equal(
  discovered.length,
  1,
  "archival block scan did not find the transaction",
);
assert.equal(discovered[0].receiver_id, probe.contractId);

function matchingReceipt(block) {
  const outcomes = block.shards.flatMap(
    (shard) => shard.receipt_execution_outcomes,
  );
  const matches = outcomes.filter(
    (entry) => entry.execution_outcome.id === probe.receiptId,
  );
  assert.equal(
    matches.length,
    1,
    "receipt ID must occur exactly once in the block",
  );
  const outcome = matches[0].execution_outcome.outcome;
  assert.equal(outcome.executor_id, probe.contractId);
  assert.equal(outcome.status.Failure, undefined);
  assert.ok(
    outcome.status.SuccessValue !== undefined ||
      outcome.status.SuccessReceiptId !== undefined,
    "event receipt was not successful",
  );
  const logIndex = outcome.logs.indexOf(probe.eventLog);
  assert.ok(logIndex >= 0, "event log is missing from the receipt");
  const event = parseGameEventLog(outcome.logs[logIndex]);
  assert.equal(event?.event, "rule_scheduled");
  assert.equal(event.data[0].plot_id, "plot-main-n-0");
  return `${probe.receiptId}:${logIndex}`;
}

const identity = matchingReceipt(recent);
assert.equal(
  matchingReceipt(replay),
  identity,
  "replay changed event identity",
);
const archivedReceipt = archivedTx.receipts_outcome.filter(
  (entry) => entry.id === probe.receiptId,
);
assert.equal(archivedReceipt.length, 1);
assert.equal(archivedReceipt[0].outcome.executor_id, probe.contractId);
assert.ok(archivedReceipt[0].outcome.logs.includes(probe.eventLog));
assert.equal(archivedReceipt[0].outcome.status.Failure, undefined);

probe.sourceChecks = {
  blockHeight: height,
  eventIdentity: identity,
  neardataReplayMatched: true,
  archivalTransactionMatched: true,
  archivalBlockScanMatched: true,
  transactionBlockHash: inclusionBlock.header.hash,
  historicalBlockHeight: oldHeight,
  historicalBlockHash: oldBlock.header.hash,
};
writeFileSync(manifestPath, `${JSON.stringify(probe, null, 2)}\n`);
console.log(
  `Verified finalized receipt ${identity} at block ${height}; archive block ${oldHeight} available`,
);
