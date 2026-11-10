import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChainGateway } from "./chain.js";
import {
  ImageProviderError,
  type ImageGenerationResult,
} from "./image-provider.js";
import {
  PaidGenerationLedger,
  type PaidJob,
} from "./paid-generation-ledger.js";
import { processPaidImageResult } from "./paid-image-processing.js";
import type { ApiStore } from "./store.js";

export type PaidImageProvider = {
  generate(
    prompt: string,
    accountId: string,
    clientRequestId: string,
    referencePng?: Buffer | null,
  ): Promise<ImageGenerationResult>;
};

export type PaidImageWorkerOptions = {
  ledger: PaidGenerationLedger;
  store: ApiStore;
  chain: ChainGateway;
  provider: PaidImageProvider;
  assetDir: string;
  clock?: () => number;
  workerId?: string;
};

export class PaidImageWorker {
  private readonly ledger: PaidGenerationLedger;
  private readonly store: ApiStore;
  private readonly chain: ChainGateway;
  private readonly provider: PaidImageProvider;
  private readonly assetDir: string;
  private readonly clock: () => number;
  private readonly workerId: string;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(options: PaidImageWorkerOptions) {
    this.ledger = options.ledger;
    this.store = options.store;
    this.chain = options.chain;
    this.provider = options.provider;
    this.assetDir = options.assetDir;
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    this.workerId = options.workerId ?? randomUUID();
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 10_000);
    void this.tick().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await this.running;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    const running = this.runOnce();
    this.running = running;
    const clear = () => {
      if (this.running === running) this.running = null;
    };
    void running.then(clear, clear);
    return running;
  }

  private async runOnce(): Promise<void> {
    const jobs: PaidJob[] = [];
    for (let index = 0; index < 2; index++) {
      const job = this.ledger.claim(this.workerId, this.clock());
      if (!job) break;
      jobs.push(job);
    }
    await Promise.allSettled(jobs.map((job) => this.processJob(job.id)));
  }

  private async currentPlotMatches(job: PaidJob): Promise<boolean> {
    if (!job.snapshot) return false;
    const current = await this.chain.plot(job.plotId);
    const building = current?.plot.building;
    const approvedAtRequest =
      job.snapshot.approvedManifestHashAtRequest === undefined
        ? job.snapshot.promptSpec.referenceManifestHash
        : job.snapshot.approvedManifestHashAtRequest;
    const referenceHash = job.snapshot.promptSpec.referenceManifestHash;
    return Boolean(
      current?.plot.owner === job.accountId &&
        building?.building_type === job.snapshot.buildingType &&
        building.level === job.snapshot.level &&
        building.variant === job.snapshot.promptSpec.variant &&
        building.layout_revision === job.snapshot.layoutRevision &&
        building.appearance_revision === job.snapshot.appearanceRevision &&
        building.approved_manifest_hash === approvedAtRequest &&
        !(
          referenceHash &&
          building.last_appearance_decision?.status === "Revoked" &&
          building.last_appearance_decision.reference.manifest_hash ===
            referenceHash
        ),
    );
  }

  private async referencePng(job: PaidJob): Promise<Buffer | null> {
    const snapshot = job.snapshot;
    const referenceHash = snapshot?.promptSpec.referenceManifestHash;
    if (!snapshot || !referenceHash) return null;
    const candidate = this.store.approvedReference(
      job.accountId,
      job.plotId,
      snapshot.buildingType,
      snapshot.level,
      referenceHash,
    );
    if (!candidate) throw new Error("Approved reference is unavailable");
    const png = await readFile(
      join(this.assetDir, `${candidate.spriteHash}.png`),
    );
    if (createHash("sha256").update(png).digest("hex") !== candidate.spriteHash)
      throw new Error("Approved reference hash does not match stored art");
    return png;
  }

  private async processJob(jobId: string): Promise<void> {
    while (true) {
      const job = this.ledger.job(jobId);
      if (!job || job.status !== "leased") return;
      let matches: boolean;
      try {
        matches = await this.currentPlotMatches(job);
      } catch {
        this.ledger.releaseLease(jobId, this.workerId);
        return;
      }
      if (!matches) {
        this.ledger.supersede(jobId);
        return;
      }
      let referencePng: Buffer | null;
      try {
        referencePng = await this.referencePng(job);
      } catch {
        this.ledger.failPreflight(jobId, this.workerId);
        return;
      }
      this.ledger.renewLease(jobId, this.workerId, this.clock());
      const attempt = this.ledger.beginAttempt(
        jobId,
        this.workerId,
        this.clock(),
      );
      let result: ImageGenerationResult;
      try {
        result = await this.provider.generate(
          job.snapshot!.promptSpec.prompt,
          job.accountId,
          attempt.clientRequestId,
          referencePng,
        );
      } catch (error) {
        const outcome =
          error instanceof ImageProviderError ? error.outcome : "uncertain";
        const updated = this.ledger.finishAttempt({
          jobId,
          workerId: this.workerId,
          clientRequestId: attempt.clientRequestId,
          providerRequestId:
            error instanceof ImageProviderError
              ? error.providerRequestId
              : null,
          outcome,
          now: this.clock(),
        });
        if (updated.status !== "leased") return;
        continue;
      }
      if (result.clientRequestId !== attempt.clientRequestId) {
        this.ledger.finishAttempt({
          jobId,
          workerId: this.workerId,
          clientRequestId: attempt.clientRequestId,
          providerRequestId: result.providerRequestId,
          outcome: "uncertain",
          now: this.clock(),
        });
        return;
      }
      const updated = await this.store.withAssetMutation(() =>
        processPaidImageResult({
          ledger: this.ledger,
          jobId,
          workerId: this.workerId,
          clientRequestId: attempt.clientRequestId,
          providerRequestId: result.providerRequestId,
          png: result.png,
          assetDir: this.assetDir,
          now: this.clock(),
        }),
      );
      if (updated.status !== "leased") return;
    }
  }
}
