import { parseGameEventLog } from "@estate/shared";
import type { ChainEvent, FinalizedBlock } from "./event-store.js";

type SourceOptions = {
  neardataUrl?: string;
  historyUrl?: string;
  archiveRpcUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

export class SourceThrottleError extends Error {
  constructor(
    readonly retryAfterMs: number,
    url: string,
  ) {
    super(`${url} rate limited the indexer`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`Invalid ${label}`);
  return value as number;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function eventsFromLogs(receiptId: string, logs: unknown): ChainEvent[] {
  return array(logs, "receipt logs").flatMap((rawLog, logIndex) => {
    const event = parseGameEventLog(string(rawLog, "receipt log"));
    if (!event) return [];
    return event.data.map((payload, dataIndex) => ({
      id: `${receiptId}:${logIndex}:${dataIndex}`,
      receiptId,
      logIndex,
      dataIndex,
      event: event.event,
      payload,
    }));
  });
}

function successful(status: unknown): boolean {
  const value = object(status, "receipt status");
  if ("Failure" in value) return false;
  return "SuccessValue" in value || "SuccessReceiptId" in value;
}

export class FastNearEventSource {
  private readonly neardataUrl: string;
  private readonly historyUrl: string;
  private readonly archiveRpcUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(
    readonly contractId: string,
    options: SourceOptions = {},
  ) {
    this.neardataUrl = options.neardataUrl ?? "https://testnet.neardata.xyz";
    this.historyUrl = options.historyUrl ?? "https://tx.test.fastnear.com";
    this.archiveRpcUrl =
      options.archiveRpcUrl ?? "https://archival-rpc.testnet.fastnear.com";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.apiKey
      ? { Authorization: `Bearer ${options.apiKey}` }
      : {};
  }

  private async json(
    url: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: body ? "POST" : "GET",
      headers: body
        ? { ...this.headers, "content-type": "application/json" }
        : this.headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter ? Number(retryAfter) : NaN;
        const retryAfterMs = Number.isFinite(seconds)
          ? Math.min(120_000, Math.max(5_000, Math.ceil(seconds * 1_000)))
          : 30_000;
        throw new SourceThrottleError(retryAfterMs, url);
      }
      if (response.status === 404) return null;
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    const content = await response.text();
    if (content.length > 32_000_000)
      throw new Error("Indexer source response is too large");
    return JSON.parse(content) as unknown;
  }

  private async rpcBlock(
    blockId: number | string,
  ): Promise<Record<string, unknown> | null> {
    const response = object(
      await this.json(this.archiveRpcUrl, {
        jsonrpc: "2.0",
        id: "near-estate-indexer",
        method: "block",
        params: { block_id: blockId },
      }),
      "archival RPC response",
    );
    if (response.error) {
      const error = JSON.stringify(response.error);
      if (error.includes("UNKNOWN_BLOCK")) return null;
      throw new Error(`Archival block ${blockId}: ${error}`);
    }
    return object(response.result, "archival block");
  }

  async latestFinalHeight(): Promise<number> {
    const data = object(
      await this.json(`${this.neardataUrl}/v0/last_block/final`),
      "latest finalized document",
    );
    const header = object(
      object(data.block, "latest block").header,
      "latest header",
    );
    return integer(header.height, "latest finalized height");
  }

  /** Sparse history import, ending well behind the finalized tip. */
  async accountBackfill(
    startHeight: number,
    anchorHash?: string | null,
  ): Promise<{
    checkpoint: { height: number; hash: string; timestampNs: string };
    blocks: FinalizedBlock[];
    transactions: number;
  }> {
    if (!Number.isSafeInteger(startHeight) || startHeight < 1)
      throw new Error("Invalid backfill start height");
    if (anchorHash) {
      const anchor = await this.rpcBlock(anchorHash);
      if (!anchor)
        throw new Error("Backfill anchor no longer matches archival chain");
      const anchorHeader = object(anchor.header, "backfill anchor header");
      const anchorHeight = integer(
        anchorHeader.height,
        "backfill anchor height",
      );
      const canonicalAnchor =
        anchorHeight < startHeight ? await this.rpcBlock(anchorHeight) : null;
      if (
        anchorHeader.hash !== anchorHash ||
        !canonicalAnchor ||
        object(canonicalAnchor.header, "canonical backfill anchor header")
          .hash !== anchorHash
      )
        throw new Error("Backfill anchor no longer matches archival chain");
    }
    const tip = await this.latestFinalHeight();
    let checkpointHeight = tip - 100;
    let checkpointBlock: Record<string, unknown> | null = null;
    for (
      let tries = 0;
      tries < 20 && checkpointHeight >= startHeight;
      tries++
    ) {
      checkpointBlock = await this.rpcBlock(checkpointHeight);
      if (checkpointBlock) break;
      checkpointHeight--;
    }
    if (!checkpointBlock)
      throw new Error(
        "No finalized backfill checkpoint after contract creation",
      );
    const checkpointHeader = object(
      checkpointBlock.header,
      "backfill checkpoint header",
    );
    const checkpoint = {
      height: checkpointHeight,
      hash: string(checkpointHeader.hash, "checkpoint hash"),
      timestampNs: string(
        checkpointHeader.timestamp_nanosec,
        "checkpoint timestamp",
      ),
    };
    const hashes: string[] = [];
    const seen = new Set<string>();
    let returnedRows = 0;
    let resumeToken: string | null = null;
    let expectedCount: number | null = null;
    for (let page = 0; page < 1_000; page++) {
      const response = object(
        await this.json(`${this.historyUrl}/v0/account`, {
          account_id: this.contractId,
          is_receiver: true,
          from_tx_block_height: Math.max(1, startHeight - 1_000),
          to_tx_block_height: checkpointHeight + 1,
          desc: false,
          limit: 200,
          ...(resumeToken ? { resume_token: resumeToken } : {}),
        }),
        "account history response",
      );
      const count = integer(response.txs_count, "account transaction count");
      if (expectedCount !== null && expectedCount !== count)
        throw new Error("Account history count changed during backfill");
      expectedCount = count;
      for (const raw of array(response.account_txs, "account transactions")) {
        const row = object(raw, "account transaction");
        const height = integer(row.tx_block_height, "transaction block height");
        const hash = string(row.transaction_hash, "transaction hash");
        if (seen.has(hash))
          throw new Error("Account history repeated a transaction");
        seen.add(hash);
        returnedRows++;
        // Receipt identity and executor checks below decide relevance. A provider
        // may briefly return an extra relation or future-height row while indexing.
        if (height <= checkpointHeight) hashes.push(hash);
      }
      resumeToken =
        response.resume_token == null
          ? null
          : string(response.resume_token, "account resume token");
      if (!resumeToken) break;
      if (page === 999) throw new Error("Account history exceeded 1,000 pages");
    }
    if (expectedCount !== returnedRows)
      throw new Error(
        "Account history did not return its declared transaction count",
      );

    const eventsByHeight = new Map<
      number,
      { hash: string; events: ChainEvent[] }
    >();
    for (let offset = 0; offset < hashes.length; offset += 20) {
      const batch = hashes.slice(offset, offset + 20);
      const response = object(
        await this.json(`${this.historyUrl}/v0/transactions`, {
          tx_hashes: batch,
        }),
        "backfill transactions response",
      );
      const received = new Set<string>();
      for (const raw of array(response.transactions, "backfill transactions")) {
        const transaction = object(raw, "backfill transaction");
        const hash = string(
          object(transaction.transaction, "signed transaction").hash,
          "transaction hash",
        );
        if (!batch.includes(hash) || received.has(hash))
          throw new Error(
            "Backfill transaction response was incomplete or duplicated",
          );
        received.add(hash);
        for (const item of array(
          transaction.receipts,
          "transaction receipts",
        )) {
          const receipt = object(item, "transaction receipt");
          const envelope = object(receipt.receipt, "receipt envelope");
          if (envelope.receiver_id !== this.contractId) continue;
          const execution = object(
            receipt.execution_outcome,
            "receipt execution outcome",
          );
          const outcome = object(execution.outcome, "receipt result");
          if (
            outcome.executor_id !== this.contractId ||
            !successful(outcome.status)
          )
            continue;
          const height = integer(
            execution.block_height,
            "receipt block height",
          );
          if (height < startHeight || height > checkpointHeight) continue;
          if (envelope.block_height !== height)
            throw new Error("Backfill receipt is outside the indexed range");
          const receiptId = string(envelope.receipt_id, "receipt ID");
          if (execution.id !== receiptId)
            throw new Error("Backfill receipt identity mismatch");
          const events = eventsFromLogs(receiptId, outcome.logs);
          if (!events.length) continue;
          const blockHash = string(execution.block_hash, "receipt block hash");
          const prior = eventsByHeight.get(height);
          if (prior && prior.hash !== blockHash)
            throw new Error("Backfill receipt block hash mismatch");
          if (prior) prior.events.push(...events);
          else eventsByHeight.set(height, { hash: blockHash, events });
        }
      }
      if (received.size !== batch.length)
        throw new Error("Backfill transaction response omitted a transaction");
    }

    const heights = [...eventsByHeight.keys()].sort((a, b) => a - b);
    const headers = new Map<number, Record<string, unknown>>();
    for (let i = 0; i < heights.length; ) {
      const from = heights[i]!;
      let j = i + 1;
      while (j < heights.length && heights[j]! < from + 100) j++;
      const to = heights[j - 1]! + 1;
      const response = object(
        await this.json(`${this.historyUrl}/v0/blocks`, {
          from_block_height: from,
          to_block_height: to,
          desc: false,
          limit: 100,
        }),
        "backfill block range response",
      );
      for (const raw of array(response.blocks, "backfill blocks")) {
        const header = object(raw, "backfill block header");
        headers.set(integer(header.block_height, "block height"), header);
      }
      i = j;
    }
    const blocks = heights.map((height): FinalizedBlock => {
      const header = headers.get(height);
      const eventBlock = eventsByHeight.get(height)!;
      if (!header || header.block_hash !== eventBlock.hash)
        throw new Error(`Backfill event block ${height} is not canonical`);
      return {
        height,
        hash: eventBlock.hash,
        prevHash: string(header.prev_block_hash, "previous block hash"),
        timestampNs: string(header.block_timestamp, "block timestamp"),
        source: "history",
        events: eventBlock.events,
      };
    });
    return { checkpoint, blocks, transactions: hashes.length };
  }

  async block(height: number): Promise<FinalizedBlock | null> {
    if (!Number.isSafeInteger(height) || height < 1)
      throw new Error("Invalid indexer block height");
    const recent = await this.json(`${this.neardataUrl}/v0/block/${height}`);
    if (recent) return this.fromNeardata(recent, height);
    return this.fromHistory(height);
  }

  private fromNeardata(raw: unknown, height: number): FinalizedBlock {
    const data = object(raw, "finalized block document");
    const header = object(
      object(data.block, "block envelope").header,
      "block header",
    );
    if (integer(header.height, "block height") !== height)
      throw new Error("Neardata block height mismatch");
    const events: ChainEvent[] = [];
    for (const shard of array(data.shards, "block shards")) {
      const outcomes = array(
        object(shard, "block shard").receipt_execution_outcomes,
        "shard receipt outcomes",
      );
      for (const raw of outcomes) {
        const execution = object(
          object(raw, "receipt outcome").execution_outcome,
          "execution outcome",
        );
        const outcome = object(execution.outcome, "receipt execution result");
        if (outcome.executor_id !== this.contractId) continue;
        if (!successful(outcome.status)) continue;
        events.push(
          ...eventsFromLogs(string(execution.id, "receipt ID"), outcome.logs),
        );
      }
    }
    return {
      height,
      hash: string(header.hash, "block hash"),
      prevHash: string(header.prev_hash, "previous block hash"),
      timestampNs: string(header.timestamp_nanosec, "block timestamp"),
      source: "neardata",
      events,
    };
  }

  private async fromHistory(height: number): Promise<FinalizedBlock | null> {
    const canonical = await this.rpcBlock(height);
    if (!canonical) return null; // A skipped block height, confirmed by archival RPC.
    const canonicalHeader = object(canonical.header, "archival block header");
    const historical = object(
      await this.json(`${this.historyUrl}/v0/block`, {
        block_id: height,
        with_receipts: true,
        with_transactions: false,
      }),
      "historical block response",
    );
    const row = object(historical.block, "historical block row");
    if (
      integer(row.block_height, "historical block height") !== height ||
      row.block_hash !== canonicalHeader.hash ||
      row.prev_block_hash !== canonicalHeader.prev_hash
    )
      throw new Error(`Historical block ${height} does not match archival RPC`);
    const relevant = array(historical.block_receipts, "historical receipts")
      .map((entry) => object(entry, "historical receipt"))
      .filter((entry) => entry.receiver_id === this.contractId);
    const transactionHashes = [
      ...new Set(
        relevant.map((entry) =>
          string(entry.transaction_hash, "transaction hash"),
        ),
      ),
    ];
    const transactions = new Map<string, Record<string, unknown>>();
    for (let offset = 0; offset < transactionHashes.length; offset += 20) {
      const batch = transactionHashes.slice(offset, offset + 20);
      const response = object(
        await this.json(`${this.historyUrl}/v0/transactions`, {
          tx_hashes: batch,
        }),
        "transaction history response",
      );
      for (const raw of array(
        response.transactions,
        "historical transactions",
      )) {
        const transaction = object(raw, "historical transaction");
        const hash = string(
          object(transaction.transaction, "signed transaction").hash,
          "transaction hash",
        );
        transactions.set(hash, transaction);
      }
    }
    const events: ChainEvent[] = [];
    for (const receipt of relevant) {
      const hash = string(receipt.transaction_hash, "receipt transaction hash");
      const transaction = transactions.get(hash);
      if (!transaction)
        throw new Error(`Missing historical transaction ${hash}`);
      const receiptId = string(receipt.receipt_id, "historical receipt ID");
      const matching = array(transaction.receipts, "transaction receipts")
        .map((item) => object(item, "transaction receipt"))
        .filter(
          (item) =>
            object(item.receipt, "receipt envelope").receipt_id === receiptId,
        );
      if (matching.length !== 1)
        throw new Error(
          `Historical receipt ${receiptId} is missing or duplicated`,
        );
      const execution = object(
        matching[0]!.execution_outcome,
        "historical execution outcome",
      );
      const outcome = object(execution.outcome, "historical receipt result");
      if (
        integer(execution.block_height, "receipt block height") !== height ||
        outcome.executor_id !== this.contractId ||
        successful(outcome.status) !== receipt.is_success
      )
        throw new Error(`Historical receipt ${receiptId} disagrees with block`);
      if (receipt.is_success)
        events.push(...eventsFromLogs(receiptId, outcome.logs));
    }
    return {
      height,
      hash: string(canonicalHeader.hash, "archival block hash"),
      prevHash: string(canonicalHeader.prev_hash, "archival previous hash"),
      timestampNs: string(
        canonicalHeader.timestamp_nanosec,
        "archival timestamp",
      ),
      source: "history",
      events,
    };
  }
}
