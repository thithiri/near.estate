import type { EventStore, FinalizedBlock } from "./event-store.js";

export interface EventSource {
  latestFinalHeight(): Promise<number>;
  block(height: number): Promise<FinalizedBlock | null>;
}

export class EventIndexer {
  constructor(
    readonly store: EventStore,
    readonly source: EventSource,
    readonly maxBlocksPerTick = 10,
    readonly blockDelayMs = 1_000,
  ) {
    if (!Number.isSafeInteger(maxBlocksPerTick) || maxBlocksPerTick < 1)
      throw new Error("Invalid indexer batch size");
    if (!Number.isSafeInteger(blockDelayMs) || blockDelayMs < 0)
      throw new Error("Invalid indexer block delay");
  }

  async runOnce(): Promise<{
    from: number;
    through: number;
    tip: number;
    events: number;
  }> {
    const start = this.store.cursor().height + 1;
    const tip = await this.source.latestFinalHeight();
    if (!Number.isSafeInteger(tip) || tip < start - 1)
      throw new Error("Finalized source tip is behind the stored cursor");
    const end = Math.min(tip, start + this.maxBlocksPerTick - 1);
    let events = 0;
    for (let height = start; height <= end; height++) {
      if (height > start && this.blockDelayMs > 0)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.blockDelayMs),
        );
      const block = await this.source.block(height);
      events += this.store.applyHeight(height, block);
    }
    return { from: start, through: this.store.cursor().height, tip, events };
  }
}
