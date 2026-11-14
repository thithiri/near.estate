import { KeyPair, PublicKey } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
} from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import {
  setupWalletSelector,
  type WalletModuleFactory,
  type WalletSelector,
} from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import {
  setupModal,
  type WalletSelectorModal,
} from "@near-wallet-selector/modal-ui";
import {
  BuildingType,
  CarBody,
  CarColor,
  type MaterialHint,
  type ThemeHint,
  type AssetManifest,
  type AssetManifestV2,
} from "@estate/shared";
import { ChainReader } from "./chain-reader.js";
import type { PlotAgentStatus } from "./chain-reader.js";
import { PRESET_PALETTES } from "./preset-catalog.js";

export const GAMEPLAY_METHODS = [
  "park",
  "park_tower",
  "collect",
  "settle_expired",
  "ticket",
  "repair",
  "check_in_destination",
  "emergency_repair",
  "set_rule",
] as const;
export type GameplayMethod = (typeof GAMEPLAY_METHODS)[number];
export const GAMEPLAY_KEY_ALLOWANCE = 250n * 10n ** 21n; // 0.25 testnet NEAR
export const PARKING_AGENT_METHODS = [
  "park",
  "collect",
  "settle_expired",
] as const;
export const PARKING_AGENT_KEY_ALLOWANCE = 50n * 10n ** 21n; // 0.05 testnet NEAR
export const PLOT_AGENT_METHODS = [
  "agent_set_rule",
  "agent_ticket",
  "agent_choose_design",
  "agent_upgrade_building",
] as const;
export const PLOT_AGENT_KEY_ALLOWANCE = 50n * 10n ** 21n;
const CALL_GAS = 60n * 10n ** 12n;
const FINAL_BLOCK_SAFETY_MARGIN = 2n;
const NETWORK = "testnet";
type KeyRecord = {
  accountId: string;
  publicKey: string;
  secretKey: string;
};
type PendingKey = KeyRecord & { operation: "add" | "revoke" };
type PendingGameplayAction = {
  accountId: string;
  publicKey: string;
  method: GameplayMethod;
  argsJson: string;
  hash: string;
  signedTxBase64: string;
} & (
  | { version: 1 }
  | { version: 2; signedAtBlockHeight: number; nonce: string }
);
export type GameplayKeyStatus = "ready" | "pending" | "inactive" | "none";
export type ParkingAgentKeyStatus = {
  state: "none" | "pending-add" | "ready" | "inactive" | "pending-revoke";
  publicKey: string | null;
  allowance: string | null;
};
export type PlotAgentAccess = {
  state: "none" | "pending-key" | "pending-grant" | "ready" | "inactive";
  publicKey: string | null;
  status: PlotAgentStatus | null;
};
type ParkingAgentRecord = {
  accountId: string;
  publicKey: string;
  operation: "add" | "revoke";
};
export type ArtworkUpload = {
  uploadId: string;
  hash: string;
  url: string;
  width: number;
  height: number;
  status: "pending";
  layoutRevision: number;
};

export type MediaProposalRecord = {
  id: string;
  uploadId: string;
  accountId: string;
  plotId: string;
  kind: "Logo" | "Billboard";
  assetHash: string;
  link: string | null;
  buildingType: string;
  level: number;
  layoutRevision: number;
  expectedMediaRevision: number;
  proposalRevision: number | null;
  status:
    | "selected"
    | "submitted"
    | "approved"
    | "rejected"
    | "revoked"
    | "superseded";
  decidedAt: number | null;
  decisionReason: string | null;
  createdAt: number;
  assetUrl: string | null;
};

export type MockGenerationJob = {
  id: string;
  accountId: string;
  plotId: string;
  buildingType: string;
  level: number;
  layoutRevision: number;
  appearanceRevision: number | null;
  description: string;
  promptSpec: {
    version: number;
    themeHint?: ThemeHint;
    materialHints?: MaterialHint[];
    frontageUnits?: 1 | 2 | 3;
    designChoice?: number;
    buildingType?: string;
    level?: number;
  } | null;
  status:
    | "ready"
    | "selected"
    | "submitted"
    | "approved"
    | "rejected"
    | "revoked"
    | "expired";
  selectedCandidateId: 1 | 2 | 3 | null;
  proposalRevision: number | null;
  decidedAt: number | null;
  decisionReason: string | null;
  mode: "curated_mock" | "paid";
  candidates: MockGenerationCandidate[];
  createdAt: number;
};

export type MockGenerationCandidate = {
  id: 1 | 2 | 3;
  variant: 1 | 2;
  palette: string;
  manifest: AssetManifest | AssetManifestV2;
  manifestHash: string;
  spriteHash: string;
  thumbnailHash: string;
  spriteUrl: string;
  thumbnailUrl: string;
};

export type PaidGenerationJob = {
  id: string;
  mode: "paid";
  plotId: string;
  status:
    | "queued"
    | "leased"
    | "uncertain"
    | "complete"
    | "partial"
    | "awaiting_review"
    | "review_rejected"
    | "failed"
    | "cancelled"
    | "superseded"
    | "expired";
  acceptedCount: number;
  reviewedCount: number;
  approvedCount: number;
  attemptsStarted: number;
  cancellationPending: boolean;
  designJobId: string | null;
  candidates: MockGenerationCandidate[];
  createdAt: number;
};

async function apiResponse<T>(response: Response): Promise<T> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof value === "object" &&
      value !== null &&
      "message" in value &&
      typeof value.message === "string"
        ? value.message
        : `Artwork service failed (${response.status})`;
    throw new Error(message);
  }
  return value as T;
}

function readRecord(value: string | null): KeyRecord | null {
  if (!value) return null;
  try {
    const record: unknown = JSON.parse(value);
    if (typeof record !== "object" || record === null) return null;
    const candidate = record as Record<string, unknown>;
    if (
      typeof candidate.accountId !== "string" ||
      typeof candidate.publicKey !== "string" ||
      typeof candidate.secretKey !== "string" ||
      !candidate.publicKey.startsWith("ed25519:") ||
      !candidate.secretKey.startsWith("ed25519:")
    )
      return null;
    if (
      KeyPair.fromString(candidate.secretKey as `ed25519:${string}`)
        .getPublicKey()
        .toString() !== candidate.publicKey
    )
      return null;
    return {
      accountId: candidate.accountId,
      publicKey: candidate.publicKey,
      secretKey: candidate.secretKey,
    };
  } catch {
    return null;
  }
}

function pendingRecord(value: string | null): PendingKey | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = readRecord(value);
    const operation = (parsed as Record<string, unknown>).operation;
    if (!record || (operation !== "add" && operation !== "revoke")) return null;
    return { ...record, operation };
  } catch {
    return null;
  }
}

function pendingGameplayAction(value: string): PendingGameplayAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      "Saved gameplay action is damaged; contact support before retrying",
    );
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(
      "Saved gameplay action is damaged; contact support before retrying",
    );
  const record = parsed as Record<string, unknown>;
  if (
    (record.version !== 1 && record.version !== 2) ||
    typeof record.accountId !== "string" ||
    typeof record.publicKey !== "string" ||
    !GAMEPLAY_METHODS.includes(record.method as GameplayMethod) ||
    typeof record.argsJson !== "string" ||
    typeof record.hash !== "string" ||
    typeof record.signedTxBase64 !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(record.hash) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(record.signedTxBase64) ||
    (record.version === 2 &&
      (typeof record.signedAtBlockHeight !== "number" ||
        !Number.isSafeInteger(record.signedAtBlockHeight) ||
        record.signedAtBlockHeight < 0 ||
        typeof record.nonce !== "string" ||
        !/^\d+$/.test(record.nonce)))
  )
    throw new Error(
      "Saved gameplay action is damaged; contact support before retrying",
    );
  return record as PendingGameplayAction;
}

export class GameWalletClient {
  private lastCall: Promise<unknown> = Promise.resolve();
  private lastGameplayFailureReason: string | null = null;

  get failedGameplayReason(): string | null {
    return this.lastGameplayFailureReason;
  }
  private readonly selectedCars = new Map<string, number>();

  private constructor(
    readonly reader: ChainReader,
    readonly selector: WalletSelector,
    private readonly modal: WalletSelectorModal,
  ) {}

  static async create(reader: ChainReader): Promise<GameWalletClient> {
    const modules: WalletModuleFactory[] = [setupMeteorWallet()];
    if (import.meta.env.VITE_EXPERIMENTAL_INTEAR === "1") {
      const { setupIntearWallet } = await import(
        "@near-wallet-selector/intear-wallet"
      );
      modules.push(setupIntearWallet());
    }
    const selector = await setupWalletSelector({
      network: NETWORK,
      modules,
    });
    const modal = setupModal(selector, {
      contractId: reader.contractId,
      methodNames: ["get_account"],
      theme: "light",
    });
    return new GameWalletClient(reader, selector, modal);
  }

  get accountId(): string | null {
    const state = this.selector.store.getState();
    if (state.contract?.contractId !== this.reader.contractId) return null;
    return state.accounts.find((account) => account.active)?.accountId ?? null;
  }

  connect(): void {
    this.modal.show();
  }

  selectedCarId(): number | null {
    const accountId = this.accountId;
    return accountId ? (this.selectedCars.get(accountId) ?? null) : null;
  }

  selectCar(carId: number): void {
    this.selectedCars.set(this.requiredAccount(), carId);
  }

  async signOut(): Promise<void> {
    if (this.accountId) {
      if (
        typeof localStorage !== "undefined" &&
        localStorage.getItem(this.actionName(this.accountId))
      )
        throw new Error(
          "Check the pending gameplay action before disconnecting",
        );
      const keyStatus = await this.resumePendingKey();
      if (keyStatus === "pending")
        throw new Error("Finish the gameplay key action before disconnecting");
      if (keyStatus === "ready" || keyStatus === "inactive") {
        const revoked = await this.revokeGameplayKey();
        if (revoked !== "revoked")
          throw new Error(
            "Wait for gameplay key revocation before disconnecting",
          );
      }
    }
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!response.ok)
      throw new Error("Could not end the artwork session; try again");
    const wallet = await this.selector.wallet();
    await wallet.signOut();
  }

  async artworkSession(): Promise<void> {
    const accountId = this.requiredAccount();
    const existing = await fetch("/api/auth/me", {
      credentials: "same-origin",
    });
    if (existing.ok) {
      const session = await apiResponse<{ accountId: string }>(existing);
      if (session.accountId === accountId) return;
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } else if (existing.status !== 401) {
      await apiResponse(existing);
    }
    const challenge = await apiResponse<{
      challengeId: string;
      accountId: string;
      message: string;
      nonce: string;
      recipient: string;
      callbackUrl: string;
    }>(
      await fetch("/api/auth/challenge", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId }),
      }),
    );
    if (challenge.accountId !== accountId)
      throw new Error("Artwork challenge was issued for another wallet");
    const wallet = await this.selector.wallet();
    const signedMessage = await wallet.signMessage({
      message: challenge.message,
      nonce: Buffer.from(challenge.nonce, "base64"),
      recipient: challenge.recipient,
      callbackUrl: challenge.callbackUrl,
      state: challenge.challengeId,
    });
    if (!signedMessage)
      throw new Error("Finish the wallet signature and retry the upload");
    if (this.accountId !== accountId || signedMessage.accountId !== accountId)
      throw new Error("Wallet account changed during artwork sign-in");
    await apiResponse(
      await fetch("/api/auth/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          signedMessage,
        }),
      }),
    );
  }

  async uploadMedia(
    plotId: string,
    kind: "Logo" | "Billboard",
    file: File,
  ): Promise<ArtworkUpload> {
    const accountId = this.requiredAccount();
    if (file.size < 1 || file.size > 1024 * 1024)
      throw new Error("Choose an image smaller than 1 MB");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
      throw new Error("Choose a PNG, JPEG or WebP image");
    await this.artworkSession();
    if (this.accountId !== accountId)
      throw new Error("Wallet account changed during upload");
    const body = new FormData();
    body.set("plot_id", plotId);
    body.set("file", file);
    const upload = await apiResponse<ArtworkUpload>(
      await fetch(kind === "Logo" ? "/api/logos" : "/api/ads", {
        method: "POST",
        credentials: "same-origin",
        body,
      }),
    );
    if (!/^[0-9a-f]{64}$/.test(upload.hash) || upload.status !== "pending")
      throw new Error("Artwork service returned an invalid upload");
    return upload;
  }

  async latestUpload(
    plotId: string,
    kind: "Logo" | "Billboard",
  ): Promise<ArtworkUpload | null> {
    await this.artworkSession();
    const response = await fetch(
      `/api/media/uploads/latest?plot_id=${encodeURIComponent(plotId)}&kind=${kind}`,
      { credentials: "same-origin" },
    );
    if (response.status === 404) return null;
    const upload = await apiResponse<ArtworkUpload>(response);
    if (!/^[0-9a-f]{64}$/.test(upload.hash) || upload.status !== "pending")
      throw new Error("Artwork service returned an invalid upload");
    return upload;
  }

  async reuseApprovedMedia(
    plotId: string,
    kind: "Logo" | "Billboard",
  ): Promise<ArtworkUpload> {
    const accountId = this.requiredAccount();
    await this.artworkSession();
    if (this.accountId !== accountId)
      throw new Error("Wallet account changed during media reuse");
    const upload = await apiResponse<ArtworkUpload>(
      await fetch("/api/media/uploads/reuse", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plotId, kind }),
      }),
    );
    if (!/^[0-9a-f]{64}$/.test(upload.hash) || upload.status !== "pending")
      throw new Error("Artwork service returned an invalid reused image");
    return upload;
  }

  async createMediaProposal(
    upload: ArtworkUpload,
    plotId: string,
    kind: "Logo" | "Billboard",
    link: string | null,
  ): Promise<MediaProposalRecord> {
    await this.artworkSession();
    const record = await apiResponse<MediaProposalRecord>(
      await fetch("/api/media/proposals", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadId: upload.uploadId, link }),
      }),
    );
    if (
      record.accountId !== this.requiredAccount() ||
      record.plotId !== plotId ||
      record.kind !== kind ||
      record.assetHash !== upload.hash ||
      record.layoutRevision !== upload.layoutRevision ||
      record.link !== link ||
      record.status !== "selected"
    )
      throw new Error("Artwork service returned an invalid media proposal");
    return record;
  }

  async latestMediaProposal(
    plotId: string,
    kind: "Logo" | "Billboard",
  ): Promise<MediaProposalRecord | null> {
    await this.artworkSession();
    const response = await fetch(
      `/api/media/proposals/latest?plot_id=${encodeURIComponent(plotId)}&kind=${kind}`,
      { credentials: "same-origin" },
    );
    if (response.status === 404) return null;
    const record = await apiResponse<MediaProposalRecord>(response);
    if (
      record.accountId !== this.requiredAccount() ||
      record.plotId !== plotId ||
      record.kind !== kind
    )
      throw new Error("Artwork service returned an invalid media proposal");
    return record;
  }

  async reconcileMediaProposal(
    id: string,
  ): Promise<MediaProposalRecord | null> {
    await this.artworkSession();
    const response = await fetch(
      `/api/media/proposals/${encodeURIComponent(id)}/reconcile`,
      { method: "POST", credentials: "same-origin" },
    );
    if (response.status === 409) return null;
    const record = await apiResponse<MediaProposalRecord>(response);
    if (record.id !== id || record.accountId !== this.requiredAccount())
      throw new Error("Artwork service returned the wrong media proposal");
    return record;
  }

  async submitMediaProposal(
    record: MediaProposalRecord,
  ): Promise<MediaProposalRecord> {
    const accountId = this.requiredAccount();
    if (record.accountId !== accountId || record.status !== "selected")
      throw new Error("This media proposal is not ready to submit");
    const confirmed = await this.reconcileMediaProposal(record.id);
    if (confirmed) return confirmed;
    const plot = await this.ownerPlot(record.plotId, accountId);
    const slot = record.kind === "Logo" ? plot.plot.logo : plot.plot.billboard;
    if (
      plot.plot.building.building_type !== record.buildingType ||
      plot.plot.building.level !== record.level ||
      plot.plot.building.layout_revision !== record.layoutRevision ||
      slot.revision !== record.expectedMediaRevision
    )
      throw new Error(
        "The building or media slot changed; create a new proposal",
      );
    await this.ownerCall(
      "propose_media",
      {
        plot_id: record.plotId,
        kind: record.kind,
        expected_media_revision: record.expectedMediaRevision,
        expected_layout_revision: record.layoutRevision,
        content: { asset_hash: record.assetHash, link: record.link },
      },
      accountId,
    );
    return (await this.reconcileMediaProposal(record.id)) ?? record;
  }

  async removeMedia(plotId: string, kind: "Logo" | "Billboard"): Promise<void> {
    const accountId = this.requiredAccount();
    const before = await this.ownerPlot(plotId, accountId);
    const slot = kind === "Logo" ? before.plot.logo : before.plot.billboard;
    if (!slot.active && !slot.pending)
      throw new Error("This media slot is already empty");
    await this.ownerCall(
      "remove_media",
      { plot_id: plotId, kind, expected_media_revision: slot.revision },
      accountId,
    );
    const after = await this.ownerPlot(plotId, accountId);
    const current = kind === "Logo" ? after.plot.logo : after.plot.billboard;
    if (
      current.revision !== slot.revision + 1 ||
      current.active ||
      current.pending
    )
      throw new Error("Media removal is awaiting chain confirmation");
  }

  async createMockGeneration(
    plotId: string,
    description: string,
    palette: string,
    themeHint: ThemeHint,
    materialHints: MaterialHint[],
  ): Promise<MockGenerationJob> {
    await this.artworkSession();
    const job = await apiResponse<MockGenerationJob>(
      await fetch("/api/generations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plotId,
          description,
          palette,
          themeHint,
          materialHints,
        }),
      }),
    );
    if (
      job.mode !== "curated_mock" ||
      job.plotId !== plotId ||
      job.accountId !== this.requiredAccount() ||
      job.candidates?.length !== 3
    )
      throw new Error("Artwork service returned an invalid design job");
    return job;
  }

  async paidGenerationEnabled(): Promise<boolean> {
    const status = await apiResponse<{ enabled: boolean }>(
      await fetch("/api/paid-generations/status", {
        credentials: "same-origin",
      }),
    );
    return status.enabled === true;
  }

  async createPaidGeneration(
    plotId: string,
    description: string,
    palette: string,
    themeHint: ThemeHint,
    materialHints: MaterialHint[],
    usePriorArt: boolean,
    fresh = false,
  ): Promise<PaidGenerationJob> {
    await this.artworkSession();
    const accountId = this.requiredAccount();
    const request = {
      plotId,
      description,
      palette,
      themeHint,
      materialHints,
      usePriorArt,
    };
    const fingerprint = JSON.stringify({
      ...request,
      materialHints: [...materialHints].sort(),
    });
    const storageKey = `near-estate:paid-request:${this.reader.contractId}:${accountId}:${plotId}`;
    let saved: { fingerprint: string; key: string } | null = null;
    try {
      const parsed: unknown = JSON.parse(
        localStorage.getItem(storageKey) ?? "null",
      );
      if (
        parsed &&
        typeof parsed === "object" &&
        "fingerprint" in parsed &&
        typeof parsed.fingerprint === "string" &&
        "key" in parsed &&
        typeof parsed.key === "string"
      )
        saved = { fingerprint: parsed.fingerprint, key: parsed.key };
    } catch {
      saved = null;
    }
    const key =
      !fresh &&
      saved?.fingerprint === fingerprint &&
      /^[A-Za-z0-9_-]{16,128}$/.test(saved.key)
        ? saved.key
        : crypto.randomUUID();
    localStorage.setItem(storageKey, JSON.stringify({ fingerprint, key }));
    const job = await apiResponse<PaidGenerationJob>(
      await fetch("/api/paid-generations", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(request),
      }),
    );
    if (job.mode !== "paid" || job.plotId !== plotId || !job.id)
      throw new Error("Artwork service returned an invalid prompt job");
    return job;
  }

  async latestPaidGeneration(
    plotId: string,
  ): Promise<PaidGenerationJob | null> {
    await this.artworkSession();
    const response = await fetch(
      `/api/paid-generations/latest?plot_id=${encodeURIComponent(plotId)}`,
      { credentials: "same-origin" },
    );
    if (response.status === 404) return null;
    const job = await apiResponse<PaidGenerationJob>(response);
    if (job.mode !== "paid" || job.plotId !== plotId)
      throw new Error("Artwork service returned the wrong prompt job");
    return job;
  }

  async paidGeneration(jobId: string): Promise<PaidGenerationJob> {
    await this.artworkSession();
    const job = await apiResponse<PaidGenerationJob>(
      await fetch(`/api/paid-generations/${encodeURIComponent(jobId)}`, {
        credentials: "same-origin",
      }),
    );
    if (job.mode !== "paid" || job.id !== jobId)
      throw new Error("Artwork service returned the wrong prompt job");
    return job;
  }

  async generationById(jobId: string): Promise<MockGenerationJob> {
    await this.artworkSession();
    const job = await apiResponse<MockGenerationJob>(
      await fetch(`/api/generations/${encodeURIComponent(jobId)}`, {
        credentials: "same-origin",
      }),
    );
    if (
      job.id !== jobId ||
      job.accountId !== this.requiredAccount() ||
      job.candidates.length < 1 ||
      job.candidates.length > 3
    )
      throw new Error("Artwork service returned an invalid design job");
    return job;
  }

  async latestMockGeneration(
    plotId: string,
  ): Promise<MockGenerationJob | null> {
    await this.artworkSession();
    const response = await fetch(
      `/api/generations/latest?plot_id=${encodeURIComponent(plotId)}`,
      { credentials: "same-origin" },
    );
    if (response.status === 404) return null;
    const job = await apiResponse<MockGenerationJob>(response);
    if (
      (job.mode !== "curated_mock" && job.mode !== "paid") ||
      job.plotId !== plotId ||
      job.accountId !== this.requiredAccount() ||
      job.candidates?.length < 1 ||
      job.candidates?.length > 3
    )
      throw new Error("Artwork service returned an invalid design job");
    return job;
  }

  async mockGenerationHistory(plotId: string): Promise<MockGenerationJob[]> {
    await this.artworkSession();
    const jobs = await apiResponse<MockGenerationJob[]>(
      await fetch(
        `/api/generations/history?plot_id=${encodeURIComponent(plotId)}`,
        { credentials: "same-origin" },
      ),
    );
    if (
      !Array.isArray(jobs) ||
      jobs.some(
        (job) =>
          job.plotId !== plotId ||
          job.accountId !== this.requiredAccount() ||
          job.candidates?.length < 1 ||
          job.candidates?.length > 3,
      )
    )
      throw new Error("Artwork service returned invalid design history");
    return jobs;
  }

  async reconcileMockGeneration(
    jobId: string,
  ): Promise<MockGenerationJob | null> {
    await this.artworkSession();
    const response = await fetch(
      `/api/generations/${encodeURIComponent(jobId)}/reconcile`,
      {
        method: "POST",
        credentials: "same-origin",
      },
    );
    if (response.status === 409) return null;
    const job = await apiResponse<MockGenerationJob>(response);
    if (job.accountId !== this.requiredAccount() || job.id !== jobId)
      throw new Error("Artwork service returned the wrong design job");
    return job;
  }

  async submitMockGeneration(
    job: MockGenerationJob,
    candidateId: 1 | 2 | 3,
  ): Promise<MockGenerationJob> {
    const accountId = this.requiredAccount();
    if (job.accountId !== accountId)
      throw new Error("This design job belongs to another wallet");
    if (job.status !== "ready" && job.status !== "selected")
      throw new Error("This design job is already under review");
    if (job.status === "selected") {
      if (job.selectedCandidateId !== candidateId)
        throw new Error("Another design was already selected for this job");
      const confirmed = await this.reconcileMockGeneration(job.id);
      if (confirmed) return confirmed;
    }
    const candidate = job.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) throw new Error("Selected design is missing");
    await this.artworkSession();
    const selection = await apiResponse<{
      jobId: string;
      candidateId: 1 | 2 | 3;
      plotId: string;
      expectedRevision: number;
      manifestHash: string;
    }>(
      await fetch(`/api/generations/${encodeURIComponent(job.id)}/select`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateId }),
      }),
    );
    if (
      selection.jobId !== job.id ||
      selection.plotId !== job.plotId ||
      selection.candidateId !== candidateId ||
      selection.manifestHash !== candidate.manifestHash ||
      selection.expectedRevision !== job.appearanceRevision
    )
      throw new Error(
        "Design proposal changed; restore the job before submitting",
      );
    job.status = "selected";
    job.selectedCandidateId = candidateId;
    const plot = await this.ownerPlot(job.plotId, accountId);
    if (
      plot.plot.building.layout_revision !== job.layoutRevision ||
      plot.plot.building.appearance_revision !== selection.expectedRevision ||
      plot.plot.building.building_type !== job.buildingType ||
      plot.plot.building.level !== job.level ||
      (job.promptSpec?.version === 5 &&
        (!("frontage_units" in plot.plot) ||
          plot.plot.frontage_units !== job.promptSpec.frontageUnits ||
          plot.plot.design_choice !== job.promptSpec.designChoice))
    )
      throw new Error("The building changed; generate new designs");
    await this.ownerCall(
      "propose_appearance",
      {
        plot_id: job.plotId,
        expected_revision: selection.expectedRevision,
        manifest_hash: selection.manifestHash,
      },
      accountId,
    );
    return (
      (await this.reconcileMockGeneration(job.id)) ?? {
        ...job,
        status: "selected",
        selectedCandidateId: candidateId,
      }
    );
  }

  private keyName(accountId: string): string {
    return `near-estate:${NETWORK}:${this.reader.contractId}:${accountId}:gameplay-key`;
  }

  private parkingAgentName(accountId: string): string {
    return `near-estate:${NETWORK}:${this.reader.contractId}:${accountId}:parking-agent-key`;
  }

  private plotAgentName(accountId: string): string {
    return `near-estate:${NETWORK}:${this.reader.contractId}:${accountId}:plot-agent-key`;
  }

  private plotAgentPublicKey(accountId: string): string | null {
    const value = localStorage.getItem(this.plotAgentName(accountId));
    if (!value) return null;
    if (!/^ed25519:[A-Za-z0-9]+$/.test(value))
      throw new Error("Saved plot agent public key is damaged");
    PublicKey.fromString(value);
    return value;
  }

  async plotAgentAccess(): Promise<PlotAgentAccess> {
    const accountId = this.requiredAccount();
    const status = await this.reader.plotAgentStatus(accountId);
    const publicKey =
      status?.grant.public_key ?? this.plotAgentPublicKey(accountId);
    if (!publicKey) return { state: "none", publicKey: null, status: null };
    const listed = await this.reader.accessKeyList(accountId);
    const access = listed.keys.find(
      (item) => item.public_key === publicKey,
    )?.access_key;
    if (!access)
      return { state: status ? "inactive" : "pending-key", publicKey, status };
    const permission =
      access.permission === "FullAccess" || access.permission === null
        ? null
        : access.permission.FunctionCall;
    const exact =
      permission?.receiver_id === this.reader.contractId &&
      permission.method_names.length === PLOT_AGENT_METHODS.length &&
      PLOT_AGENT_METHODS.every((method) =>
        permission.method_names.includes(method),
      ) &&
      typeof permission.allowance === "string" &&
      BigInt(permission.allowance) > 0n &&
      BigInt(permission.allowance) <= PLOT_AGENT_KEY_ALLOWANCE;
    return {
      state: exact ? (status ? "ready" : "pending-grant") : "inactive",
      publicKey,
      status,
    };
  }

  async authorizePlotAgent(
    publicKey: string,
    plotIds: string[],
    dailyCoinLimit: string,
    dailyActionLimit: number,
    allowDesignChanges: boolean,
  ): Promise<PlotAgentAccess> {
    const accountId = this.requiredAccount();
    if (!/^ed25519:[A-Za-z0-9]+$/.test(publicKey))
      throw new Error("Paste a plot-agent ed25519 public key");
    let parsed: PublicKey;
    try {
      parsed = PublicKey.fromString(publicKey);
    } catch {
      throw new Error("Plot agent public key is invalid");
    }
    const saved = this.plotAgentPublicKey(accountId);
    if (saved && saved !== publicKey)
      throw new Error("Finish or revoke the existing plot-agent key first");
    const before = await this.plotAgentAccess();
    if (before.status)
      throw new Error("Revoke the current plot-agent grant first");
    if (before.state === "inactive")
      throw new Error(
        "The plot-agent key has different permissions; revoke it first",
      );
    if (!saved) localStorage.setItem(this.plotAgentName(accountId), publicKey);
    if (before.state === "none" || before.state === "pending-key") {
      const listed = await this.reader.accessKeyList(accountId);
      if (!listed.keys.some((item) => item.public_key === publicKey)) {
        const wallet = await this.selector.wallet();
        await wallet.signAndSendTransaction({
          signerId: accountId,
          receiverId: accountId,
          actions: [
            actionCreators.addKey(
              parsed,
              actionCreators.functionCallAccessKey(
                this.reader.contractId,
                [...PLOT_AGENT_METHODS],
                PLOT_AGENT_KEY_ALLOWANCE,
              ),
            ),
          ],
        });
        if (this.accountId !== accountId)
          throw new Error(
            "Wallet account changed while adding the plot-agent key",
          );
      }
    }
    const keyReady = await this.plotAgentAccess();
    if (keyReady.state !== "pending-grant") return keyReady;
    const [quote, now] = await Promise.all([
      this.reader.plotAgentStorageQuote(),
      this.reader.chainTimeSeconds(),
    ]);
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: this.reader.contractId,
      actions: [
        actionCreators.functionCall(
          "authorize_plot_agent",
          {
            public_key: publicKey,
            plot_ids: plotIds,
            expires_at: now + 7 * 86_400,
            daily_coin_limit: dailyCoinLimit,
            daily_action_limit: dailyActionLimit,
            allow_design_changes: allowDesignChanges,
          },
          CALL_GAS,
          BigInt(quote),
        ),
      ],
    });
    if (this.accountId !== accountId)
      throw new Error(
        "Wallet account changed while authorizing the plot agent",
      );
    return this.plotAgentAccess();
  }

  async revokePlotAgent(): Promise<PlotAgentAccess> {
    const accountId = this.requiredAccount();
    let state = await this.plotAgentAccess();
    if (state.publicKey && !this.plotAgentPublicKey(accountId))
      localStorage.setItem(this.plotAgentName(accountId), state.publicKey);
    if (state.status) {
      const wallet = await this.selector.wallet();
      await wallet.signAndSendTransaction({
        signerId: accountId,
        receiverId: this.reader.contractId,
        actions: [
          actionCreators.functionCall("revoke_plot_agent", {}, CALL_GAS, 0n),
        ],
      });
      if (this.accountId !== accountId)
        throw new Error(
          "Wallet account changed while revoking the plot-agent grant",
        );
      state = await this.plotAgentAccess();
      if (state.status) return state;
    }
    if (!state.publicKey) return state;
    const listed = await this.reader.accessKeyList(accountId);
    if (listed.keys.some((item) => item.public_key === state.publicKey)) {
      const wallet = await this.selector.wallet();
      await wallet.signAndSendTransaction({
        signerId: accountId,
        receiverId: accountId,
        actions: [
          actionCreators.deleteKey(PublicKey.fromString(state.publicKey)),
        ],
      });
      if (this.accountId !== accountId)
        throw new Error(
          "Wallet account changed while deleting the plot-agent key",
        );
    }
    const remaining = await this.reader.accessKeyList(accountId);
    if (!remaining.keys.some((item) => item.public_key === state.publicKey))
      localStorage.removeItem(this.plotAgentName(accountId));
    return this.plotAgentAccess();
  }

  private parkingAgentRecord(accountId: string): ParkingAgentRecord | null {
    const raw = localStorage.getItem(this.parkingAgentName(accountId));
    if (!raw) return null;
    try {
      const record = JSON.parse(raw) as ParkingAgentRecord;
      if (
        record.accountId === accountId &&
        /^ed25519:[A-Za-z0-9]+$/.test(record.publicKey) &&
        (record.operation === "add" || record.operation === "revoke")
      ) {
        PublicKey.fromString(record.publicKey);
        return record;
      }
    } catch {
      // An unknown local record must not be overwritten with another key.
    }
    throw new Error(
      "Saved parking agent key is damaged; recover it before creating another",
    );
  }

  async parkingAgentKeyStatus(): Promise<ParkingAgentKeyStatus> {
    const accountId = this.requiredAccount();
    const record = this.parkingAgentRecord(accountId);
    if (!record) return { state: "none", publicKey: null, allowance: null };
    const listed = await this.reader.accessKeyList(accountId);
    const access = listed.keys.find(
      (item) => item.public_key === record.publicKey,
    )?.access_key;
    if (!access) {
      if (record.operation === "revoke") {
        localStorage.removeItem(this.parkingAgentName(accountId));
        return { state: "none", publicKey: null, allowance: null };
      }
      return {
        state: "pending-add",
        publicKey: record.publicKey,
        allowance: null,
      };
    }
    const permission =
      access.permission === "FullAccess" || access.permission === null
        ? null
        : access.permission.FunctionCall;
    const allowed =
      permission?.receiver_id === this.reader.contractId &&
      permission.method_names.length === PARKING_AGENT_METHODS.length &&
      PARKING_AGENT_METHODS.every((method) =>
        permission.method_names.includes(method),
      ) &&
      permission.allowance !== null &&
      BigInt(permission.allowance) > 0n &&
      BigInt(permission.allowance) <= PARKING_AGENT_KEY_ALLOWANCE;
    return {
      state:
        record.operation === "revoke"
          ? "pending-revoke"
          : allowed
            ? "ready"
            : "inactive",
      publicKey: record.publicKey,
      allowance: permission?.allowance ?? null,
    };
  }

  async addParkingAgentKey(publicKey: string): Promise<ParkingAgentKeyStatus> {
    const accountId = this.requiredAccount();
    if (!/^ed25519:[A-Za-z0-9]+$/.test(publicKey))
      throw new Error("Paste an ed25519 public key from agent:key:new");
    let parsed: PublicKey;
    try {
      parsed = PublicKey.fromString(publicKey);
    } catch {
      throw new Error("Parking agent public key is invalid");
    }
    const prior = this.parkingAgentRecord(accountId);
    if (prior && prior.publicKey !== publicKey)
      throw new Error("Revoke or finish the existing parking agent key first");
    if (prior?.operation === "revoke")
      throw new Error("Finish revoking the parking agent key first");
    if (prior) {
      const state = await this.parkingAgentKeyStatus();
      if (state.state === "ready") return state;
      if (state.state === "inactive")
        throw new Error(
          "Existing agent key has different permissions; revoke it first",
        );
    } else {
      const listed = await this.reader.accessKeyList(accountId);
      const existing = listed.keys.some(
        (item) => item.public_key === publicKey,
      );
      localStorage.setItem(
        this.parkingAgentName(accountId),
        JSON.stringify({ accountId, publicKey, operation: "add" }),
      );
      if (existing) {
        const status = await this.parkingAgentKeyStatus();
        if (status.state === "ready") return status;
        localStorage.removeItem(this.parkingAgentName(accountId));
        throw new Error("Existing public key is not a parking-only agent key");
      }
    }
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: accountId,
      actions: [
        actionCreators.addKey(
          parsed,
          actionCreators.functionCallAccessKey(
            this.reader.contractId,
            [...PARKING_AGENT_METHODS],
            PARKING_AGENT_KEY_ALLOWANCE,
          ),
        ),
      ],
    });
    if (this.accountId !== accountId)
      throw new Error("Wallet account changed while adding the agent key");
    return this.parkingAgentKeyStatus();
  }

  async revokeParkingAgentKey(): Promise<ParkingAgentKeyStatus> {
    const accountId = this.requiredAccount();
    const record = this.parkingAgentRecord(accountId);
    if (!record) throw new Error("No parking agent key is saved here");
    const state = await this.parkingAgentKeyStatus();
    if (state.state === "pending-add")
      throw new Error("Check or retry key creation before revoking it");
    if (state.state === "none") return state;
    localStorage.setItem(
      this.parkingAgentName(accountId),
      JSON.stringify({ ...record, operation: "revoke" }),
    );
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: accountId,
      actions: [
        actionCreators.deleteKey(PublicKey.fromString(record.publicKey)),
      ],
    });
    if (this.accountId !== accountId)
      throw new Error("Wallet account changed while revoking the agent key");
    return this.parkingAgentKeyStatus();
  }

  private pendingName(accountId: string): string {
    return `${this.keyName(accountId)}:pending`;
  }

  private actionName(accountId: string): string {
    return `${this.keyName(accountId)}:action`;
  }

  hasPendingGameplayAction(): boolean {
    const accountId = this.accountId;
    return Boolean(
      accountId && localStorage.getItem(this.actionName(accountId)),
    );
  }

  private requiredAccount(): string {
    const accountId = this.accountId;
    if (!accountId) throw new Error("Connect a testnet wallet first");
    return accountId;
  }

  private storedKey(accountId: string): KeyRecord | null {
    const record = readRecord(localStorage.getItem(this.keyName(accountId)));
    return record?.accountId === accountId ? record : null;
  }

  async register(body: string, color: string): Promise<void> {
    const accountId = this.requiredAccount();
    const starterBody = CarBody.parse(body);
    const starterColor = CarColor.parse(color);
    const quote = await this.reader.registrationQuote();
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: this.reader.contractId,
      actions: [
        actionCreators.functionCall(
          "register_player",
          { body: starterBody, color: starterColor },
          CALL_GAS,
          BigInt(quote),
        ),
      ],
    });
    if (this.accountId !== accountId)
      throw new Error("Wallet account changed during registration");
    const player = await this.reader.player(accountId);
    if (!player.account)
      throw new Error("Registration is awaiting chain confirmation");
  }

  async buyCar(body: string, color: string): Promise<void> {
    const accountId = this.requiredAccount();
    const before = await this.reader.player(accountId);
    if (!before.account) throw new Error("Register before buying a car");
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: this.reader.contractId,
      actions: [
        actionCreators.functionCall(
          "buy_car",
          { body: CarBody.parse(body), color: CarColor.parse(color) },
          CALL_GAS,
          0n,
        ),
      ],
    });
    if (this.accountId !== accountId) throw new Error("Wallet account changed");
    const after = await this.reader.player(accountId);
    if (after.cars.length !== before.cars.length + 1)
      throw new Error("Car purchase is awaiting chain confirmation");
  }

  async buyBurgerDecal(expectedCost?: string): Promise<void> {
    const accountId = this.requiredAccount();
    const before = await this.reader.player(accountId);
    if (!before.account) throw new Error("Register before buying a decal");
    if (before.account.burger_decal)
      throw new Error("Burger decal already owned");
    const cost = await this.reader.burgerDecalCost();
    if (expectedCost !== undefined && cost !== expectedCost)
      throw new Error("Decal price changed. Review it before buying");
    if (BigInt(before.account.balance) < BigInt(cost))
      throw new Error("Not enough coins for the burger decal");
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: this.reader.contractId,
      actions: [actionCreators.functionCall("buy_cosmetic", {}, CALL_GAS, 0n)],
    });
    if (this.accountId !== accountId) throw new Error("Wallet account changed");
    const after = await this.reader.player(accountId);
    if (!after.account?.burger_decal)
      throw new Error("Decal purchase is awaiting chain confirmation");
  }

  async buyPlot(plotId: string, expectedTotal?: string): Promise<void> {
    const accountId = this.requiredAccount();
    const plot = await this.reader.plot(plotId);
    if (!plot || plot.plot.owner) throw new Error("Plot is unavailable");
    const quote = await this.reader.plotPurchaseQuote(plotId);
    if (expectedTotal !== undefined && quote !== expectedTotal)
      throw new Error("Plot price changed. Review the new price before buying");
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: this.reader.contractId,
      actions: [
        actionCreators.functionCall(
          "buy_plot",
          { plot_id: plotId },
          CALL_GAS,
          BigInt(quote),
        ),
      ],
    });
    if (this.accountId !== accountId) throw new Error("Wallet account changed");
    const after = await this.reader.plot(plotId);
    if (after?.plot.owner !== accountId)
      throw new Error("Plot purchase is awaiting chain confirmation");
  }

  private async ownerPlot(plotId: string, accountId: string) {
    const plot = await this.reader.plot(plotId);
    if (!plot || plot.plot.owner !== accountId)
      throw new Error("This plot is not owned by the connected wallet");
    return plot;
  }

  private async ownerCall(method: string, args: object, accountId: string) {
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: this.reader.contractId,
      actions: [actionCreators.functionCall(method, args, CALL_GAS, 0n)],
    });
    if (this.accountId !== accountId) throw new Error("Wallet account changed");
  }

  async chooseDesign(plotId: string, choice: number): Promise<void> {
    const accountId = this.requiredAccount();
    const before = await this.ownerPlot(plotId, accountId);
    if (!("design_choice" in before.plot))
      throw new Error("This city does not support building designs yet");
    if (!Number.isInteger(choice) || choice < 0 || choice > 4)
      throw new Error("Choose one of the five building designs");
    if (before.plot.design_choice === choice) return;
    await this.ownerCall(
      "choose_design",
      { plot_id: plotId, choice },
      accountId,
    );
    const after = await this.reader.plot(plotId);
    if (
      !after ||
      !("design_choice" in after.plot) ||
      after.plot.design_choice !== choice
    )
      throw new Error("Building design is awaiting chain confirmation");
  }

  async choosePreset(
    plotId: string,
    variant: number,
    primaryColor: string,
    name: string,
  ): Promise<void> {
    const accountId = this.requiredAccount();
    await this.ownerPlot(plotId, accountId);
    if (variant !== 1 && variant !== 2) throw new Error("Choose shape 1 or 2");
    if (
      !PRESET_PALETTES.includes(
        primaryColor as (typeof PRESET_PALETTES)[number],
      )
    )
      throw new Error("Choose one of the four building colours");
    const cleanName = name.trim();
    if (
      !cleanName ||
      Array.from(cleanName).length > 24 ||
      [...cleanName].some((character) => /\p{Cc}/u.test(character))
    )
      throw new Error("Building name must be 1–24 characters");
    await this.ownerCall(
      "choose_preset",
      {
        plot_id: plotId,
        variant,
        primary_color: primaryColor,
        name: cleanName,
      },
      accountId,
    );
    const after = await this.ownerPlot(plotId, accountId);
    if (
      after.plot.building.variant !== variant ||
      after.plot.building.primary_color !== primaryColor ||
      after.plot.building.name !== cleanName ||
      after.plot.building.approved_manifest_hash !== null
    )
      throw new Error("Building choice is awaiting chain confirmation");
  }

  async changeBuildingType(
    plotId: string,
    buildingType: string,
    variant: number,
  ): Promise<void> {
    const accountId = this.requiredAccount();
    const before = await this.ownerPlot(plotId, accountId);
    const type = BuildingType.parse(buildingType);
    if (before.plot.building.building_type === type)
      throw new Error("This plot already has that building type");
    if (variant !== 1 && variant !== 2) throw new Error("Choose shape 1 or 2");
    await this.ownerCall(
      "change_building_type",
      { plot_id: plotId, building_type: type, variant },
      accountId,
    );
    const after = await this.ownerPlot(plotId, accountId);
    if (
      after.plot.building.building_type !== type ||
      after.plot.building.variant !== variant ||
      after.plot.building.level !== before.plot.building.level
    )
      throw new Error("Building type change is awaiting chain confirmation");
  }

  async upgradeBuilding(plotId: string): Promise<void> {
    const accountId = this.requiredAccount();
    const before = await this.ownerPlot(plotId, accountId);
    if (before.plot.building.level >= 4)
      throw new Error("Building is already level 4");
    await this.ownerCall("upgrade_building", { plot_id: plotId }, accountId);
    const after = await this.ownerPlot(plotId, accountId);
    if (after.plot.building.level !== before.plot.building.level + 1)
      throw new Error("Building upgrade is awaiting chain confirmation");
  }

  async upgradeCar(carId: number): Promise<void> {
    const accountId = this.requiredAccount();
    const before = await this.reader.player(accountId);
    const car = before.cars.find((entry) => entry.id === carId);
    if (!car) throw new Error("Car is not owned by this account");
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: this.reader.contractId,
      actions: [
        actionCreators.functionCall(
          "upgrade_car",
          { car_id: carId },
          CALL_GAS,
          0n,
        ),
      ],
    });
    if (this.accountId !== accountId) throw new Error("Wallet account changed");
    const after = await this.reader.player(accountId);
    if (after.cars.find((entry) => entry.id === carId)?.tier !== car.tier + 1)
      throw new Error("Car upgrade is awaiting chain confirmation");
  }

  private async keyState(
    record: KeyRecord,
  ): Promise<"ready" | "inactive" | "absent"> {
    const listed = await this.reader.accessKeyList(record.accountId);
    const access = listed.keys.find(
      (key) => key.public_key === record.publicKey,
    )?.access_key;
    if (!access) return "absent";
    if (access.permission === "FullAccess" || access.permission === null)
      return "inactive";
    const permission = access.permission.FunctionCall;
    return permission.receiver_id === this.reader.contractId &&
      GAMEPLAY_METHODS.every((method) =>
        permission.method_names.includes(method),
      ) &&
      permission.method_names.length === GAMEPLAY_METHODS.length &&
      BigInt(permission.allowance ?? 0) > 0n &&
      BigInt(permission.allowance ?? 0) <= GAMEPLAY_KEY_ALLOWANCE
      ? "ready"
      : "inactive";
  }

  async resumePendingKey(): Promise<GameplayKeyStatus> {
    const accountId = this.accountId;
    if (!accountId) return "none";
    const pending = pendingRecord(
      localStorage.getItem(this.pendingName(accountId)),
    );
    if (!pending || pending.accountId !== accountId) {
      const stored = this.storedKey(accountId);
      if (!stored) return "none";
      try {
        const state = await this.keyState(stored);
        if (state === "absent") {
          localStorage.removeItem(this.keyName(accountId));
          return "none";
        }
        return state;
      } catch {
        return "pending";
      }
    }
    let state: "ready" | "inactive" | "absent";
    try {
      state = await this.keyState(pending);
    } catch {
      return "pending";
    }
    if (pending.operation === "add" && state === "ready") {
      localStorage.setItem(this.keyName(accountId), JSON.stringify(pending));
      localStorage.removeItem(this.pendingName(accountId));
      return "ready";
    }
    if (pending.operation === "add" && state === "inactive") {
      // Keep the secret so the mismatched on-chain key can be revoked safely.
      localStorage.setItem(this.keyName(accountId), JSON.stringify(pending));
      localStorage.removeItem(this.pendingName(accountId));
      return "inactive";
    }
    if (pending.operation === "revoke" && state === "absent") {
      localStorage.removeItem(this.keyName(accountId));
      localStorage.removeItem(this.pendingName(accountId));
      return "none";
    }
    return "pending";
  }

  async addGameplayKey(): Promise<"ready" | "pending"> {
    const accountId = this.requiredAccount();
    const existing = await this.resumePendingKey();
    if (existing === "ready") return "ready";
    if (existing === "inactive")
      throw new Error("Revoke the inactive gameplay key before renewing it");
    if (existing === "pending")
      throw new Error("A gameplay key action is still pending");
    const pair = KeyPair.fromRandom("ed25519");
    const record: PendingKey = {
      accountId,
      publicKey: pair.getPublicKey().toString(),
      secretKey: pair.toString(),
      operation: "add",
    };
    localStorage.setItem(this.pendingName(accountId), JSON.stringify(record));
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: accountId,
      actions: [
        actionCreators.addKey(
          pair.getPublicKey(),
          actionCreators.functionCallAccessKey(
            this.reader.contractId,
            [...GAMEPLAY_METHODS],
            GAMEPLAY_KEY_ALLOWANCE,
          ),
        ),
      ],
    });
    if (this.accountId !== accountId)
      throw new Error("Wallet account changed while adding the gameplay key");
    return (await this.resumePendingKey()) === "ready" ? "ready" : "pending";
  }

  async revokeGameplayKey(): Promise<"revoked" | "pending"> {
    const accountId = this.requiredAccount();
    if (localStorage.getItem(this.actionName(accountId)))
      throw new Error(
        "Check the pending gameplay action before removing its key",
      );
    const record = this.storedKey(accountId);
    if (!record) throw new Error("No local gameplay key for this account");
    if ((await this.keyState(record)) === "absent") {
      localStorage.removeItem(this.keyName(accountId));
      return "revoked";
    }
    localStorage.setItem(
      this.pendingName(accountId),
      JSON.stringify({ ...record, operation: "revoke" } satisfies PendingKey),
    );
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: accountId,
      actions: [actionCreators.deleteKey(pairPublicKey(record))],
    });
    if (this.accountId !== accountId)
      throw new Error("Wallet account changed while revoking the gameplay key");
    return (await this.resumePendingKey()) === "none" ? "revoked" : "pending";
  }

  async retryPendingKey(): Promise<GameplayKeyStatus> {
    const accountId = this.requiredAccount();
    const pending = pendingRecord(
      localStorage.getItem(this.pendingName(accountId)),
    );
    if (!pending || pending.accountId !== accountId)
      return this.resumePendingKey();
    const state = await this.keyState(pending);
    if (pending.operation === "add" && state !== "absent")
      return this.resumePendingKey();
    if (pending.operation === "revoke" && state === "absent")
      return this.resumePendingKey();
    const wallet = await this.selector.wallet();
    await wallet.signAndSendTransaction({
      signerId: accountId,
      receiverId: accountId,
      actions: [
        pending.operation === "add"
          ? actionCreators.addKey(
              pairPublicKey(pending),
              actionCreators.functionCallAccessKey(
                this.reader.contractId,
                [...GAMEPLAY_METHODS],
                GAMEPLAY_KEY_ALLOWANCE,
              ),
            )
          : actionCreators.deleteKey(pairPublicKey(pending)),
      ],
    });
    if (this.accountId !== accountId) throw new Error("Wallet account changed");
    return this.resumePendingKey();
  }

  private async expiredGameplayAction(
    record: PendingGameplayAction,
  ): Promise<boolean> {
    if (record.version === 1) return false;
    const [key, validityPeriod] = await Promise.all([
      this.reader.accessKey(record.accountId, record.publicKey),
      this.reader.transactionValidityPeriod(),
    ]);
    return (
      key.nonce < BigInt(record.nonce) &&
      BigInt(key.blockHeight) >
        BigInt(record.signedAtBlockHeight) +
          BigInt(validityPeriod) +
          FINAL_BLOCK_SAFETY_MARGIN
    );
  }

  private async settleGameplayAction(
    record: PendingGameplayAction,
    checkFirst: boolean,
  ): Promise<"success" | "failure" | "pending" | "expired"> {
    if (checkFirst) {
      try {
        const state = await this.reader.transactionStatus(
          record.hash,
          record.accountId,
        );
        if (state === "success" || state === "failure" || state === "pending")
          return state;
        if (await this.expiredGameplayAction(record).catch(() => false))
          return "expired";
      } catch {
        // Re-broadcasting the identical signed bytes cannot execute twice.
      }
    }
    try {
      const state = await this.reader.sendSignedTransaction(
        record.signedTxBase64,
      );
      if (state === "success" || state === "failure") return state;
    } catch {
      // A failed or timed-out response can still have reached the chain.
    }
    try {
      const state = await this.reader.transactionStatus(
        record.hash,
        record.accountId,
      );
      return state === "unknown" ? "pending" : state;
    } catch {
      return "pending";
    }
  }

  async checkPendingGameplayAction(): Promise<
    "success" | "failure" | "pending" | "expired" | "none"
  > {
    this.lastGameplayFailureReason = null;
    const accountId = this.requiredAccount();
    const name = this.actionName(accountId);
    const raw = localStorage.getItem(name);
    if (!raw) return "none";
    const action = pendingGameplayAction(raw);
    const key = this.storedKey(accountId);
    if (
      !key ||
      action.accountId !== accountId ||
      action.publicKey !== key.publicKey
    )
      throw new Error("A pending gameplay action belongs to another key");
    const state = await this.settleGameplayAction(action, true);
    if (state !== "pending") localStorage.removeItem(name);
    if (state === "failure") {
      try {
        this.lastGameplayFailureReason =
          await this.reader.transactionFailureMessage(
            action.hash,
            action.accountId,
          );
      } catch {
        // Final failure remains known when the explanation read fails.
      }
    }
    if (this.accountId !== accountId) throw new Error("Wallet account changed");
    return state;
  }

  async gameplayCall(method: GameplayMethod, args: object): Promise<void> {
    if (!GAMEPLAY_METHODS.includes(method))
      throw new Error("Method is not allowed by the gameplay key");
    const accountId = this.requiredAccount();
    const record = this.storedKey(accountId);
    if (!record) throw new Error("Enable the gameplay key first");
    const run = async () => {
      if (this.accountId !== accountId)
        throw new Error("Wallet account changed");
      if (this.storedKey(accountId)?.publicKey !== record.publicKey)
        throw new Error("Gameplay key changed before signing");
      const actionName = this.actionName(accountId);
      const argsJson = JSON.stringify(args);
      const prior = localStorage.getItem(actionName);
      let action: PendingGameplayAction;
      let checkFirst = false;
      if (prior) {
        action = pendingGameplayAction(prior);
        if (
          action.accountId !== accountId ||
          action.publicKey !== record.publicKey
        )
          throw new Error("A pending gameplay action belongs to another key");
        checkFirst = true;
      } else {
        const keyPair = KeyPair.fromString(
          record.secretKey as `ed25519:${string}`,
        );
        const accessKey = await this.reader.accessKey(
          accountId,
          keyPair.getPublicKey().toString(),
        );
        if (this.accountId !== accountId)
          throw new Error("Wallet account changed");
        const transaction = createTransaction(
          accountId,
          keyPair.getPublicKey(),
          this.reader.contractId,
          accessKey.nonce + 1n,
          [actionCreators.functionCall(method, args, CALL_GAS, 0n)],
          baseDecode(accessKey.blockHash),
        );
        const signer = KeyPairSigner.fromSecretKey(
          record.secretKey as `ed25519:${string}`,
        );
        const [hash, signedTransaction] =
          await signer.signTransaction(transaction);
        const bytes = encodeTransaction(signedTransaction);
        action = {
          version: 2,
          accountId,
          publicKey: record.publicKey,
          method,
          argsJson,
          hash: baseEncode(hash),
          signedTxBase64: btoa(String.fromCharCode(...bytes)),
          signedAtBlockHeight: accessKey.blockHeight,
          nonce: (accessKey.nonce + 1n).toString(),
        };
        if (this.accountId !== accountId)
          throw new Error("Wallet account changed");
        localStorage.setItem(actionName, JSON.stringify(action));
      }
      const outcome = await this.settleGameplayAction(action, checkFirst);
      if (outcome === "pending")
        throw new Error(
          "Gameplay action is pending. Retry to check the same transaction before signing another.",
        );
      localStorage.removeItem(actionName);
      if (outcome === "expired")
        throw new Error(
          "The previous gameplay action expired without landing. Review the updated game state, then retry.",
        );
      if (outcome === "failure") {
        let reason: string | null = null;
        try {
          reason = await this.reader.transactionFailureMessage(
            action.hash,
            action.accountId,
          );
        } catch {
          // The final failure is known even if its explanation is unavailable.
        }
        throw new Error(
          reason ?? `The previous ${action.method} transaction failed on-chain`,
        );
      }
      if (this.accountId !== accountId)
        throw new Error("Wallet account changed");
      if (
        checkFirst &&
        (action.method !== method || action.argsJson !== argsJson)
      )
        throw new Error(
          "The previous gameplay action confirmed. Review the updated game state, then retry.",
        );
    };
    const serialized = () => {
      const next = this.lastCall.then(run, run);
      this.lastCall = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };
    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request(this.keyName(accountId), serialized);
    } else {
      await serialized();
    }
  }
}

function pairPublicKey(record: KeyRecord) {
  return KeyPair.fromString(
    record.secretKey as `ed25519:${string}`,
  ).getPublicKey();
}
