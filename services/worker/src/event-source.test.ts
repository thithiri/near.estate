import assert from "node:assert/strict";
import test from "node:test";
import { FastNearEventSource, SourceThrottleError } from "./event-source.js";

const contractId = "estate.testnet";
const log =
  'EVENT_JSON:{"standard":"near_estate","version":"1.0.0","event":"rule_scheduled","data":[{"plot_id":"plot-a","effective_at":123}]}';
const receipt = {
  receipt: { receipt_id: "receipt-a" },
  execution_outcome: {
    block_height: 10,
    outcome: {
      executor_id: contractId,
      status: { SuccessValue: "" },
      logs: [log],
    },
  },
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("recent source reads only successful contract receipt logs", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/v0/last_block/final"))
      return json({ block: { header: { height: 10 } } });
    return json({
      block: {
        header: {
          height: 10,
          hash: "hash-10",
          prev_hash: "hash-9",
          timestamp_nanosec: "1794316011248367505",
        },
      },
      shards: [
        {
          receipt_execution_outcomes: [
            {
              execution_outcome: {
                id: "receipt-a",
                outcome: receipt.execution_outcome.outcome,
              },
            },
            {
              execution_outcome: {
                id: "failed",
                outcome: {
                  executor_id: contractId,
                  status: { Failure: {} },
                  logs: [log],
                },
              },
            },
            {
              execution_outcome: {
                id: "other",
                outcome: {
                  executor_id: "other.testnet",
                  status: { SuccessValue: "" },
                  logs: [log],
                },
              },
            },
          ],
        },
      ],
    });
  }) as typeof fetch;
  const source = new FastNearEventSource(contractId, { fetchImpl });
  assert.equal(await source.latestFinalHeight(), 10);
  const block = await source.block(10);
  assert.equal(block?.source, "neardata");
  assert.deepEqual(
    block?.events.map((event) => event.id),
    ["receipt-a:0:0"],
  );
});

test("historical source checks the canonical block and exact receipt", async () => {
  const paths: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    paths.push(url);
    if (url.includes("neardata")) return json(null);
    if (url.includes("archive"))
      return json({
        result: {
          header: {
            hash: "hash-10",
            prev_hash: "hash-9",
            timestamp_nanosec: "1794316011248367505",
          },
        },
      });
    if (url.endsWith("/v0/block"))
      return json({
        block: {
          block_height: 10,
          block_hash: "hash-10",
          prev_block_hash: "hash-9",
        },
        block_receipts: [
          {
            receipt_id: "receipt-a",
            transaction_hash: "tx-a",
            receiver_id: contractId,
            is_success: true,
          },
          {
            receipt_id: "other",
            transaction_hash: "tx-other",
            receiver_id: "other.testnet",
            is_success: true,
          },
        ],
      });
    const request = JSON.parse(String(init?.body)) as { tx_hashes: string[] };
    assert.deepEqual(request.tx_hashes, ["tx-a"]);
    return json({
      transactions: [{ transaction: { hash: "tx-a" }, receipts: [receipt] }],
    });
  }) as typeof fetch;
  const source = new FastNearEventSource(contractId, {
    fetchImpl,
    neardataUrl: "https://neardata.local",
    archiveRpcUrl: "https://archive.local",
    historyUrl: "https://history.local",
  });
  const block = await source.block(10);
  assert.equal(block?.source, "history");
  assert.deepEqual(
    block?.events.map((event) => event.id),
    ["receipt-a:0:0"],
  );
  assert.ok(paths.some((path) => path.endsWith("/v0/transactions")));
});

test("source exposes provider retry delay without advancing a block", async () => {
  const source = new FastNearEventSource(contractId, {
    fetchImpl: (async () =>
      new Response("busy", {
        status: 429,
        headers: { "retry-after": "12" },
      })) as typeof fetch,
  });
  await assert.rejects(
    source.block(10),
    (error: unknown) =>
      error instanceof SourceThrottleError && error.retryAfterMs === 12_000,
  );
});

test("account backfill validates indexed receipts against historical block hashes", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v0/last_block/final"))
      return json({ block: { header: { height: 210 } } });
    if (url.includes("archive"))
      return json({
        result: {
          header: {
            hash: "hash-110",
            prev_hash: "hash-109",
            timestamp_nanosec: "1794316011248367505",
          },
        },
      });
    if (url.endsWith("/v0/account")) {
      const request = JSON.parse(String(init?.body)) as {
        desc: boolean;
        to_tx_block_height: number;
      };
      assert.equal(request.desc, false);
      assert.equal(request.to_tx_block_height, 111);
      return json({
        account_txs: [
          { transaction_hash: "tx-a", tx_block_height: 10, is_receiver: true },
          {
            transaction_hash: "tx-extra",
            tx_block_height: 9,
            is_receiver: false,
          },
          {
            transaction_hash: "tx-future",
            tx_block_height: 111,
            is_receiver: true,
          },
        ],
        txs_count: 3,
      });
    }
    if (url.endsWith("/v0/transactions")) {
      const request = JSON.parse(String(init?.body)) as { tx_hashes: string[] };
      assert.deepEqual(request.tx_hashes, ["tx-a", "tx-extra"]);
      return json({
        transactions: [
          {
            transaction: { hash: "tx-a" },
            receipts: [
              {
                receipt: {
                  receipt_id: "receipt-a",
                  receiver_id: contractId,
                  block_height: 11,
                },
                execution_outcome: {
                  id: "receipt-a",
                  block_height: 11,
                  block_hash: "hash-11",
                  outcome: {
                    executor_id: contractId,
                    status: { SuccessValue: "" },
                    logs: [log],
                  },
                },
              },
            ],
          },
          { transaction: { hash: "tx-extra" }, receipts: [] },
        ],
      });
    }
    if (url.endsWith("/v0/blocks"))
      return json({
        blocks: [
          {
            block_height: 11,
            block_hash: "hash-11",
            prev_block_hash: "hash-10",
            block_timestamp: "1794316011248367505",
          },
        ],
      });
    throw new Error(`Unexpected backfill URL: ${url}`);
  }) as typeof fetch;
  const source = new FastNearEventSource(contractId, {
    fetchImpl,
    neardataUrl: "https://neardata.local",
    archiveRpcUrl: "https://archive.local",
    historyUrl: "https://history.local",
  });
  const backfill = await source.accountBackfill(10);
  assert.equal(backfill.checkpoint.height, 110);
  assert.equal(backfill.transactions, 2);
  assert.deepEqual(
    backfill.blocks.flatMap((block) => block.events.map((event) => event.id)),
    ["receipt-a:0:0"],
  );
  assert.equal(backfill.blocks[0]?.prevHash, "hash-10");
});

test("account backfill accepts a cursor on a skipped height only with a canonical saved hash", async () => {
  const blockIds: Array<number | string> = [];
  let canonicalHash = "hash-10";
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v0/last_block/final"))
      return json({ block: { header: { height: 210 } } });
    if (url.includes("archive")) {
      const request = JSON.parse(String(init?.body)) as {
        params: { block_id: number | string };
      };
      blockIds.push(request.params.block_id);
      const id = request.params.block_id;
      return json({
        result: {
          header: {
            height: id === 110 ? 110 : 10,
            hash:
              id === 110 ? "hash-110" : id === 10 ? canonicalHash : "hash-10",
            timestamp_nanosec: "1794316011248367505",
          },
        },
      });
    }
    if (url.endsWith("/v0/account"))
      return json({ account_txs: [], txs_count: 0 });
    throw new Error(`Unexpected backfill URL: ${url}`);
  }) as typeof fetch;
  const source = new FastNearEventSource(contractId, {
    fetchImpl,
    neardataUrl: "https://neardata.local",
    archiveRpcUrl: "https://archive.local",
    historyUrl: "https://history.local",
  });

  const backfill = await source.accountBackfill(12, "hash-10");
  assert.equal(backfill.checkpoint.height, 110);
  assert.deepEqual(blockIds, ["hash-10", 10, 110]);

  canonicalHash = "different-hash";
  await assert.rejects(
    source.accountBackfill(12, "hash-10"),
    /Backfill anchor no longer matches archival chain/,
  );
});
