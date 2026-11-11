import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifySignature } from "@near-wallet-selector/core";
import {
  canonicalJson,
  CURATED_PALETTES,
  ChainAppearanceReference,
  ChainMediaProposal,
  DEFAULT_CONFIG,
  ImpressionBatch,
  IMPRESSION_RULES,
  MaterialHint,
  ThemeHint,
  validateCitySeed,
  validateAssetManifest,
} from "@estate/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import sharp from "sharp";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChainGateway } from "./chain.js";
import { saveImmutablePng } from "./asset-storage.js";
import { renderMockCandidate } from "./mock-art.js";
import { buildGenerationPrompt } from "./prompt-builder.js";
import {
  PaidGenerationLedger,
  PaidJobLimitError,
  type PaidJob,
} from "./paid-generation-ledger.js";
import type { ModeratorGateway } from "./moderator.js";
import { mediaReviewPreview } from "./moderation-preview.js";
import { ImpressionError, ImpressionLedger } from "./impression-ledger.js";
import { readPlotStats } from "./plot-stats.js";
import { readEconomyStats } from "./economy-stats.js";
import {
  ApiStore,
  type GenerationJob,
  type MediaProposalRecord,
  type MockCandidate,
} from "./store.js";

const cityPath = fileURLToPath(
  new URL("../../../contracts/estate/seed.json", import.meta.url),
);
const city = validateCitySeed(JSON.parse(readFileSync(cityPath, "utf8")));
const ACCOUNT_ID = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*\.testnet$/);
const PLOT_ID = z
  .string()
  .regex(/^plot-(main|market|river|central|harbor)-(n|s)-[0-7]$/);
const HASH = z.string().regex(/^[0-9a-f]{64}$/);
const MAX_ONCHAIN_MODERATION_REASON_BYTES = 240;
const validOnChainReason = (reason: string): boolean =>
  reason.length > 0 &&
  Buffer.byteLength(reason, "utf8") <= MAX_ONCHAIN_MODERATION_REASON_BYTES;
const CHALLENGE_ID = z.string().uuid();
const ChallengeRequest = z.object({ accountId: ACCOUNT_ID });
const VerifyRequest = z.object({
  challengeId: CHALLENGE_ID,
  signedMessage: z.object({
    accountId: ACCOUNT_ID,
    publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,60}$/),
    signature: z.string().regex(/^[A-Za-z0-9+/]{85,90}={0,2}$/),
    state: z.string().optional(),
  }),
});
const GenerationRequest = z.object({
  plotId: PLOT_ID,
  description: z.string().trim().min(1).max(800),
  palette: z.enum(CURATED_PALETTES),
  themeHint: ThemeHint.default("None"),
  materialHints: z.array(MaterialHint).max(2).default([]),
  usePriorArt: z.boolean().default(true),
});
const GenerationSelection = z.object({
  candidateId: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});
const MediaProposalRequest = z.object({
  uploadId: CHALLENGE_ID,
  link: z.string().nullable(),
});
const MediaKind = z.enum(["Logo", "Billboard"]);

const CHALLENGE_TTL = 5 * 60;
const CHALLENGE_WINDOW_SECONDS = 5 * 60;
const MAX_CHALLENGES_PER_WINDOW = 300;
const IMPRESSION_SESSION_WINDOW_SECONDS = 5 * 60;
const MAX_IMPRESSION_SESSIONS_PER_WINDOW = 600;
const SESSION_TTL = 12 * 60 * 60;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_INPUT_PIXELS = 4_000_000;
const UPLOAD_WINDOW_SECONDS = 24 * 60 * 60;
const MAX_UPLOADS_PER_PLOT = 12;
const MAX_UPLOADS_PER_ACCOUNT = 48;
const MAX_MEDIA_PROPOSALS_PER_UPLOAD = 12;
const MAX_MEDIA_PROPOSALS_PER_ACCOUNT = 48;
const MAX_UNRESOLVED_MEDIA_PROPOSALS_PER_SLOT = 3;

export type ApiOptions = {
  store: ApiStore;
  chain: ChainGateway | null;
  appOrigin: string;
  clock?: () => number;
  moderator?: ModeratorGateway | null;
  adminCredentials?: { user: string; password: string } | null;
  paidLedger?: PaidGenerationLedger | null;
};

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function checkedFacadeCandidate(
  store: ApiStore,
  job: GenerationJob,
  candidate: MockCandidate,
): Promise<Buffer> {
  const manifest = validateAssetManifest(candidate.manifest);
  if (
    manifest.buildingType !== job.buildingType ||
    manifest.level !== job.level ||
    manifest.spriteHash !== candidate.spriteHash ||
    manifest.thumbnailHash !== candidate.thumbnailHash ||
    hash(canonicalJson(manifest)) !== candidate.manifestHash
  )
    throw new Error("Selected facade manifest does not match the job");
  const [sprite, thumbnail] = await Promise.all([
    readFile(join(store.assetDir, `${candidate.spriteHash}.png`)),
    readFile(join(store.assetDir, `${candidate.thumbnailHash}.png`)),
  ]);
  if (
    hash(sprite) !== candidate.spriteHash ||
    hash(thumbnail) !== candidate.thumbnailHash
  )
    throw new Error("Selected facade image hash does not match");
  return thumbnail;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function exactReference(job: GenerationJob): ChainAppearanceReference | null {
  const candidate = job.candidates.find(
    (entry) => entry.id === job.selectedCandidateId,
  );
  if (!candidate || job.proposalRevision === null) return null;
  return ChainAppearanceReference.parse({
    revision: job.proposalRevision,
    owner: job.accountId,
    building_type: job.buildingType,
    level: job.level,
    manifest_hash: candidate.manifestHash,
  });
}

function sameReference(
  left: ChainAppearanceReference | null,
  right: ChainAppearanceReference,
): boolean {
  return Boolean(
    left &&
      left.revision === right.revision &&
      left.owner === right.owner &&
      left.building_type === right.building_type &&
      left.level === right.level &&
      left.manifest_hash === right.manifest_hash,
  );
}

function validMediaLink(link: string | null): boolean {
  if (link === null) return true;
  if (
    Buffer.byteLength(link, "utf8") > 256 ||
    !link.startsWith("https://") ||
    [...link].some(
      (character) =>
        character.charCodeAt(0) < 33 ||
        character.charCodeAt(0) > 126 ||
        /[@\\"'<>]/.test(character),
    )
  )
    return false;
  const authority = link.slice(8).split(/[/?#]/, 1)[0] ?? "";
  return (
    authority.includes(".") &&
    authority.length <= 253 &&
    authority
      .split(".")
      .every((label) =>
        /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])$/.test(
          label,
        ),
      )
  );
}

function exactMediaProposal(
  record: MediaProposalRecord,
): ChainMediaProposal | null {
  if (record.proposalRevision === null) return null;
  return ChainMediaProposal.parse({
    revision: record.proposalRevision,
    owner: record.accountId,
    building_type: record.buildingType,
    level: record.level,
    layout_revision: record.layoutRevision,
    content: { asset_hash: record.assetHash, link: record.link },
  });
}

function sameMediaProposal(
  left: ChainMediaProposal | null,
  right: ChainMediaProposal,
): boolean {
  return Boolean(
    left &&
      left.revision === right.revision &&
      left.owner === right.owner &&
      left.building_type === right.building_type &&
      left.level === right.level &&
      left.layout_revision === right.layout_revision &&
      left.content.asset_hash === right.content.asset_hash &&
      left.content.link === right.content.link,
  );
}

function mediaResponse(record: MediaProposalRecord, store: ApiStore) {
  return {
    ...record,
    assetUrl: store.upload(record.uploadId)
      ? `/api/assets/${record.assetHash}`
      : null,
  };
}

function jobResponse(job: GenerationJob) {
  return {
    ...job,
    candidates: job.candidates.map((candidate) => ({
      ...candidate,
      spriteUrl: `/api/assets/${candidate.spriteHash}`,
      thumbnailUrl: `/api/assets/${candidate.thumbnailHash}`,
    })),
  };
}

function promotePaidJob(
  store: ApiStore,
  ledger: PaidGenerationLedger,
  job: PaidJob,
): GenerationJob | null {
  if (job.status !== "complete") return null;
  const existing = store.generation(job.id);
  if (existing) {
    if (existing.mode !== "paid" || existing.accountId !== job.accountId)
      throw new Error("Paid design ID conflicts with another job");
    return existing;
  }
  const snapshot = job.snapshot;
  const paidCandidates = ledger.candidates(job.id);
  if (
    !snapshot ||
    paidCandidates.length < 1 ||
    paidCandidates.length > 3 ||
    paidCandidates.some((candidate) => candidate.reviewStatus === "pending")
  )
    return null;
  const candidates: MockCandidate[] = paidCandidates
    .filter((candidate) => candidate.reviewStatus === "approved")
    .map((candidate) => ({
      id: candidate.ordinal as MockCandidate["id"],
      variant: snapshot.promptSpec.variant,
      palette: snapshot.promptSpec.palette,
      manifest: candidate.manifest,
      manifestHash: candidate.manifestHash,
      spriteHash: candidate.spriteHash,
      thumbnailHash: candidate.thumbnailHash,
    }));
  if (candidates.length === 0) return null;
  try {
    return store.createGeneration({
      id: job.id,
      mode: "paid",
      accountId: job.accountId,
      plotId: job.plotId,
      buildingType: snapshot.buildingType,
      level: snapshot.level,
      layoutRevision: snapshot.layoutRevision,
      appearanceRevision: snapshot.appearanceRevision,
      description: snapshot.promptSpec.description,
      promptSpec: snapshot.promptSpec,
      candidates,
      createdAt: job.createdAt,
      readyAt: Math.max(
        job.createdAt,
        ...paidCandidates.map(
          (candidate) => candidate.reviewedAt ?? candidate.createdAt,
        ),
      ),
    });
  } catch (error) {
    const concurrent = store.generation(job.id);
    if (concurrent?.mode === "paid" && concurrent.accountId === job.accountId)
      return concurrent;
    throw error;
  }
}

function paidJobResponse(
  store: ApiStore,
  ledger: PaidGenerationLedger,
  job: PaidJob,
) {
  const allCandidates = ledger.candidates(job.id);
  const approvedCandidates = allCandidates.filter(
    (candidate) => candidate.reviewStatus === "approved",
  );
  const reviewPending = allCandidates.some(
    (candidate) => candidate.reviewStatus === "pending",
  );
  const designJob = promotePaidJob(store, ledger, job);
  return {
    id: job.id,
    mode: "paid" as const,
    plotId: job.plotId,
    status:
      designJob?.status === "expired"
        ? ("expired" as const)
        : job.status === "complete"
          ? reviewPending
            ? ("awaiting_review" as const)
            : approvedCandidates.length === 0
              ? ("review_rejected" as const)
              : approvedCandidates.length < 3
                ? ("partial" as const)
                : ("complete" as const)
          : job.status,
    acceptedCount: job.acceptedCount,
    reviewedCount:
      allCandidates.length -
      allCandidates.filter((candidate) => candidate.reviewStatus === "pending")
        .length,
    approvedCount: approvedCandidates.length,
    attemptsStarted: job.attemptsStarted,
    cancellationPending: job.stopReason !== null,
    createdAt: job.createdAt,
    designJobId: designJob?.id ?? null,
    candidates: approvedCandidates
      .filter((candidate) =>
        designJob
          ? designJob.candidates.some(
              (entry) => entry.manifestHash === candidate.manifestHash,
            )
          : true,
      )
      .map((candidate) => ({
        id: candidate.ordinal,
        manifest: candidate.manifest,
        manifestHash: candidate.manifestHash,
        spriteHash: candidate.spriteHash,
        thumbnailHash: candidate.thumbnailHash,
        spriteUrl: `/api/assets/${candidate.spriteHash}`,
        thumbnailUrl: `/api/assets/${candidate.thumbnailHash}`,
      })),
  };
}

function cookieValue(header: string | undefined, name: string): string | null {
  const part = header
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : null;
}

function sessionCookie(token: string, secure: boolean, maxAge: number): string {
  return `estate_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function replyError(
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
) {
  return Response.json({ code, message }, { status });
}

async function normalizedImage(
  file: File,
  kind: "Logo" | "Billboard",
): Promise<Buffer> {
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES)
    throw new Error("Image must be between 1 byte and 1 MB");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Use a PNG, JPEG or WebP image");
  const input = Buffer.from(await file.arrayBuffer());
  const metadata = await sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "error",
  }).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > 4096 ||
    metadata.height > 4096 ||
    metadata.width * metadata.height > MAX_INPUT_PIXELS ||
    (metadata.pages ?? 1) !== 1 ||
    !["png", "jpeg", "webp"].includes(metadata.format ?? "")
  )
    throw new Error("Image dimensions or format are not supported");
  const width = kind === "Logo" ? 256 : 512;
  const height = kind === "Logo" ? 256 : 256;
  const output = await sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "error",
  })
    .rotate()
    .resize(width, height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .toColourspace("srgb")
    .png({ compressionLevel: 9 })
    .toBuffer();
  if (output.length > MAX_IMAGE_BYTES)
    throw new Error("Processed image is too large");
  return output;
}

export function createApiApp({
  store,
  chain,
  appOrigin,
  clock = () => Math.floor(Date.now() / 1000),
  moderator = null,
  adminCredentials = null,
  paidLedger = null,
}: ApiOptions): Hono {
  const origin = new URL(appOrigin).origin;
  const recipient = new URL(appOrigin).host;
  const callbackUrl = `${origin}/`;
  const secure = origin.startsWith("https://");
  const app = new Hono();
  const impressionLedger = new ImpressionLedger(store.db);

  const currentAccount = (header: string | undefined): string | null => {
    const token = cookieValue(header, "estate_session");
    return token && /^[A-Za-z0-9_-]{43}$/.test(token)
      ? store.sessionAccount(hash(token), clock())
      : null;
  };

  const moderatorAuthorized = (header: string | undefined): boolean => {
    if (!moderator || !adminCredentials?.user || !adminCredentials.password)
      return false;
    if (!header?.startsWith("Basic ")) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    } catch {
      return false;
    }
    const separator = decoded.indexOf(":");
    if (separator < 1) return false;
    const actual = hash(decoded);
    const expected = hash(
      `${adminCredentials.user}:${adminCredentials.password}`,
    );
    return timingSafeEqual(
      Buffer.from(actual, "hex"),
      Buffer.from(expected, "hex"),
    );
  };

  const requireModerator = (c: Context): Response | null => {
    if (!moderator || !adminCredentials?.user || !adminCredentials.password)
      return c.json(
        {
          code: "MODERATION_UNAVAILABLE",
          message: "Moderation is not configured",
        },
        503,
      );
    if (moderatorAuthorized(c.req.header("authorization"))) return null;
    c.header("WWW-Authenticate", 'Basic realm="near.estate moderation"');
    return c.json(
      { code: "UNAUTHENTICATED", message: "Moderator sign-in required" },
      401,
    );
  };

  const reconcileDecision = async (
    job: GenerationJob,
  ): Promise<GenerationJob> => {
    if (!chain || job.status !== "submitted") return job;
    const expected = exactReference(job);
    if (!expected) return job;
    const plot = await chain.plot(job.plotId);
    const decision = plot?.plot.building.last_appearance_decision;
    if (!decision || !sameReference(decision.reference, expected)) return job;
    if (
      decision.status === "Approved" &&
      plot?.plot.building.approved_manifest_hash === expected.manifest_hash
    )
      return store.markGenerationDecided(
        job.id,
        "approved",
        decision.decided_at,
        null,
      );
    if (decision.status === "Rejected")
      return store.markGenerationDecided(
        job.id,
        "rejected",
        decision.decided_at,
        decision.reason,
      );
    return job;
  };

  const reconcileRevocation = async (
    job: GenerationJob,
  ): Promise<GenerationJob> => {
    if (!chain || job.status !== "approved") return job;
    const candidate = job.candidates.find(
      (entry) => entry.id === job.selectedCandidateId,
    );
    if (!candidate) return job;
    const plot = await chain.plot(job.plotId);
    const decision = plot?.plot.building.last_appearance_decision;
    if (
      !plot ||
      plot.plot.building.approved_manifest_hash !== null ||
      decision?.status !== "Revoked" ||
      decision.reference.manifest_hash !== candidate.manifestHash ||
      decision.reference.owner !== job.accountId ||
      decision.reference.revision !== plot.plot.building.appearance_revision
    )
      return job;
    return store.markGenerationRevoked(
      job.id,
      decision.decided_at,
      decision.reason ?? "Artwork withdrawn",
    );
  };

  const reconcileMediaDecision = async (
    record: MediaProposalRecord,
  ): Promise<MediaProposalRecord> => {
    if (!chain || record.status !== "submitted") return record;
    const expected = exactMediaProposal(record);
    if (!expected) return record;
    const plot = await chain.plot(record.plotId);
    const slot =
      record.kind === "Logo" ? plot?.plot.logo : plot?.plot.billboard;
    const decision = slot?.last_decision;
    const active = slot?.active;
    if (!decision || !sameMediaProposal(decision.proposal, expected))
      return record;
    if (
      decision.status === "Approved" &&
      active?.content.asset_hash === expected.content.asset_hash &&
      active.content.link === expected.content.link &&
      active.approved_layout_revision === expected.layout_revision
    )
      return store.markMediaDecided(
        record.id,
        "approved",
        decision.decided_at,
        null,
      );
    if (decision.status === "Rejected")
      return store.markMediaDecided(
        record.id,
        "rejected",
        decision.decided_at,
        decision.reason,
      );
    return record;
  };

  const reconcileMediaRevocation = async (
    record: MediaProposalRecord,
  ): Promise<MediaProposalRecord> => {
    if (!chain || record.status !== "approved") return record;
    const plot = await chain.plot(record.plotId);
    const slot =
      record.kind === "Logo" ? plot?.plot.logo : plot?.plot.billboard;
    const decision = slot?.last_decision;
    if (
      !slot ||
      slot.active !== null ||
      decision?.status !== "Revoked" ||
      decision.proposal.content.asset_hash !== record.assetHash ||
      decision.proposal.content.link !== record.link ||
      decision.proposal.owner !== record.accountId ||
      decision.proposal.revision !== slot.revision
    )
      return record;
    return store.markMediaRevoked(
      record.id,
      decision.decided_at,
      decision.reason ?? "Media withdrawn",
    );
  };

  app.use("*", async (c, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      if (c.req.header("origin") !== origin)
        return c.json(
          { code: "BAD_ORIGIN", message: "Request origin is not allowed" },
          403,
        );
    }
    await next();
  });

  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path === "/paid-generations/status") return next();
    const protectedPath =
      path === "/auth/me" ||
      path === "/logos" ||
      path === "/ads" ||
      path === "/generations" ||
      path.startsWith("/generations/") ||
      path === "/paid-generations" ||
      path.startsWith("/paid-generations/") ||
      path === "/media" ||
      path.startsWith("/media/") ||
      path.startsWith("/assets/");
    if (!protectedPath) return next();
    const publicAssetHash = path.startsWith("/assets/")
      ? HASH.safeParse(path.slice("/assets/".length))
      : null;
    if (publicAssetHash?.success && store.isPublicAsset(publicAssetHash.data))
      return next();
    const token = cookieValue(c.req.header("cookie"), "estate_session");
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return next();
    const tokenHash = hash(token);
    const identity = store.sessionIdentity(tokenHash, clock());
    if (!identity) return next();
    if (!chain)
      return c.json(
        {
          code: "CHAIN_UNAVAILABLE",
          message: "Could not verify the wallet key",
        },
        503,
      );
    let active: boolean;
    try {
      active = await chain.hasAccessKey(identity.accountId, identity.publicKey);
    } catch {
      return c.json(
        {
          code: "CHAIN_UNAVAILABLE",
          message: "Could not verify the wallet key",
        },
        503,
      );
    }
    if (!active) {
      store.deleteSession(tokenHash);
      c.header("Set-Cookie", sessionCookie("", secure, 0));
      return c.json(
        {
          code: "KEY_REVOKED",
          message: "Wallet key was revoked; sign in again",
        },
        401,
      );
    }
    await next();
  });

  app.get("/health", (c) =>
    c.json({ status: "ok", service: "api", schemaVersion: 1 }),
  );
  app.get("/config", (c) => c.json(DEFAULT_CONFIG));
  app.get("/city", (c) => c.json(city));

  app.get("/stats/economy", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(readEconomyStats(store.db, clock()));
  });

  app.get("/stats/plots/:id", (c) => {
    const plotId = PLOT_ID.safeParse(c.req.param("id"));
    if (!plotId.success || !city.plots.some((plot) => plot.id === plotId.data))
      return c.json({ code: "INVALID_PLOT", message: "Unknown plot" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(readPlotStats(store.db, plotId.data, clock()));
  });

  app.post("/impressions/session", (c) => {
    const now = clock();
    const prior = cookieValue(c.req.header("cookie"), "estate_impression");
    const priorExpiry =
      prior && /^[A-Za-z0-9_-]{43}$/.test(prior)
        ? impressionLedger.sessionExpiry(hash(prior), now)
        : null;
    let token: string;
    let expiresAt: number;
    if (prior && priorExpiry) {
      token = prior;
      expiresAt = priorExpiry;
    } else {
      impressionLedger.pruneExpiredSessions(now);
      if (
        impressionLedger.recentSessionTotal(
          now - IMPRESSION_SESSION_WINDOW_SECONDS,
        ) >= MAX_IMPRESSION_SESSIONS_PER_WINDOW
      )
        return c.json(
          { code: "RATE_LIMITED", message: "Try again in a few minutes" },
          429,
        );
      token = randomBytes(32).toString("base64url");
      expiresAt = impressionLedger.issueSession(hash(token), now);
    }
    c.header(
      "Set-Cookie",
      `estate_impression=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${IMPRESSION_RULES.sessionTtlSeconds}${secure ? "; Secure" : ""}`,
    );
    c.header("Cache-Control", "no-store");
    return c.json({ expiresAt });
  });

  app.post(
    "/impressions",
    bodyLimit({
      maxSize: 16_384,
      onError: () => replyError("TOO_LARGE", "Batch is too large", 413),
    }),
    async (c) => {
      const token = cookieValue(c.req.header("cookie"), "estate_impression");
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
        return c.json(
          { code: "SESSION_REQUIRED", message: "Start an impression session" },
          401,
        );
      const tokenHash = hash(token);
      if (!impressionLedger.sessionExpiry(tokenHash, clock()))
        return c.json(
          {
            code: "SESSION_EXPIRED",
            message: "Start a new impression session",
          },
          401,
        );
      const parsed = ImpressionBatch.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        return c.json(
          { code: "INVALID_BATCH", message: "Invalid impression batch" },
          400,
        );
      try {
        const newSurfaces = impressionLedger.newPlotSurfaces(
          tokenHash,
          parsed.data.events,
          clock(),
        );
        if (newSurfaces.length) {
          if (!chain)
            return c.json(
              {
                code: "CHAIN_UNAVAILABLE",
                message: "Live city is unavailable",
              },
              503,
            );
          for (const { plotId, surface } of newSurfaces) {
            if (!PLOT_ID.safeParse(plotId).success)
              return c.json(
                { code: "INVALID_PLOT", message: "Unknown plot" },
                400,
              );
            const plot = await chain.plot(plotId);
            if (
              !(surface === "Logo"
                ? plot?.logo_eligible
                : plot?.billboard_eligible)
            )
              return c.json(
                {
                  code: "NO_APPROVED_AD",
                  message: "Plot has no approved ad surface",
                  plotId,
                  surface,
                },
                403,
              );
          }
        }
        return c.json(
          impressionLedger.recordBatch(tokenHash, parsed.data.events, clock()),
        );
      } catch (error) {
        if (error instanceof ImpressionError) {
          const status =
            error.code === "SESSION_EXPIRED"
              ? 401
              : error.code === "RATE_LIMITED"
                ? 429
                : error.code === "CONFLICT"
                  ? 409
                  : 400;
          return c.json({ code: error.code, message: error.message }, status);
        }
        console.error("Impression batch failed", error);
        return c.json(
          { code: "IMPRESSION_UNAVAILABLE", message: "Try again later" },
          503,
        );
      }
    },
  );

  app.post(
    "/auth/challenge",
    bodyLimit({
      maxSize: 2048,
      onError: () => replyError("TOO_LARGE", "Request is too large", 413),
    }),
    async (c) => {
      const parsed = ChallengeRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        return c.json(
          { code: "INVALID_ACCOUNT", message: "Enter a testnet account" },
          400,
        );
      const accountId = parsed.data.accountId;
      const now = clock();
      store.pruneExpiredAuth(now);
      if (
        store.recentChallenges(accountId, now - CHALLENGE_WINDOW_SECONDS) >=
          5 ||
        store.recentChallengeTotal(now - CHALLENGE_WINDOW_SECONDS) >=
          MAX_CHALLENGES_PER_WINDOW
      )
        return c.json(
          { code: "RATE_LIMITED", message: "Try again in a few minutes" },
          429,
        );
      const challenge = {
        id: randomUUID(),
        account_id: accountId,
        nonce: randomBytes(32).toString("base64"),
        message:
          "Sign in to near.estate testnet to manage your building artwork. This does not move coins or NEAR.",
        recipient,
        callback_url: callbackUrl,
        expires_at: now + CHALLENGE_TTL,
      };
      store.createChallenge(challenge, now);
      c.header("Cache-Control", "no-store");
      return c.json({
        challengeId: challenge.id,
        accountId,
        message: challenge.message,
        nonce: challenge.nonce,
        recipient,
        callbackUrl,
        expiresAt: challenge.expires_at,
      });
    },
  );

  app.post(
    "/auth/verify",
    bodyLimit({
      maxSize: 4096,
      onError: () => replyError("TOO_LARGE", "Request is too large", 413),
    }),
    async (c) => {
      if (!chain)
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Testnet contract is not configured",
          },
          503,
        );
      const parsed = VerifyRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        return c.json(
          {
            code: "INVALID_SIGNATURE",
            message: "Invalid wallet signature response",
          },
          400,
        );
      const { challengeId, signedMessage } = parsed.data;
      const challenge = store.challenge(challengeId);
      if (
        !challenge ||
        challenge.account_id !== signedMessage.accountId ||
        (signedMessage.state && signedMessage.state !== challengeId) ||
        !store.consumeChallenge(challengeId, clock())
      )
        return c.json(
          {
            code: "CHALLENGE_EXPIRED",
            message: "Request a new sign-in challenge",
          },
          409,
        );
      let valid = false;
      try {
        const signed = {
          publicKey: signedMessage.publicKey,
          signature: signedMessage.signature,
          message: challenge.message,
          nonce: Buffer.from(challenge.nonce, "base64"),
          recipient: challenge.recipient,
        };
        valid =
          verifySignature({ ...signed, callbackUrl: challenge.callback_url }) ||
          verifySignature(signed);
      } catch {
        valid = false;
      }
      if (!valid)
        return c.json(
          {
            code: "INVALID_SIGNATURE",
            message: "Wallet signature did not match",
          },
          401,
        );
      let keyActive: boolean;
      try {
        keyActive = await chain.hasAccessKey(
          signedMessage.accountId,
          signedMessage.publicKey,
        );
      } catch {
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Could not verify the wallet key on testnet",
          },
          503,
        );
      }
      if (!keyActive)
        return c.json(
          { code: "KEY_NOT_FOUND", message: "Wallet key is no longer active" },
          401,
        );
      const now = clock();
      const expiresAt = now + SESSION_TTL;
      const token = randomBytes(32).toString("base64url");
      store.createSession(
        hash(token),
        signedMessage.accountId,
        signedMessage.publicKey,
        now,
        expiresAt,
      );
      c.header("Set-Cookie", sessionCookie(token, secure, SESSION_TTL));
      c.header("Cache-Control", "no-store");
      return c.json({ accountId: signedMessage.accountId, expiresAt });
    },
  );

  app.get("/auth/me", (c) => {
    const accountId = currentAccount(c.req.header("cookie"));
    c.header("Cache-Control", "no-store");
    return accountId
      ? c.json({ accountId })
      : c.json(
          { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
          401,
        );
  });

  app.post("/auth/logout", (c) => {
    const token = cookieValue(c.req.header("cookie"), "estate_session");
    if (token) store.deleteSession(hash(token));
    c.header("Set-Cookie", sessionCookie("", secure, 0));
    c.header("Cache-Control", "no-store");
    return c.json({ signedOut: true });
  });

  app.post(
    "/generations",
    bodyLimit({
      maxSize: 4096,
      onError: () => replyError("TOO_LARGE", "Request is too large", 413),
    }),
    async (c) => {
      if (!chain)
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Testnet contract is not configured",
          },
          503,
        );
      const accountId = currentAccount(c.req.header("cookie"));
      if (!accountId)
        return c.json(
          { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
          401,
        );
      const request = GenerationRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!request.success)
        return c.json(
          {
            code: "INVALID_REQUEST",
            message: "Choose a plot, colour and description",
          },
          400,
        );
      const now = clock();
      if (store.recentGenerations(accountId, now - 86_400) >= 10)
        return c.json(
          { code: "RATE_LIMITED", message: "Try again tomorrow" },
          429,
        );
      const { plotId, palette, description, themeHint, materialHints } =
        request.data;
      let plot;
      try {
        plot = await chain.plot(plotId);
      } catch {
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Could not check plot ownership",
          },
          503,
        );
      }
      if (!plot || plot.plot.owner !== accountId)
        return c.json(
          { code: "NOT_OWNER", message: "This wallet does not own the plot" },
          403,
        );
      const building = plot.plot.building;
      const variant = building.variant as 1 | 2;
      let promptSpec;
      try {
        promptSpec = buildGenerationPrompt({
          buildingType: building.building_type,
          level: building.level,
          variant,
          palette,
          description,
          themeHint,
          materialHints,
          referenceManifestHash: building.approved_manifest_hash,
        });
      } catch {
        return c.json(
          { code: "INVALID_REQUEST", message: "Choose valid design hints" },
          400,
        );
      }
      const nextPalette =
        CURATED_PALETTES[
          (CURATED_PALETTES.indexOf(palette) + 1) % CURATED_PALETTES.length
        ]!;
      const specs: [
        Pick<MockCandidate, "id" | "variant" | "palette">,
        Pick<MockCandidate, "id" | "variant" | "palette">,
        Pick<MockCandidate, "id" | "variant" | "palette">,
      ] = [
        { id: 1, variant, palette },
        { id: 2, variant: variant === 1 ? 2 : 1, palette },
        { id: 3, variant, palette: nextPalette },
      ];
      let rendered;
      try {
        rendered = await Promise.all(
          specs.map((candidate) =>
            renderMockCandidate(
              building.building_type,
              candidate.variant,
              building.level,
              candidate.palette,
            ),
          ),
        );
      } catch {
        return c.json(
          { code: "ART_UNAVAILABLE", message: "Curated art is unavailable" },
          503,
        );
      }
      let currentPlot;
      try {
        currentPlot = await chain.plot(plotId);
      } catch {
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Could not recheck plot ownership",
          },
          503,
        );
      }
      if (
        !currentPlot ||
        currentPlot.plot.owner !== accountId ||
        currentPlot.plot.building.layout_revision !==
          building.layout_revision ||
        currentPlot.plot.building.appearance_revision !==
          building.appearance_revision ||
        currentPlot.plot.building.building_type !== building.building_type ||
        currentPlot.plot.building.level !== building.level
      )
        return c.json(
          { code: "PLOT_CHANGED", message: "The plot changed; try again" },
          409,
        );
      if (store.recentGenerations(accountId, now - 86_400) >= 10)
        return c.json(
          { code: "RATE_LIMITED", message: "Try again tomorrow" },
          429,
        );
      const completeCandidates = specs.map((candidate, index) => {
        const art = rendered[index]!;
        return {
          ...candidate,
          manifest: art.manifest,
          manifestHash: art.manifestHash,
          spriteHash: art.spriteHash,
          thumbnailHash: art.thumbnailHash,
        };
      }) as [MockCandidate, MockCandidate, MockCandidate];
      let job: GenerationJob;
      try {
        job = await store.withAssetMutation(async () => {
          await Promise.all(
            rendered.flatMap((art) => [
              saveImmutablePng(store.assetDir, art.spriteHash, art.sprite),
              saveImmutablePng(
                store.assetDir,
                art.thumbnailHash,
                art.thumbnail,
              ),
            ]),
          );
          return store.createGeneration({
            accountId,
            plotId,
            buildingType: building.building_type,
            level: building.level,
            layoutRevision: building.layout_revision,
            appearanceRevision: building.appearance_revision,
            description,
            promptSpec,
            candidates: completeCandidates,
            createdAt: now,
          });
        });
      } catch {
        return c.json(
          { code: "ART_UNAVAILABLE", message: "Could not save curated art" },
          503,
        );
      }
      c.header("Cache-Control", "no-store");
      return c.json(jobResponse(job), 201);
    },
  );

  app.post(
    "/paid-generations",
    bodyLimit({
      maxSize: 4096,
      onError: () => replyError("TOO_LARGE", "Request is too large", 413),
    }),
    async (c) => {
      if (!paidLedger)
        return c.json(
          {
            code: "GENERATION_DISABLED",
            message: "Prompt art is not available",
          },
          503,
        );
      if (!chain)
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Testnet contract is not configured",
          },
          503,
        );
      const accountId = currentAccount(c.req.header("cookie"));
      if (!accountId)
        return c.json(
          { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
          401,
        );
      const request = GenerationRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      const idempotencyKey = c.req.header("idempotency-key") ?? "";
      if (!request.success || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))
        return c.json(
          {
            code: "INVALID_REQUEST",
            message: "Choose a plot and design, then provide a request key",
          },
          400,
        );
      const {
        plotId,
        description,
        palette,
        themeHint,
        materialHints,
        usePriorArt,
      } = request.data;
      const previous = paidLedger.byIdempotencyKey(accountId, idempotencyKey);
      if (previous) {
        const prior = previous.snapshot?.promptSpec;
        const sameHints =
          prior?.materialHints.join(",") ===
          MaterialHint.options
            .filter((hint) => materialHints.includes(hint))
            .join(",");
        if (
          previous.plotId !== plotId ||
          prior?.description !== description ||
          prior.palette !== palette ||
          prior.themeHint !== themeHint ||
          (previous.snapshot?.usePriorArt ?? true) !== usePriorArt ||
          !sameHints
        )
          return c.json(
            {
              code: "IDEMPOTENCY_CONFLICT",
              message: "Request key was already used for another design",
            },
            409,
          );
        c.header("Cache-Control", "no-store");
        return c.json(paidJobResponse(store, paidLedger, previous), 202);
      }
      let initial;
      try {
        initial = await chain.plot(plotId);
      } catch {
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Could not check plot ownership",
          },
          503,
        );
      }
      if (!initial || initial.plot.owner !== accountId)
        return c.json(
          { code: "NOT_OWNER", message: "This wallet does not own the plot" },
          403,
        );
      const building = initial.plot.building;
      const currentReference =
        usePriorArt && building.approved_manifest_hash
          ? store.approvedReference(
              accountId,
              plotId,
              building.building_type,
              building.level,
              building.approved_manifest_hash,
            )
          : null;
      if (usePriorArt && building.approved_manifest_hash && !currentReference)
        return c.json(
          {
            code: "ART_UNAVAILABLE",
            message: "The approved building reference is unavailable",
          },
          503,
        );
      const priorReference =
        usePriorArt && !currentReference && building.level > 1
          ? store.approvedReference(
              accountId,
              plotId,
              building.building_type,
              building.level - 1,
            )
          : null;
      const revokedHash =
        building.last_appearance_decision?.status === "Revoked"
          ? building.last_appearance_decision.reference.manifest_hash
          : null;
      const referenceManifestHash =
        currentReference?.manifestHash ??
        (priorReference?.manifestHash === revokedHash
          ? null
          : (priorReference?.manifestHash ?? null));
      let promptSpec;
      try {
        promptSpec = buildGenerationPrompt({
          buildingType: building.building_type,
          level: building.level,
          variant: building.variant as 1 | 2,
          palette,
          description,
          themeHint,
          materialHints,
          referenceManifestHash,
        });
      } catch {
        return c.json(
          { code: "INVALID_REQUEST", message: "Choose valid design hints" },
          400,
        );
      }
      let current;
      try {
        current = await chain.plot(plotId);
      } catch {
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Could not recheck plot ownership",
          },
          503,
        );
      }
      const currentBuilding = current?.plot.building;
      if (
        current?.plot.owner !== accountId ||
        currentBuilding?.building_type !== building.building_type ||
        currentBuilding.level !== building.level ||
        currentBuilding.variant !== building.variant ||
        currentBuilding.layout_revision !== building.layout_revision ||
        currentBuilding.appearance_revision !== building.appearance_revision ||
        currentBuilding.approved_manifest_hash !==
          building.approved_manifest_hash
      )
        return c.json(
          { code: "PLOT_CHANGED", message: "The plot changed; try again" },
          409,
        );
      try {
        const job = paidLedger.reserve({
          accountId,
          plotId,
          idempotencyKey,
          snapshot: {
            buildingType: building.building_type,
            level: building.level as 1 | 2 | 3 | 4,
            layoutRevision: building.layout_revision,
            appearanceRevision: building.appearance_revision,
            approvedManifestHashAtRequest: building.approved_manifest_hash,
            usePriorArt,
            promptSpec,
          },
          now: clock(),
        });
        c.header("Cache-Control", "no-store");
        return c.json(paidJobResponse(store, paidLedger, job), 202);
      } catch (error) {
        if (error instanceof PaidJobLimitError) {
          const status =
            error.code === "INVITE_REQUIRED"
              ? 403
              : error.code === "IDEMPOTENCY_CONFLICT"
                ? 409
                : 429;
          return c.json(
            {
              code: error.code,
              message: "This design request cannot be queued",
            },
            status,
          );
        }
        return c.json(
          { code: "QUEUE_UNAVAILABLE", message: "Could not queue the design" },
          503,
        );
      }
    },
  );

  app.get("/paid-generations/status", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ enabled: Boolean(paidLedger) });
  });

  app.get("/paid-generations/latest", (c) => {
    if (!paidLedger)
      return c.json(
        { code: "GENERATION_DISABLED", message: "Prompt art is not available" },
        503,
      );
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    const plotId = PLOT_ID.safeParse(c.req.query("plot_id"));
    if (!plotId.success)
      return c.json(
        { code: "INVALID_REQUEST", message: "Choose a valid plot" },
        400,
      );
    const job = paidLedger.latest(accountId, plotId.data);
    c.header("Cache-Control", "no-store");
    return job
      ? c.json(paidJobResponse(store, paidLedger, job))
      : c.json({ code: "NOT_FOUND", message: "No prompt job yet" }, 404);
  });

  app.get("/paid-generations/:id", (c) => {
    if (!paidLedger)
      return c.json(
        { code: "GENERATION_DISABLED", message: "Prompt art is not available" },
        503,
      );
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    const job = paidLedger.job(c.req.param("id"));
    if (!job || job.accountId !== accountId)
      return c.json(
        { code: "NOT_FOUND", message: "Prompt job not found" },
        404,
      );
    c.header("Cache-Control", "no-store");
    return c.json(paidJobResponse(store, paidLedger, job));
  });

  app.post("/paid-generations/:id/cancel", (c) => {
    if (!paidLedger)
      return c.json(
        { code: "GENERATION_DISABLED", message: "Prompt art is not available" },
        503,
      );
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    const job = paidLedger.job(c.req.param("id"));
    if (!job || job.accountId !== accountId)
      return c.json(
        { code: "NOT_FOUND", message: "Prompt job not found" },
        404,
      );
    const cancelled = paidLedger.cancel(job.id);
    if (!cancelled) throw new Error("Cancelled paid job disappeared");
    c.header("Cache-Control", "no-store");
    return c.json(paidJobResponse(store, paidLedger, cancelled));
  });

  app.get("/generations/latest", async (c) => {
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    const plotId = PLOT_ID.safeParse(c.req.query("plot_id"));
    if (!plotId.success)
      return c.json(
        { code: "INVALID_REQUEST", message: "Choose a valid plot" },
        400,
      );
    let job = store.latestGeneration(accountId, plotId.data);
    if (job?.status === "submitted")
      job = await reconcileDecision(job).catch(() => job);
    else if (job?.status === "approved")
      job = await reconcileRevocation(job).catch(() => job);
    c.header("Cache-Control", "no-store");
    return job
      ? c.json(jobResponse(job))
      : c.json({ code: "NOT_FOUND", message: "No design job yet" }, 404);
  });

  app.get("/generations/history", async (c) => {
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    const plotId = PLOT_ID.safeParse(c.req.query("plot_id"));
    if (!plotId.success)
      return c.json(
        { code: "INVALID_REQUEST", message: "Choose a valid plot" },
        400,
      );
    const jobs = await Promise.all(
      store.generationHistory(accountId, plotId.data, 20).map(async (job) => {
        if (job.status === "submitted")
          return reconcileDecision(job).catch(() => job);
        if (job.status === "approved")
          return reconcileRevocation(job).catch(() => job);
        return job;
      }),
    );
    c.header("Cache-Control", "no-store");
    return c.json(jobs.map(jobResponse));
  });

  app.get("/generations/:id", async (c) => {
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    const id = CHALLENGE_ID.safeParse(c.req.param("id"));
    let job = id.success ? store.generation(id.data) : null;
    if (job?.accountId === accountId && job.status === "submitted")
      job = await reconcileDecision(job).catch(() => job);
    else if (job?.accountId === accountId && job.status === "approved")
      job = await reconcileRevocation(job).catch(() => job);
    c.header("Cache-Control", "no-store");
    return job?.accountId === accountId
      ? c.json(jobResponse(job))
      : c.json({ code: "NOT_FOUND", message: "Design job not found" }, 404);
  });

  app.post(
    "/generations/:id/select",
    bodyLimit({
      maxSize: 512,
      onError: () => replyError("TOO_LARGE", "Request is too large", 413),
    }),
    async (c) => {
      const accountId = currentAccount(c.req.header("cookie"));
      if (!accountId)
        return c.json(
          { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
          401,
        );
      if (!chain)
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Testnet contract is not configured",
          },
          503,
        );
      const id = CHALLENGE_ID.safeParse(c.req.param("id"));
      const request = GenerationSelection.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!id.success || !request.success)
        return c.json(
          { code: "INVALID_REQUEST", message: "Choose one design" },
          400,
        );
      const job = store.generation(id.data);
      if (!job || job.accountId !== accountId)
        return c.json(
          { code: "NOT_FOUND", message: "Design job not found" },
          404,
        );
      if (job.status !== "ready" && job.status !== "selected")
        return c.json(
          {
            code: "ALREADY_SUBMITTED",
            message: "This design job is already under review",
          },
          409,
        );
      const candidate = job.candidates.find(
        (entry) => entry.id === request.data.candidateId,
      );
      if (!candidate)
        return c.json(
          { code: "INVALID_REQUEST", message: "Design choice is missing" },
          400,
        );
      let plot;
      try {
        plot = await chain.plot(job.plotId);
      } catch {
        return c.json(
          { code: "CHAIN_UNAVAILABLE", message: "Could not check the plot" },
          503,
        );
      }
      if (
        !plot ||
        plot.plot.owner !== accountId ||
        plot.plot.building.building_type !== job.buildingType ||
        plot.plot.building.level !== job.level ||
        plot.plot.building.layout_revision !== job.layoutRevision ||
        plot.plot.building.appearance_revision !== job.appearanceRevision
      )
        return c.json(
          {
            code: "PLOT_CHANGED",
            message: "The building changed; generate again",
          },
          409,
        );
      const selected = store.selectGeneration(
        job.id,
        accountId,
        request.data.candidateId,
      );
      if (!selected)
        return c.json(
          {
            code: "ALREADY_SUBMITTED",
            message: "This design job is already under review",
          },
          409,
        );
      c.header("Cache-Control", "no-store");
      return c.json({
        jobId: job.id,
        candidateId: candidate.id,
        plotId: job.plotId,
        expectedRevision: plot.plot.building.appearance_revision,
        manifestHash: candidate.manifestHash,
      });
    },
  );

  app.post("/generations/:id/reconcile", async (c) => {
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    if (!chain)
      return c.json(
        {
          code: "CHAIN_UNAVAILABLE",
          message: "Testnet contract is not configured",
        },
        503,
      );
    const id = CHALLENGE_ID.safeParse(c.req.param("id"));
    const job = id.success ? store.generation(id.data) : null;
    if (!job || job.accountId !== accountId)
      return c.json(
        { code: "NOT_FOUND", message: "Design job not found" },
        404,
      );
    if (job.status !== "selected" && job.status !== "submitted")
      return c.json(
        { code: "NOT_SELECTED", message: "Select a design first" },
        409,
      );
    const candidate = job.candidates.find(
      (entry) => entry.id === job.selectedCandidateId,
    );
    if (!candidate)
      return c.json(
        { code: "NOT_SELECTED", message: "Selected design is missing" },
        409,
      );
    let plot;
    try {
      plot = await chain.plot(job.plotId);
    } catch {
      return c.json(
        { code: "CHAIN_UNAVAILABLE", message: "Could not check the proposal" },
        503,
      );
    }
    const pending = plot?.plot.building.pending_appearance;
    if (
      plot?.plot.owner !== accountId ||
      !pending ||
      pending.owner !== accountId ||
      pending.building_type !== job.buildingType ||
      pending.level !== job.level ||
      pending.manifest_hash !== candidate.manifestHash ||
      pending.revision !== plot.plot.building.appearance_revision ||
      pending.revision !== (job.appearanceRevision ?? -1) + 1
    )
      return c.json(
        {
          code: "PROPOSAL_NOT_FOUND",
          message: "The exact proposal is not confirmed on-chain",
        },
        409,
      );
    store.markGenerationSubmitted(job.id, pending.revision);
    c.header("Cache-Control", "no-store");
    return c.json(jobResponse(store.generation(job.id)!));
  });

  app.get("/manifests/:hash", (c) => {
    const manifestHash = HASH.safeParse(c.req.param("hash"));
    if (!manifestHash.success)
      return c.json({ code: "NOT_FOUND", message: "Manifest not found" }, 404);
    let manifest: ReturnType<ApiStore["publicManifest"]>;
    try {
      manifest = store.publicManifest(manifestHash.data);
    } catch {
      c.header("Cache-Control", "no-store");
      return c.json(
        { code: "ASSET_CORRUPT", message: "Stored manifest is invalid" },
        503,
      );
    }
    if (!manifest)
      return c.json({ code: "NOT_FOUND", message: "Manifest not found" }, 404);
    let validatedManifest: ReturnType<typeof validateAssetManifest>;
    try {
      validatedManifest = validateAssetManifest(manifest);
      if (hash(canonicalJson(validatedManifest)) !== manifestHash.data)
        throw new Error("Manifest hash mismatch");
    } catch {
      c.header("Cache-Control", "no-store");
      return c.json(
        { code: "ASSET_CORRUPT", message: "Stored manifest is invalid" },
        503,
      );
    }
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.json(validatedManifest);
  });

  app.get("/moderation/status", async (c) => {
    c.header("Cache-Control", "no-store");
    const denied = requireModerator(c);
    if (denied) return denied;
    try {
      await moderator!.checkAuthorization();
      return c.json({ status: "ok", role: "moderator" });
    } catch (error) {
      console.warn(
        "Moderator authorization check failed:",
        error instanceof Error ? error.message : String(error),
      );
      return c.json(
        {
          code: "MODERATOR_KEY_UNAVAILABLE",
          message: "Moderator role or restricted key is unavailable",
        },
        503,
      );
    }
  });

  app.get("/moderation", async (c) => {
    const denied = requireModerator(c);
    if (denied) return denied;
    const queue = store.reviewQueue().slice(0, 20);
    const cards: string[] = [];
    for (const original of queue) {
      const job = await reconcileDecision(original).catch(() => original);
      if (job.status !== "submitted") continue;
      const candidate = job.candidates.find(
        (entry) => entry.id === job.selectedCandidateId,
      );
      if (!candidate) continue;
      let selectedImage = "";
      try {
        const bytes = await checkedFacadeCandidate(store, job, candidate);
        selectedImage = `data:image/png;base64,${bytes.toString("base64")}`;
      } catch {
        cards.push(`<section class="review"><h2>${escapeHtml(job.plotId)} · selected facade unavailable</h2>
          <p>The selected image files or manifest are missing or changed. Restore the exact stored assets before approval.</p>
          <form method="post" action="/api/moderation/generations/${job.id}/reject"><label>Rejection reason <input name="reason" required maxlength="240"></label><button>Reject exact design</button></form>
        </section>`);
        continue;
      }
      const parts = job.plotId.split("-");
      const index = Number(parts[parts.length - 1]);
      const neighbors: string[] = [];
      for (const neighborIndex of [index - 1, index + 1]) {
        if (neighborIndex < 0 || neighborIndex > 7 || !chain) {
          neighbors.push('<div class="neighbor">Street end</div>');
          continue;
        }
        const neighborId = `${parts.slice(0, -1).join("-")}-${neighborIndex}`;
        try {
          const neighbor = await chain.plot(neighborId);
          if (!neighbor) throw new Error("Missing neighbor");
          const building = neighbor.plot.building;
          const approved = building.approved_manifest_hash
            ? store.publicManifest(building.approved_manifest_hash)
            : null;
          const url = approved
            ? `/api/assets/${approved.thumbnailHash}`
            : `data:image/png;base64,${(
                await renderMockCandidate(
                  building.building_type,
                  building.variant as 1 | 2,
                  building.level,
                  building.primary_color,
                )
              ).thumbnail.toString("base64")}`;
          neighbors.push(
            `<div class="neighbor"><img src="${url}" alt="" width="140" height="160"><span>${escapeHtml(building.name)}</span></div>`,
          );
        } catch {
          neighbors.push('<div class="neighbor">Neighbor unavailable</div>');
        }
      }
      cards.push(`<section class="review"><h2>${escapeHtml(job.plotId)} · ${escapeHtml(job.buildingType)} level ${job.level}</h2>
        <p>Owner: ${escapeHtml(job.accountId)} · revision ${job.proposalRevision}</p>
        <p>Prompt: ${escapeHtml(job.description)}</p>
        <div class="street">${neighbors[0]}<div class="chosen"><img src="${selectedImage}" alt="Selected facade" width="140" height="160"><span>Selected design ${candidate.id}</span></div>${neighbors[1]}</div>
        <p>Approving this facade advances the building layout. Any current logo or billboard stays hidden until separately reapproved for the new layout.</p>
        <p>Manifest: <code>${candidate.manifestHash}</code></p>
        <form method="post" action="/api/moderation/generations/${job.id}/approve"><button>Approve exact design</button></form>
        <form method="post" action="/api/moderation/generations/${job.id}/reject"><label>Rejection reason <input name="reason" required maxlength="240"></label><button>Reject exact design</button></form>
      </section>`);
    }
    const revocations: string[] = [];
    for (const original of store.recentApprovedGenerations(20)) {
      const job = await reconcileRevocation(original).catch(() => original);
      if (job.status !== "approved" || !chain) continue;
      const candidate = job.candidates.find(
        (entry) => entry.id === job.selectedCandidateId,
      );
      if (!candidate) continue;
      try {
        const plot = await chain.plot(job.plotId);
        if (
          plot?.plot.building.approved_manifest_hash !== candidate.manifestHash
        )
          continue;
      } catch {
        continue;
      }
      revocations.push(`<section class="review"><h2>${escapeHtml(job.plotId)} · active facade</h2>
        <img src="/api/assets/${candidate.thumbnailHash}" alt="Approved facade" width="140" height="160">
        <p>Manifest: <code>${candidate.manifestHash}</code></p>
        <form method="post" action="/api/moderation/generations/${job.id}/revoke"><label>Withdrawal reason <input name="reason" required maxlength="240"></label><button>Revoke active design</button></form>
      </section>`);
    }
    const mediaCards: string[] = [];
    for (const original of store.mediaReviewQueue().slice(0, 20)) {
      const record = await reconcileMediaDecision(original).catch(
        () => original,
      );
      if (record.status !== "submitted") continue;
      let selectedImage = "";
      try {
        const bytes = await readFile(
          join(store.assetDir, `${record.assetHash}.png`),
        );
        selectedImage = `data:image/png;base64,${bytes.toString("base64")}`;
      } catch {
        selectedImage = "";
      }
      let combinedPreview = "";
      let previewReady = false;
      try {
        if (!selectedImage) throw new Error("Proposed image unavailable");
        const plot = await chain?.plot(record.plotId);
        if (!plot) throw new Error("Plot unavailable");
        const combined = await mediaReviewPreview(store, plot, record);
        previewReady = true;
        combinedPreview = `<div class="media-comparison"><div><p>Proposed image</p><img src="${selectedImage}" alt="Proposed ${record.kind.toLowerCase()}" style="max-width:min(100%,512px);max-height:256px;object-fit:contain"></div><div><p>Facade with approved media after this decision</p><img src="data:image/png;base64,${combined.png.toString("base64")}" alt="Final facade with logo and billboard" width="280" height="320"><p>Logo link: <code>${combined.logo?.link ? escapeHtml(combined.logo.link) : "None"}</code><br>Billboard link: <code>${combined.billboard?.link ? escapeHtml(combined.billboard.link) : "None"}</code></p></div></div>`;
      } catch {
        combinedPreview = `<p>Final facade preview unavailable. Restore the current facade and media files before approving.</p>${selectedImage ? `<img src="${selectedImage}" alt="Proposed ${record.kind.toLowerCase()}" style="max-width:min(100%,512px);max-height:256px;object-fit:contain">` : ""}`;
      }
      mediaCards.push(`<section class="review"><h2>${escapeHtml(record.plotId)} · ${record.kind}</h2>
        <p>Owner: ${escapeHtml(record.accountId)} · ${escapeHtml(record.buildingType)} level ${record.level} · layout ${record.layoutRevision} · revision ${record.proposalRevision}</p>
        ${combinedPreview}
        <p>Destination: <code>${record.link ? escapeHtml(record.link) : "None"}</code></p>
        <p>Image hash: <code>${record.assetHash}</code></p>
        <form method="post" action="/api/moderation/media/${record.id}/approve"><button ${previewReady ? "" : "disabled"}>Approve exact ${record.kind.toLowerCase()}</button></form>
        <form method="post" action="/api/moderation/media/${record.id}/reject"><label>Rejection reason <input name="reason" required maxlength="240"></label><button>Reject exact ${record.kind.toLowerCase()}</button></form>
      </section>`);
    }
    const activeMediaCards: string[] = [];
    for (const original of store.activeMediaProposals(20)) {
      const record = await reconcileMediaRevocation(original).catch(
        () => original,
      );
      if (record.status !== "approved" || !chain) continue;
      try {
        const plot = await chain.plot(record.plotId);
        const slot =
          record.kind === "Logo" ? plot?.plot.logo : plot?.plot.billboard;
        if (
          slot?.active?.content.asset_hash !== record.assetHash ||
          slot.active.content.link !== record.link ||
          slot.active.approved_layout_revision !== record.layoutRevision
        )
          continue;
      } catch {
        continue;
      }
      activeMediaCards.push(`<section class="review"><h2>${escapeHtml(record.plotId)} · active ${record.kind.toLowerCase()}</h2>
        <img src="/api/assets/${record.assetHash}" alt="Approved ${record.kind.toLowerCase()}" style="max-width:min(100%,512px);max-height:256px;object-fit:contain">
        <p>Destination: <code>${record.link ? escapeHtml(record.link) : "None"}</code></p>
        <p>Image hash: <code>${record.assetHash}</code></p>
        <form method="post" action="/api/moderation/media/${record.id}/revoke"><label>Withdrawal reason <input name="reason" required maxlength="240"></label><button>Revoke active ${record.kind.toLowerCase()}</button></form>
      </section>`);
    }
    const paidCandidateCards: string[] = [];
    for (const { job, candidate } of paidLedger?.pendingCandidateReviews(20) ??
      []) {
      if (!job.snapshot) continue;
      let sprite: Buffer;
      try {
        sprite = await readFile(
          join(store.assetDir, `${candidate.spriteHash}.png`),
        );
        if (hash(sprite) !== candidate.spriteHash) continue;
      } catch {
        continue;
      }
      const outline = (
        label: string,
        rect: NonNullable<typeof candidate.manifest.logoRect> | null,
      ) =>
        rect
          ? `<span class="placement" style="left:${rect.x * 2}px;top:${rect.y * 2}px;width:${rect.width * 2}px;height:${rect.height * 2}px">${label}</span>`
          : "";
      paidCandidateCards.push(`<section class="review"><h2>${escapeHtml(job.plotId)} · generated candidate ${candidate.ordinal}</h2>
        <p>Owner: ${escapeHtml(job.accountId)} · ${escapeHtml(job.snapshot.buildingType)} level ${job.snapshot.level}</p>
        <p>Owner description: ${escapeHtml(job.snapshot.promptSpec.description)}</p>
        <div class="candidate-art"><img src="data:image/png;base64,${sprite.toString("base64")}" alt="Full generated facade with placement outlines" width="280" height="320">${outline("Logo", candidate.manifest.logoRect)}${outline("Billboard", candidate.manifest.billboardRect)}</div>
        <p>These outlines mark the exact logo and billboard rectangles in the asset manifest. The image is still private to this review page.</p>
        <p>Manifest: <code>${candidate.manifestHash}</code></p>
        <form method="post" action="/api/moderation/paid-generations/${encodeURIComponent(job.id)}/candidates/${candidate.ordinal}/approve">
          <label><input type="checkbox" name="content_ok" required> Content is suitable for the city</label>
          <label><input type="checkbox" name="style_ok" required> Style and perspective match the game</label>
          <label><input type="checkbox" name="placement_ok" required> Available logo and billboard spaces are usable</label>
          <button>Approve candidate for owner</button>
        </form>
        <form method="post" action="/api/moderation/paid-generations/${encodeURIComponent(job.id)}/candidates/${candidate.ordinal}/reject"><label>Rejection reason <input name="reason" required maxlength="500"></label><button>Reject candidate</button></form>
      </section>`);
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Frame-Options", "DENY");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'",
    );
    return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>near.estate moderation</title>
      <style>body{font:16px system-ui,sans-serif;margin:24px auto;padding:0 16px;max-width:900px;color:#1d3445;background:#faf6ea}h1{font-size:24px}h2{font-size:18px}.review{border:1px solid #bdc7bd;border-radius:12px;padding:18px;margin:18px 0;background:#fff}.street{display:flex;gap:12px;align-items:end;justify-content:center;overflow:auto}.street>div{width:150px;min-width:100px;text-align:center}.street img{max-width:100%;height:auto}.chosen{background:#e8f2e8;border-radius:8px}span{display:block}form{display:inline-block;margin:12px 12px 0 0}form label{display:block;margin:6px 0}form input[type=checkbox]{display:inline;width:auto}.candidate-art{position:relative;width:280px;height:320px;background:#e8f2e8}.candidate-art img{display:block}.placement{position:absolute;box-sizing:border-box;border:2px solid #ffb900;background:#ffb90044;color:#14213d;font-size:12px;font-weight:700;line-height:1.2}.media-comparison{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}.media-comparison>div{max-width:100%}.media-comparison img{background:#e8f2e8}input{display:block;width:220px;max-width:100%;font:inherit}button{font:inherit;padding:8px 12px}code{overflow-wrap:anywhere}</style>
      <h1>Generated candidate review</h1><p>${paidCandidateCards.length} private candidate${paidCandidateCards.length === 1 ? "" : "s"} shown</p>${paidCandidateCards.join("") || "<p>No generated candidates await review.</p>"}<h1>Facade moderation</h1><p>${cards.length} pending design${cards.length === 1 ? "" : "s"} shown</p>${cards.join("") || "<p>No designs await review.</p>"}<h2>Active designs</h2>${revocations.join("") || "<p>No active custom designs in this service.</p>"}<h1>Logo and billboard moderation</h1><p>${mediaCards.length} pending image${mediaCards.length === 1 ? "" : "s"} shown</p>${mediaCards.join("") || "<p>No images await review.</p>"}<h2>Active logos and billboards</h2>${activeMediaCards.join("") || "<p>No active media in this service.</p>"}</html>`);
  });

  app.post(
    "/moderation/paid-generations/:id/candidates/:ordinal/:decision",
    bodyLimit({
      maxSize: 1024,
      onError: () => replyError("TOO_LARGE", "Request is too large", 413),
    }),
    async (c) => {
      const denied = requireModerator(c);
      if (denied) return denied;
      if (!paidLedger)
        return c.json(
          {
            code: "GENERATION_DISABLED",
            message: "Prompt review is unavailable",
          },
          503,
        );
      const id = CHALLENGE_ID.safeParse(c.req.param("id"));
      const ordinal = Number(c.req.param("ordinal"));
      const decision = c.req.param("decision");
      if (
        !id.success ||
        !Number.isInteger(ordinal) ||
        ordinal < 1 ||
        ordinal > 3 ||
        (decision !== "approve" && decision !== "reject")
      )
        return c.json(
          { code: "INVALID_REQUEST", message: "Invalid candidate review" },
          400,
        );
      const candidate = paidLedger
        .candidates(id.data)
        .find((item) => item.ordinal === ordinal);
      if (!candidate || candidate.reviewStatus !== "pending")
        return c.json(
          { code: "NOT_FOUND", message: "Candidate is not awaiting review" },
          404,
        );
      const form = await c.req.parseBody().catch(() => null);
      const rawReason = form && "reason" in form ? form.reason : null;
      const reason = typeof rawReason === "string" ? rawReason.trim() : "";
      if (decision === "approve") {
        if (
          form?.content_ok !== "on" ||
          form.style_ok !== "on" ||
          form.placement_ok !== "on"
        )
          return c.json(
            {
              code: "REVIEW_INCOMPLETE",
              message: "Confirm content, style and placement before approval",
            },
            400,
          );
        try {
          const [sprite, thumbnail] = await Promise.all([
            readFile(join(store.assetDir, `${candidate.spriteHash}.png`)),
            readFile(join(store.assetDir, `${candidate.thumbnailHash}.png`)),
          ]);
          if (
            hash(sprite) !== candidate.spriteHash ||
            hash(thumbnail) !== candidate.thumbnailHash
          )
            throw new Error("Candidate asset hash mismatch");
        } catch {
          return c.json(
            {
              code: "ASSET_MISSING",
              message: "Candidate image is unavailable",
            },
            409,
          );
        }
      } else if (reason.length < 1 || Array.from(reason).length > 500)
        return c.json(
          { code: "INVALID_REASON", message: "Enter a rejection reason" },
          400,
        );
      try {
        paidLedger.reviewCandidate({
          jobId: id.data,
          ordinal,
          decision: decision === "approve" ? "approved" : "rejected",
          reason: decision === "reject" ? reason : null,
          now: clock(),
          reviewer: adminCredentials?.user ?? "moderator",
        });
        const reviewedJob = paidLedger.job(id.data);
        if (reviewedJob) promotePaidJob(store, paidLedger, reviewedJob);
      } catch {
        return c.json(
          { code: "REVIEW_CHANGED", message: "Candidate review changed" },
          409,
        );
      }
      return c.redirect("/api/moderation", 303);
    },
  );

  app.post(
    "/moderation/generations/:id/:decision",
    bodyLimit({
      maxSize: 1024,
      onError: () => replyError("TOO_LARGE", "Request is too large", 413),
    }),
    async (c) => {
      const denied = requireModerator(c);
      if (denied) return denied;
      if (!chain || !moderator)
        return c.json(
          { code: "CHAIN_UNAVAILABLE", message: "Moderation is unavailable" },
          503,
        );
      const id = CHALLENGE_ID.safeParse(c.req.param("id"));
      const action = c.req.param("decision");
      if (
        !id.success ||
        (action !== "approve" && action !== "reject" && action !== "revoke")
      )
        return c.json(
          { code: "INVALID_REQUEST", message: "Invalid review action" },
          400,
        );
      const job = store.generation(id.data);
      if (
        !job ||
        (action === "revoke"
          ? job.status !== "approved"
          : job.status !== "submitted")
      )
        return c.json(
          { code: "NOT_FOUND", message: "Reviewable design not found" },
          404,
        );
      const expected = exactReference(job);
      if (!expected)
        return c.json(
          { code: "INVALID_JOB", message: "Design reference is missing" },
          409,
        );
      const form = await c.req.parseBody().catch(() => null);
      const rawReason = form && "reason" in form ? form.reason : null;
      const reason = typeof rawReason === "string" ? rawReason.trim() : "";
      if (action !== "approve" && !validOnChainReason(reason))
        return c.json(
          {
            code: "INVALID_REASON",
            message: "Enter a reason up to 240 UTF-8 bytes",
          },
          400,
        );
      try {
        const plot = await chain.plot(job.plotId);
        if (action === "revoke") {
          if (
            plot?.plot.building.approved_manifest_hash !==
            expected.manifest_hash
          )
            return c.json(
              {
                code: "PLOT_CHANGED",
                message: "This design is no longer active",
              },
              409,
            );
          await moderator.revokeAppearance(
            job.plotId,
            plot.plot.building.appearance_revision,
            expected.manifest_hash,
            reason,
          );
          const revoked = await reconcileRevocation(job);
          if (revoked.status === "approved")
            return c.json({ status: "awaiting_finality", jobId: job.id }, 202);
          return c.redirect("/api/moderation", 303);
        }
        if (
          !plot ||
          !sameReference(plot.plot.building.pending_appearance, expected)
        )
          return c.json(
            {
              code: "PLOT_CHANGED",
              message: "The exact proposal is no longer pending",
            },
            409,
          );
        if (action === "approve") {
          const candidate = job.candidates.find(
            (entry) => entry.id === job.selectedCandidateId,
          );
          try {
            if (!candidate) throw new Error("Selected facade is missing");
            await checkedFacadeCandidate(store, job, candidate);
          } catch {
            return c.json(
              {
                code: "ASSET_UNAVAILABLE",
                message: "The selected facade files are missing or changed",
              },
              409,
            );
          }
          await moderator.approveAppearance(job.plotId, expected);
        } else await moderator.rejectAppearance(job.plotId, expected, reason);
        const decided = await reconcileDecision(job);
        if (decided.status === "submitted")
          return c.json({ status: "awaiting_finality", jobId: job.id }, 202);
        return c.redirect("/api/moderation", 303);
      } catch {
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Could not complete the on-chain decision",
          },
          503,
        );
      }
    },
  );

  app.post(
    "/moderation/media/:id/:decision",
    bodyLimit({
      maxSize: 1024,
      onError: () => replyError("TOO_LARGE", "Request is too large", 413),
    }),
    async (c) => {
      const denied = requireModerator(c);
      if (denied) return denied;
      if (!chain || !moderator)
        return c.json(
          { code: "CHAIN_UNAVAILABLE", message: "Moderation is unavailable" },
          503,
        );
      const id = CHALLENGE_ID.safeParse(c.req.param("id"));
      const action = c.req.param("decision");
      if (
        !id.success ||
        (action !== "approve" && action !== "reject" && action !== "revoke")
      )
        return c.json(
          { code: "INVALID_REQUEST", message: "Invalid review action" },
          400,
        );
      const record = store.mediaProposal(id.data);
      if (
        !record ||
        (action === "revoke"
          ? record.status !== "approved"
          : record.status !== "submitted")
      )
        return c.json(
          { code: "NOT_FOUND", message: "Reviewable media not found" },
          404,
        );
      const expected = exactMediaProposal(record);
      if (!expected)
        return c.json(
          { code: "INVALID_PROPOSAL", message: "Media reference is missing" },
          409,
        );
      const form = await c.req.parseBody().catch(() => null);
      const rawReason = form && "reason" in form ? form.reason : null;
      const reason = typeof rawReason === "string" ? rawReason.trim() : "";
      if (action !== "approve" && !validOnChainReason(reason))
        return c.json(
          {
            code: "INVALID_REASON",
            message: "Enter a reason up to 240 UTF-8 bytes",
          },
          400,
        );
      try {
        const plot = await chain.plot(record.plotId);
        const slot =
          record.kind === "Logo" ? plot?.plot.logo : plot?.plot.billboard;
        if (action === "revoke") {
          if (
            !slot?.active ||
            slot.active.content.asset_hash !== record.assetHash ||
            slot.active.content.link !== record.link ||
            slot.active.approved_layout_revision !== record.layoutRevision
          )
            return c.json(
              {
                code: "PLOT_CHANGED",
                message: "This media is no longer active",
              },
              409,
            );
          await moderator.revokeMedia(
            record.plotId,
            record.kind,
            slot.revision,
            slot.active.content,
            reason,
          );
          const revoked = await reconcileMediaRevocation(record);
          if (revoked.status === "approved")
            return c.json(
              { status: "awaiting_finality", mediaId: record.id },
              202,
            );
          return c.redirect("/api/moderation", 303);
        }
        if (!slot || !sameMediaProposal(slot.pending, expected))
          return c.json(
            {
              code: "PLOT_CHANGED",
              message: "The exact media proposal is no longer pending",
            },
            409,
          );
        if (action === "approve") {
          try {
            if (!plot) throw new Error("Plot unavailable");
            await mediaReviewPreview(store, plot, record);
          } catch {
            return c.json(
              {
                code: "PREVIEW_UNAVAILABLE",
                message: "The exact final facade preview is unavailable",
              },
              409,
            );
          }
          await moderator.approveMedia(record.plotId, record.kind, expected);
        } else
          await moderator.rejectMedia(
            record.plotId,
            record.kind,
            expected,
            reason,
          );
        const decided = await reconcileMediaDecision(record);
        if (decided.status === "submitted")
          return c.json(
            { status: "awaiting_finality", mediaId: record.id },
            202,
          );
        return c.redirect("/api/moderation", 303);
      } catch {
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Could not complete the on-chain decision",
          },
          503,
        );
      }
    },
  );

  const upload = (kind: "Logo" | "Billboard") => async (c: Context) => {
    if (!chain)
      return c.json(
        {
          code: "CHAIN_UNAVAILABLE",
          message: "Testnet contract is not configured",
        },
        503,
      );
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    if (!c.req.header("content-type")?.startsWith("multipart/form-data"))
      return c.json(
        { code: "INVALID_UPLOAD", message: "Use a multipart image upload" },
        400,
      );
    const body = await c.req.parseBody().catch(() => null);
    const plotId = PLOT_ID.safeParse(body?.plot_id);
    const file = body?.file;
    if (!plotId.success || !(file instanceof File))
      return c.json(
        { code: "INVALID_UPLOAD", message: "Choose a plot and image file" },
        400,
      );
    let plot;
    try {
      plot = await chain.plot(plotId.data);
    } catch {
      return c.json(
        {
          code: "CHAIN_UNAVAILABLE",
          message: "Could not check plot ownership",
        },
        503,
      );
    }
    if (!plot || plot.plot.owner !== accountId)
      return c.json(
        { code: "NOT_OWNER", message: "This wallet does not own the plot" },
        403,
      );
    const uploadStartedAt = clock();
    if (
      !store.reserveUploadAttempt(
        accountId,
        plotId.data,
        uploadStartedAt,
        UPLOAD_WINDOW_SECONDS,
        MAX_UPLOADS_PER_PLOT,
        MAX_UPLOADS_PER_ACCOUNT,
      )
    )
      return c.json(
        { code: "RATE_LIMITED", message: "Try another image tomorrow" },
        429,
      );
    let output: Buffer;
    try {
      output = await normalizedImage(file, kind);
    } catch (error) {
      return c.json(
        {
          code: "INVALID_IMAGE",
          message:
            error instanceof Error ? error.message : "Could not process image",
        },
        400,
      );
    }
    let currentPlot;
    try {
      currentPlot = await chain.plot(plotId.data);
    } catch {
      return c.json(
        {
          code: "CHAIN_UNAVAILABLE",
          message: "Could not recheck plot ownership",
        },
        503,
      );
    }
    if (
      !currentPlot ||
      currentPlot.plot.owner !== accountId ||
      currentPlot.plot.building.layout_revision !==
        plot.plot.building.layout_revision
    )
      return c.json(
        {
          code: "PLOT_CHANGED",
          message: "The plot changed during upload; try again",
        },
        409,
      );
    const assetHash = hash(output);
    const row = await store.withAssetMutation(async () => {
      await saveImmutablePng(store.assetDir, assetHash, output);
      return store.recordUpload({
        accountId,
        plotId: plotId.data,
        kind,
        hash: assetHash,
        layoutRevision: currentPlot.plot.building.layout_revision,
        createdAt: uploadStartedAt,
      });
    });
    c.header("Cache-Control", "no-store");
    return c.json({
      uploadId: row.id,
      hash: assetHash,
      url: `/api/assets/${assetHash}`,
      width: kind === "Logo" ? 256 : 512,
      height: 256,
      status: "pending",
      layoutRevision: row.layoutRevision,
    });
  };

  app.post(
    "/logos",
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: () => replyError("TOO_LARGE", "Upload exceeds 2 MB", 413),
    }),
    upload("Logo"),
  );
  app.post(
    "/ads",
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: () => replyError("TOO_LARGE", "Upload exceeds 2 MB", 413),
    }),
    upload("Billboard"),
  );

  app.post(
    "/media/uploads/reuse",
    bodyLimit({
      maxSize: 1024,
      onError: () => replyError("TOO_LARGE", "Request is too large", 413),
    }),
    async (c) => {
      if (!chain)
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Testnet contract is not configured",
          },
          503,
        );
      const accountId = currentAccount(c.req.header("cookie"));
      if (!accountId)
        return c.json(
          { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
          401,
        );
      const body = z
        .object({ plotId: PLOT_ID, kind: MediaKind })
        .safeParse(await c.req.json().catch(() => null));
      if (!body.success)
        return c.json(
          { code: "INVALID_REQUEST", message: "Choose a plot and media kind" },
          400,
        );
      const { plotId, kind } = body.data;
      let plot;
      try {
        plot = await chain.plot(plotId);
      } catch {
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Could not check plot ownership",
          },
          503,
        );
      }
      if (!plot || plot.plot.owner !== accountId)
        return c.json(
          { code: "NOT_OWNER", message: "This wallet does not own the plot" },
          403,
        );
      const slot = kind === "Logo" ? plot.plot.logo : plot.plot.billboard;
      const approved = slot.active;
      const layoutRevision = plot.plot.building.layout_revision;
      if (!approved || approved.approved_layout_revision >= layoutRevision)
        return c.json(
          {
            code: "NOT_REUSABLE",
            message: "No earlier approved image needs reuse",
          },
          409,
        );
      const startedAt = clock();
      if (
        !store.reserveUploadAttempt(
          accountId,
          plotId,
          startedAt,
          UPLOAD_WINDOW_SECONDS,
          MAX_UPLOADS_PER_PLOT,
          MAX_UPLOADS_PER_ACCOUNT,
        )
      )
        return c.json(
          { code: "RATE_LIMITED", message: "Try again tomorrow" },
          429,
        );
      let row;
      try {
        row = await store.withAssetMutation(async () => {
          const bytes = await readFile(
            join(store.assetDir, `${approved.content.asset_hash}.png`),
          );
          if (hash(bytes) !== approved.content.asset_hash)
            throw new Error("Approved image hash mismatch");
          const current = await chain.plot(plotId);
          const currentSlot =
            kind === "Logo" ? current?.plot.logo : current?.plot.billboard;
          if (
            current?.plot.owner !== accountId ||
            current.plot.building.layout_revision !== layoutRevision ||
            currentSlot?.active?.content.asset_hash !==
              approved.content.asset_hash ||
            currentSlot.active.approved_layout_revision !==
              approved.approved_layout_revision
          )
            return null;
          return store.recordUpload({
            accountId,
            plotId,
            kind,
            hash: approved.content.asset_hash,
            layoutRevision,
            createdAt: startedAt,
          });
        });
      } catch {
        return c.json(
          {
            code: "ASSET_UNAVAILABLE",
            message: "Approved image is unavailable",
          },
          503,
        );
      }
      if (!row)
        return c.json(
          { code: "PLOT_CHANGED", message: "The plot changed; try again" },
          409,
        );
      c.header("Cache-Control", "no-store");
      return c.json({
        uploadId: row.id,
        hash: row.hash,
        url: `/api/assets/${row.hash}`,
        width: kind === "Logo" ? 256 : 512,
        height: 256,
        status: "pending",
        layoutRevision: row.layoutRevision,
      });
    },
  );

  app.get("/media/uploads/latest", (c) => {
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    const plotId = PLOT_ID.safeParse(c.req.query("plot_id"));
    const kind = MediaKind.safeParse(c.req.query("kind"));
    if (!plotId.success || !kind.success)
      return c.json(
        { code: "INVALID_REQUEST", message: "Choose a plot and media kind" },
        400,
      );
    const upload = store.latestUpload(accountId, plotId.data, kind.data);
    if (!upload)
      return c.json({ code: "NOT_FOUND", message: "No upload found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({
      uploadId: upload.id,
      hash: upload.hash,
      url: `/api/assets/${upload.hash}`,
      width: kind.data === "Logo" ? 256 : 512,
      height: 256,
      status: "pending",
      layoutRevision: upload.layoutRevision,
    });
  });

  app.post(
    "/media/proposals",
    bodyLimit({
      maxSize: 1024,
      onError: () => replyError("TOO_LARGE", "Request is too large", 413),
    }),
    async (c) => {
      const accountId = currentAccount(c.req.header("cookie"));
      if (!accountId)
        return c.json(
          { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
          401,
        );
      if (!chain)
        return c.json(
          {
            code: "CHAIN_UNAVAILABLE",
            message: "Testnet contract is not configured",
          },
          503,
        );
      const parsed = MediaProposalRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success || !validMediaLink(parsed.data.link))
        return c.json(
          {
            code: "INVALID_LINK",
            message:
              "Use a valid HTTPS link without a port or sign-in details, or leave it blank",
          },
          400,
        );
      const upload = store.upload(parsed.data.uploadId);
      if (!upload || upload.accountId !== accountId)
        return c.json({ code: "NOT_FOUND", message: "Upload not found" }, 404);
      let plot;
      try {
        plot = await chain.plot(upload.plotId);
      } catch {
        return c.json(
          { code: "CHAIN_UNAVAILABLE", message: "Could not check the plot" },
          503,
        );
      }
      if (
        !plot ||
        plot.plot.owner !== accountId ||
        plot.plot.building.layout_revision !== upload.layoutRevision
      )
        return c.json(
          {
            code: "PLOT_CHANGED",
            message: "The building changed; upload again",
          },
          409,
        );
      const slot =
        upload.kind === "Logo" ? plot.plot.logo : plot.plot.billboard;
      if (
        slot.active?.content.asset_hash === upload.hash &&
        slot.active.content.link === parsed.data.link &&
        slot.active.approved_layout_revision === upload.layoutRevision
      )
        return c.json(
          {
            code: "ALREADY_ACTIVE",
            message: "This image and link are already active",
          },
          409,
        );
      const proposed = store.createOrReuseMediaProposal(
        {
          uploadId: upload.id,
          accountId,
          plotId: upload.plotId,
          kind: upload.kind,
          assetHash: upload.hash,
          link: parsed.data.link,
          buildingType: plot.plot.building.building_type,
          level: plot.plot.building.level,
          layoutRevision: upload.layoutRevision,
          expectedMediaRevision: slot.revision,
          createdAt: clock(),
        },
        clock() - UPLOAD_WINDOW_SECONDS,
        MAX_MEDIA_PROPOSALS_PER_UPLOAD,
        MAX_MEDIA_PROPOSALS_PER_ACCOUNT,
        MAX_UNRESOLVED_MEDIA_PROPOSALS_PER_SLOT,
      );
      if ("limit" in proposed)
        return c.json(
          {
            code: "RATE_LIMITED",
            message:
              proposed.limit === "slot"
                ? "This logo or billboard has three proposals waiting; submit one before preparing another"
                : proposed.limit === "upload"
                  ? "This image has too many proposals today; try again tomorrow"
                  : "Too many media proposals today; try again tomorrow",
          },
          429,
        );
      c.header("Cache-Control", "no-store");
      return c.json(
        mediaResponse(proposed.record, store),
        proposed.created ? 201 : 200,
      );
    },
  );

  app.get("/media/proposals/latest", async (c) => {
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    const plotId = PLOT_ID.safeParse(c.req.query("plot_id"));
    const kind = MediaKind.safeParse(c.req.query("kind"));
    if (!plotId.success || !kind.success)
      return c.json(
        { code: "INVALID_REQUEST", message: "Choose a plot and media kind" },
        400,
      );
    let record = store.latestMediaProposal(accountId, plotId.data, kind.data);
    if (record?.status === "submitted")
      record = await reconcileMediaDecision(record).catch(() => record);
    else if (record?.status === "approved")
      record = await reconcileMediaRevocation(record).catch(() => record);
    if (!record)
      return c.json(
        { code: "NOT_FOUND", message: "No media proposal found" },
        404,
      );
    c.header("Cache-Control", "no-store");
    return c.json(mediaResponse(record, store));
  });

  app.get("/media/proposals/:id", async (c) => {
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    const id = CHALLENGE_ID.safeParse(c.req.param("id"));
    const found = id.success ? store.mediaProposal(id.data) : null;
    if (!found || found.accountId !== accountId)
      return c.json(
        { code: "NOT_FOUND", message: "Media proposal not found" },
        404,
      );
    let record: MediaProposalRecord = found;
    if (record.status === "submitted")
      record = await reconcileMediaDecision(record).catch(() => record);
    else if (record.status === "approved")
      record = await reconcileMediaRevocation(record).catch(() => record);
    c.header("Cache-Control", "no-store");
    return c.json(mediaResponse(record, store));
  });

  app.post("/media/proposals/:id/reconcile", async (c) => {
    const accountId = currentAccount(c.req.header("cookie"));
    if (!accountId)
      return c.json(
        { code: "UNAUTHENTICATED", message: "Sign in with your wallet" },
        401,
      );
    if (!chain)
      return c.json(
        {
          code: "CHAIN_UNAVAILABLE",
          message: "Testnet contract is not configured",
        },
        503,
      );
    const id = CHALLENGE_ID.safeParse(c.req.param("id"));
    const record = id.success ? store.mediaProposal(id.data) : null;
    if (!record || record.accountId !== accountId)
      return c.json(
        { code: "NOT_FOUND", message: "Media proposal not found" },
        404,
      );
    if (record.status !== "selected" && record.status !== "submitted")
      return c.json(
        {
          code: "ALREADY_DECIDED",
          message: "Media proposal is already decided",
        },
        409,
      );
    let plot;
    try {
      plot = await chain.plot(record.plotId);
    } catch {
      return c.json(
        { code: "CHAIN_UNAVAILABLE", message: "Could not check the proposal" },
        503,
      );
    }
    const slot =
      record.kind === "Logo" ? plot?.plot.logo : plot?.plot.billboard;
    const pending = slot?.pending;
    if (
      plot?.plot.owner !== accountId ||
      !pending ||
      pending.revision !== record.expectedMediaRevision + 1 ||
      pending.revision !== slot?.revision ||
      pending.owner !== accountId ||
      pending.building_type !== record.buildingType ||
      pending.level !== record.level ||
      pending.layout_revision !== record.layoutRevision ||
      pending.content.asset_hash !== record.assetHash ||
      pending.content.link !== record.link
    )
      return c.json(
        {
          code: "PROPOSAL_NOT_FOUND",
          message: "The exact media proposal is not confirmed on-chain",
        },
        409,
      );
    const submitted = store.markMediaSubmitted(record.id, pending.revision);
    c.header("Cache-Control", "no-store");
    return c.json(mediaResponse(submitted, store));
  });

  app.get("/assets/:hash", async (c) => {
    const assetHash = HASH.safeParse(c.req.param("hash"));
    if (!assetHash.success)
      return c.json({ code: "NOT_FOUND", message: "Asset not found" }, 404);
    const accountId = currentAccount(c.req.header("cookie"));
    if (
      !store.canReadAsset(assetHash.data, accountId) &&
      !paidLedger?.canReadCandidateAsset(assetHash.data, accountId)
    )
      return c.json({ code: "NOT_FOUND", message: "Asset not found" }, 404);
    let bytes: Buffer;
    try {
      bytes = await readFile(join(store.assetDir, `${assetHash.data}.png`));
    } catch {
      return c.json({ code: "NOT_FOUND", message: "Asset not found" }, 404);
    }
    if (hash(bytes) !== assetHash.data) {
      c.header("Cache-Control", "no-store");
      return c.json(
        { code: "ASSET_CORRUPT", message: "Stored image hash does not match" },
        503,
      );
    }
    c.header("Content-Type", "image/png");
    c.header("Content-Length", String(bytes.length));
    c.header(
      "Cache-Control",
      store.isPublicAsset(assetHash.data)
        ? "public, max-age=31536000, immutable"
        : "private, no-store",
    );
    c.header("ETag", `"${assetHash.data}"`);
    return c.body(new Uint8Array(bytes));
  });

  app.notFound((c) =>
    c.json({ code: "NOT_FOUND", message: "Route not found" }, 404),
  );
  return app;
}
