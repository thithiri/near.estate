import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ChainPlot } from "@estate/shared";
import type { ChainGateway } from "./chain.js";
import { ImpressionLedger } from "./impression-ledger.js";
import type { ApiStore } from "./store.js";

export const PRIVATE_PREVIEW_TTL_SECONDS = 7 * 24 * 60 * 60;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const MEDIA_SCAN_LIMIT = 50;

async function reconcileOldMediaProposals(
  store: ApiStore,
  chain: ChainGateway,
  cutoff: number,
  now: number,
): Promise<void> {
  const records = store.staleSelectedMediaProposals(
    cutoff,
    now - SWEEP_INTERVAL_MS / 1_000,
    MEDIA_SCAN_LIMIT,
  );
  const plots = new Map<string, Promise<ChainPlot | null>>();
  const results = await Promise.allSettled(
    records.map(async (record) => {
      let plot = plots.get(record.plotId);
      if (!plot) {
        plot = chain.plot(record.plotId);
        plots.set(record.plotId, plot);
      }
      let view: ChainPlot | null;
      try {
        view = await plot;
      } catch {
        // Retain bytes when the finalized chain view is unavailable.
        store.markMediaChecked(record.id, now);
        return;
      }
      try {
        if (!view) return;
        const slot =
          record.kind === "Logo" ? view.plot.logo : view.plot.billboard;
        const matches = (candidate: typeof slot.pending) =>
          candidate?.revision === record.expectedMediaRevision + 1 &&
          candidate.owner === record.accountId &&
          candidate.building_type === record.buildingType &&
          candidate.level === record.level &&
          candidate.layout_revision === record.layoutRevision &&
          candidate.content.asset_hash === record.assetHash &&
          candidate.content.link === record.link;
        if (matches(slot.pending)) {
          store.markMediaSubmitted(record.id, slot.pending!.revision);
          return;
        }
        const decision = slot.last_decision;
        if (decision && matches(decision.proposal)) {
          if (decision.status === "Rejected") {
            store.markMediaSubmitted(record.id, decision.proposal.revision);
            store.markMediaDecided(
              record.id,
              "rejected",
              decision.decided_at,
              decision.reason,
            );
            return;
          }
          if (
            decision.status === "Approved" &&
            slot.active?.content.asset_hash === record.assetHash &&
            slot.active.content.link === record.link &&
            slot.active.approved_layout_revision === record.layoutRevision
          ) {
            store.markMediaSubmitted(record.id, decision.proposal.revision);
            store.markMediaDecided(
              record.id,
              "approved",
              decision.decided_at,
              null,
            );
            return;
          }
        }
        if (
          slot.active?.content.asset_hash === record.assetHash ||
          slot.pending?.content.asset_hash === record.assetHash
        )
          return;
        if (
          slot.revision > record.expectedMediaRevision ||
          view.plot.building.layout_revision > record.layoutRevision
        )
          store.markMediaSuperseded(record.id, now);
      } finally {
        store.markMediaChecked(record.id, now);
      }
    }),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
}

export async function sweepPrivateAssets(
  store: ApiStore,
  now: number,
  chain: ChainGateway | null = null,
): Promise<{
  assetLinksExpired: number;
  uploadsExpired: number;
  filesRemoved: number;
}> {
  if (!Number.isSafeInteger(now) || now < PRIVATE_PREVIEW_TTL_SECONDS)
    throw new Error("Invalid asset retention time");
  if (chain)
    await reconcileOldMediaProposals(
      store,
      chain,
      now - PRIVATE_PREVIEW_TTL_SECONDS,
      now,
    );
  return store.withAssetMutation(async () => {
    const cutoff = now - PRIVATE_PREVIEW_TTL_SECONDS;
    const assetLinksExpired = store.expirePrivateCandidates(cutoff);
    const uploadsExpired = store.expireStaleUploads(cutoff);
    let filesRemoved = 0;
    for (const file of await readdir(store.assetDir)) {
      if (!/^[0-9a-f]{64}\.png$/.test(file)) continue;
      const path = join(store.assetDir, file);
      let modifiedAt: number;
      try {
        modifiedAt = (await stat(path)).mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (modifiedAt > cutoff * 1_000) continue;
      const hash = file.slice(0, -4);
      if (store.retainsAsset(hash, cutoff)) continue;
      try {
        await unlink(path);
        filesRemoved++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { assetLinksExpired, uploadsExpired, filesRemoved };
  });
}

export class AssetRetentionWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private readonly impressionLedger: ImpressionLedger;

  constructor(
    private readonly store: ApiStore,
    private readonly chain: ChainGateway | null = null,
    private readonly clock: () => number = () => Math.floor(Date.now() / 1_000),
  ) {
    this.impressionLedger = new ImpressionLedger(store.db);
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.tick().catch((error) =>
        console.error("API retention sweep failed", error),
      );
    }, SWEEP_INTERVAL_MS);
    void this.tick().catch((error) =>
      console.error("API retention sweep failed", error),
    );
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await this.running;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    const running = Promise.resolve().then(async () => {
      const now = this.clock();
      this.impressionLedger.pruneExpiredSessions(now);
      this.store.pruneExpiredAuth(now);
      await sweepPrivateAssets(this.store, now, this.chain);
    });
    this.running = running;
    const clear = () => {
      if (this.running === running) this.running = null;
    };
    void running.then(clear, clear);
    return running;
  }
}
