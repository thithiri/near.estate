import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { KeyPair } from "@near-js/crypto";
import { serializeNep413 } from "@near-wallet-selector/core";
import type { ChainAppearanceReference, ChainMediaSlot } from "@estate/shared";
import { variableFrontageMediaLayout } from "@estate/shared";
import sharp from "sharp";
import { checkedFacadeCandidate, createApiApp } from "./app.js";
import { sweepPrivateAssets } from "./asset-retention.js";
import { saveImmutablePng } from "./asset-storage.js";
import type { ChainGateway } from "./chain.js";
import { renderMockCandidate } from "./mock-art.js";
import { buildGenerationPrompt } from "./prompt-builder.js";
import { readImageGenerationSettings } from "./image-generation-settings.js";
import { PaidGenerationLedger } from "./paid-generation-ledger.js";
import { processPaidImageResult } from "./paid-image-processing.js";
import type { ModeratorGateway } from "./moderator.js";
import { ApiStore } from "./store.js";
import { normalizeVariableGeneratedFacade } from "./variable-generated-art.js";
import { buildVariableGenerationPrompt } from "./variable-prompt-builder.js";

const ORIGIN = "http://localhost:8080";
const ACCOUNT = "owner.testnet";
const PLOT = "plot-main-n-0";
const emptyMediaSlot = {
  revision: 0,
  active: null,
  pending: null,
  last_decision: null,
  last_replacement_at: null,
};

test("version-2 candidate stays bound to the prompt width and design", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-variable-job-"));
  const databasePath = join(dir, "estate.sqlite");
  let store = new ApiStore(databasePath, join(dir, "assets"));
  try {
    const source = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/public/guest-buildings/diner-l2.png",
          import.meta.url,
        ),
      ),
    );
    const art = await normalizeVariableGeneratedFacade(source, {
      frontageUnits: 2,
      designChoice: 1,
      buildingType: "Cafe",
      level: 2,
    });
    await Promise.all([
      saveImmutablePng(store.assetDir, art.spriteHash, art.sprite),
      saveImmutablePng(store.assetDir, art.thumbnailHash, art.thumbnail),
    ]);
    const promptSpec = buildVariableGenerationPrompt({
      frontageUnits: 2,
      designChoice: 1,
      buildingType: "Cafe",
      level: 2,
      palette: "#EF8270",
      description: "A bright diner",
    });
    const job = store.createGeneration({
      accountId: ACCOUNT,
      plotId: PLOT,
      buildingType: "Cafe",
      level: 2,
      layoutRevision: 4,
      appearanceRevision: 5,
      description: "A bright diner",
      promptSpec,
      candidates: [
        {
          id: 1,
          variant: 1,
          palette: "#EF8270",
          manifest: art.manifest,
          manifestHash: art.manifestHash,
          spriteHash: art.spriteHash,
          thumbnailHash: art.thumbnailHash,
        },
      ],
      createdAt: 1_000,
    });
    assert.deepEqual(
      await checkedFacadeCandidate(store, job, job.candidates[0]!),
      art.thumbnail,
    );
    await assert.rejects(
      checkedFacadeCandidate(
        store,
        {
          ...job,
          promptSpec: { ...promptSpec, designChoice: 2 },
        },
        job.candidates[0]!,
      ),
      /prompt snapshot/,
    );
    store.close();
    store = new ApiStore(databasePath, join(dir, "assets"));
    const restored = store.generation(job.id);
    assert.ok(restored);
    assert.equal(restored.promptSpec?.version, 5);
    assert.deepEqual(
      await checkedFacadeCandidate(store, restored, restored.candidates[0]!),
      art.thumbnail,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("version-2 selection and moderator approval keep the exact design", async () => {
  const context = await setup();
  try {
    context.setVariableDesign(2, 1);
    context.setBuildingLevel(2);
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const source = await readFile(
      fileURLToPath(
        new URL(
          "../../../apps/web/public/guest-buildings/diner-l2.png",
          import.meta.url,
        ),
      ),
    );
    const art = await normalizeVariableGeneratedFacade(source, {
      frontageUnits: 2,
      designChoice: 1,
      buildingType: "Retail",
      level: 2,
    });
    await Promise.all([
      saveImmutablePng(context.store.assetDir, art.spriteHash, art.sprite),
      saveImmutablePng(
        context.store.assetDir,
        art.thumbnailHash,
        art.thumbnail,
      ),
    ]);
    const job = context.store.createGeneration({
      accountId: ACCOUNT,
      plotId: PLOT,
      buildingType: "Retail",
      level: 2,
      layoutRevision: 1,
      appearanceRevision: 1,
      description: "A bright diner",
      promptSpec: buildVariableGenerationPrompt({
        frontageUnits: 2,
        designChoice: 1,
        buildingType: "Retail",
        level: 2,
        palette: "#EF8270",
        description: "A bright diner",
      }),
      candidates: [
        {
          id: 1,
          variant: 1,
          palette: "#EF8270",
          manifest: art.manifest,
          manifestHash: art.manifestHash,
          spriteHash: art.spriteHash,
          thumbnailHash: art.thumbnailHash,
        },
      ],
      createdAt: 1_000,
    });
    context.setVariableDesign(2, 2);
    const wrongDesign = await context.postJson(
      `/generations/${job.id}/select`,
      { candidateId: 1 },
      cookie,
    );
    assert.equal(wrongDesign.status, 409);
    context.setVariableDesign(2, 1);
    const selected = await context.postJson(
      `/generations/${job.id}/select`,
      { candidateId: 1 },
      cookie,
    );
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).manifestHash, art.manifestHash);
    context.setAppearanceRevision(2);
    context.setPendingAppearance({
      revision: 2,
      owner: ACCOUNT,
      building_type: "Retail",
      level: 2,
      manifest_hash: art.manifestHash,
    });
    const reconciled = await context.app.request(
      `/generations/${job.id}/reconcile`,
      { method: "POST", headers: { origin: ORIGIN, cookie } },
    );
    assert.equal(reconciled.status, 200);
    assert.equal((await reconciled.json()).status, "submitted");
    const reviewPath = `/moderation/generations/${job.id}/approve`;
    const reviewHeaders = {
      origin: ORIGIN,
      authorization: `Basic ${Buffer.from("reviewer:test-only-password").toString("base64")}`,
    };
    const reviewPage = await context.app.request("/moderation", {
      headers: reviewHeaders,
    });
    assert.equal(reviewPage.status, 200);
    const reviewHtml = await reviewPage.text();
    assert.match(reviewHtml, /width="170" height="190"/);
    assert.match(reviewHtml, /2 unit frontage · design 2/);
    context.setVariableDesign(2, 2);
    assert.equal(
      (
        await context.app.request(reviewPath, {
          method: "POST",
          headers: reviewHeaders,
        })
      ).status,
      409,
    );
    context.setVariableDesign(2, 1);
    const approved = await context.app.request(reviewPath, {
      method: "POST",
      headers: reviewHeaders,
    });
    assert.equal(approved.status, 303);
    assert.equal(context.store.generation(job.id)?.status, "approved");
    const published = await context.app.request(
      `/manifests/${art.manifestHash}`,
    );
    assert.equal(published.status, 200);
    assert.equal((await published.json()).schemaVersion, 2);
  } finally {
    await context.close();
  }
});

test("API stops serving a stale city after the contract version changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-city-guard-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  let now = 1_000;
  let version: 1 | 2 = 1;
  let reads = 0;
  try {
    const app = createApiApp({
      store,
      chain: null,
      appOrigin: ORIGIN,
      clock: () => now,
      cityVersionReader: async () => {
        reads++;
        return version;
      },
    });
    const current = await app.request("/city");
    assert.equal(current.status, 200);
    assert.equal(current.headers.get("cache-control"), "no-store");
    assert.equal(reads, 1);
    now += 29;
    assert.equal((await app.request("/city")).status, 200);
    assert.equal(reads, 1);
    version = 2;
    now += 1;
    const changed = await app.request("/city");
    assert.equal(changed.status, 503);
    assert.equal((await changed.json()).code, "CITY_VERSION_CHANGED");
    assert.equal(
      (
        await app.request("/impressions/session", {
          method: "POST",
          headers: { origin: ORIGIN },
        })
      ).status,
      503,
    );
    version = 1;
    assert.equal((await app.request("/health")).status, 503);
    assert.equal(reads, 2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("API retries a failed city version check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-city-guard-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  let unavailable = true;
  try {
    const app = createApiApp({
      store,
      chain: null,
      appOrigin: ORIGIN,
      cityVersionReader: async () => {
        if (unavailable) throw new Error("RPC unavailable");
        return 1;
      },
    });
    const failed = await app.request("/city");
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).code, "CITY_VERSION_UNAVAILABLE");
    unavailable = false;
    assert.equal((await app.request("/city")).status, 200);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup(
  paid = false,
  impressionIntake?: { enabled: boolean; acceptAfterMs: number },
) {
  const dir = await mkdtemp(join(tmpdir(), "estate-api-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const paidSettings = paid
    ? readImageGenerationSettings({
        IMAGE_GENERATION_ENABLED: "true",
        IMAGE_GENERATION_INVITES: ACCOUNT,
        IMAGE_GENERATION_DAILY_BUDGET_USD_MICROS: "4000000",
        IMAGE_GENERATION_MAX_COST_PER_CALL_USD_MICROS: "1000000",
        IMAGE_GENERATION_TIMEOUT_MS: "120000",
        IMAGE_GENERATION_SAFETY_SECRET:
          "test-secret-with-at-least-thirty-two-bytes",
        OPENAI_API_KEY: "test-api-key",
        OPENAI_IMAGE_MODEL: "gpt-image-2.5-flare-2026-09-08",
      })
    : null;
  const paidLedger = paidSettings?.enabled
    ? new PaidGenerationLedger(store.db, paidSettings)
    : null;
  let now = 1_000;
  let activeKey = true;
  let keyLookupFails = false;
  let moderatorKeyReady = true;
  let plotOwner: string | null = ACCOUNT;
  let layoutRevision = 1;
  let buildingLevel = 1;
  let variableDesign: { units: 1 | 2 | 3; choice: number } | null = null;
  let appearanceRevision = 1;
  let pendingAppearance: ChainAppearanceReference | null = null;
  let approvedManifestHash: string | null = null;
  let lastAppearanceDecision: {
    reference: ChainAppearanceReference;
    status: "Approved" | "Rejected" | "Revoked";
    decided_at: number;
    reason: string | null;
  } | null = null;
  let logoSlot: ChainMediaSlot = structuredClone(emptyMediaSlot);
  let billboardSlot: ChainMediaSlot = structuredClone(emptyMediaSlot);
  let logoEligible = false;
  let billboardEligible = false;
  let plotReadCount = 0;
  let flipLayoutOnSecondRead = false;
  let neighborEnabled = false;
  const chain: ChainGateway = {
    async hasAccessKey() {
      if (keyLookupFails) throw new Error("Test RPC unavailable");
      return activeKey;
    },
    async plot(plotId) {
      const isNeighbor = neighborEnabled && plotId === "plot-main-n-1";
      if (plotId !== PLOT && !isNeighbor) return null;
      if (!isNeighbor) {
        plotReadCount++;
        if (flipLayoutOnSecondRead && plotReadCount === 2) layoutRevision++;
      }
      return {
        plot: {
          id: plotId,
          road_id: "main",
          side: "North",
          index: isNeighbor ? 1 : 0,
          ...(variableDesign && !isNeighbor
            ? {
                frontage_units: variableDesign.units,
                design_choice: variableDesign.choice,
              }
            : {}),
          corner: !isNeighbor,
          owner: isNeighbor ? null : plotOwner,
          rule: { kind: "Free" },
          pending_rule: null,
          building: {
            building_type: isNeighbor ? "Cafe" : "Retail",
            variant: isNeighbor ? 2 : 1,
            level: isNeighbor ? 2 : buildingLevel,
            primary_color: isNeighbor ? "#73D9A6" : "#F6C85F",
            name: isNeighbor ? "Neighbour cafe" : "Plot 1",
            approved_manifest_hash: approvedManifestHash,
            approved_at: null,
            last_facade_approved_at: null,
            pending_appearance: pendingAppearance,
            last_appearance_decision: lastAppearanceDecision,
            facade_exemption_level: null,
            appearance_revision: appearanceRevision,
            layout_revision: layoutRevision,
          },
          logo: logoSlot,
          billboard: billboardSlot,
          ticket_cooldown_until: 0,
          reserved_storage_bytes: 4096,
          used_storage_bytes: 0,
        },
        effective_rule: { kind: "Free" },
        logo_eligible: logoEligible,
        billboard_eligible: billboardEligible,
      };
    },
  };
  const moderator: ModeratorGateway = {
    async checkAuthorization() {
      if (!moderatorKeyReady) throw new Error("restricted key unavailable");
    },
    async approveAppearance(plotId, expected) {
      assert.equal(plotId, PLOT);
      assert.deepEqual(pendingAppearance, expected);
      pendingAppearance = null;
      approvedManifestHash = expected.manifest_hash;
      lastAppearanceDecision = {
        reference: expected,
        status: "Approved",
        decided_at: now,
        reason: null,
      };
      layoutRevision++;
    },
    async rejectAppearance(plotId, expected, reason) {
      assert.equal(plotId, PLOT);
      assert.deepEqual(pendingAppearance, expected);
      pendingAppearance = null;
      lastAppearanceDecision = {
        reference: expected,
        status: "Rejected",
        decided_at: now,
        reason,
      };
    },
    async revokeAppearance(
      plotId,
      expectedRevision,
      expectedManifestHash,
      reason,
    ) {
      assert.equal(plotId, PLOT);
      assert.equal(appearanceRevision, expectedRevision);
      assert.equal(approvedManifestHash, expectedManifestHash);
      appearanceRevision++;
      approvedManifestHash = null;
      pendingAppearance = null;
      lastAppearanceDecision = {
        reference: {
          revision: appearanceRevision,
          owner: ACCOUNT,
          building_type: "Retail",
          level: 1,
          manifest_hash: expectedManifestHash,
        },
        status: "Revoked",
        decided_at: now,
        reason,
      };
      layoutRevision++;
    },
    async approveMedia(plotId, kind, expected) {
      assert.equal(plotId, PLOT);
      const slot = kind === "Logo" ? logoSlot : billboardSlot;
      assert.deepEqual(slot.pending, expected);
      const next: ChainMediaSlot = {
        ...slot,
        active: {
          content: expected.content,
          approved_layout_revision: expected.layout_revision,
          approved_at: now,
        },
        pending: null,
        last_decision: {
          proposal: expected,
          status: "Approved",
          decided_at: now,
          reason: null,
        },
        last_replacement_at: now,
      };
      if (kind === "Logo") logoSlot = next;
      else billboardSlot = next;
    },
    async rejectMedia(plotId, kind, expected, reason) {
      assert.equal(plotId, PLOT);
      const slot = kind === "Logo" ? logoSlot : billboardSlot;
      assert.deepEqual(slot.pending, expected);
      const next: ChainMediaSlot = {
        ...slot,
        pending: null,
        last_decision: {
          proposal: expected,
          status: "Rejected",
          decided_at: now,
          reason,
        },
      };
      if (kind === "Logo") logoSlot = next;
      else billboardSlot = next;
    },
    async revokeMedia(plotId, kind, expectedRevision, expectedContent, reason) {
      assert.equal(plotId, PLOT);
      const slot = kind === "Logo" ? logoSlot : billboardSlot;
      assert.equal(slot.revision, expectedRevision);
      assert.deepEqual(slot.active?.content, expectedContent);
      const next: ChainMediaSlot = {
        ...slot,
        revision: slot.revision + 1,
        active: null,
        pending: null,
        last_decision: {
          proposal: {
            revision: slot.revision + 1,
            owner: ACCOUNT,
            building_type: "Retail",
            level: 1,
            layout_revision: layoutRevision,
            content: expectedContent,
          },
          status: "Revoked",
          decided_at: now,
          reason,
        },
      };
      if (kind === "Logo") logoSlot = next;
      else billboardSlot = next;
    },
  };
  const app = createApiApp({
    store,
    chain,
    appOrigin: ORIGIN,
    clock: () => now,
    moderator,
    paidLedger,
    impressionIntake,
    adminCredentials: { user: "reviewer", password: "test-only-password" },
  });
  const pair = KeyPair.fromRandom("ed25519");
  const postJson = (path: string, value: unknown, cookie?: string) =>
    app.request(path, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(value),
    });
  async function signIn(includeCallbackUrl = true) {
    const challengeResponse = await postJson("/auth/challenge", {
      accountId: ACCOUNT,
    });
    assert.equal(challengeResponse.status, 200);
    const challenge = await challengeResponse.json();
    const nonce = Buffer.from(challenge.nonce, "base64");
    const payload = serializeNep413({
      message: challenge.message,
      nonce,
      recipient: challenge.recipient,
      ...(includeCallbackUrl ? { callbackUrl: challenge.callbackUrl } : {}),
    });
    const digest = createHash("sha256").update(payload).digest();
    const signature = Buffer.from(pair.sign(digest).signature).toString(
      "base64",
    );
    const signedMessage = {
      accountId: ACCOUNT,
      publicKey: pair.getPublicKey().toString(),
      signature,
      state: challenge.challengeId,
    };
    const verified = await postJson("/auth/verify", {
      challengeId: challenge.challengeId,
      signedMessage,
    });
    return { challenge, signedMessage, verified };
  }
  return {
    app,
    store,
    paidLedger,
    postJson,
    signIn,
    setNow(value: number) {
      now = value;
    },
    setActiveKey(value: boolean) {
      activeKey = value;
    },
    setKeyLookupFails(value: boolean) {
      keyLookupFails = value;
    },
    setModeratorKeyReady(value: boolean) {
      moderatorKeyReady = value;
    },
    setOwner(value: string | null) {
      plotOwner = value;
    },
    setLayoutRevision(value: number) {
      layoutRevision = value;
    },
    setBuildingLevel(value: number) {
      buildingLevel = value;
    },
    setVariableDesign(units: 1 | 2 | 3, choice: number) {
      variableDesign = { units, choice };
    },
    setAppearanceRevision(value: number) {
      appearanceRevision = value;
    },
    setPendingAppearance(value: typeof pendingAppearance) {
      pendingAppearance = value;
    },
    setMediaSlot(kind: "Logo" | "Billboard", value: ChainMediaSlot) {
      if (kind === "Logo") logoSlot = value;
      else billboardSlot = value;
    },
    setMediaEligibility(kind: "Logo" | "Billboard", eligible: boolean) {
      if (kind === "Logo") logoEligible = eligible;
      else billboardEligible = eligible;
    },
    setNeighborEnabled(value: boolean) {
      neighborEnabled = value;
    },
    flipLayoutOnSecondRead() {
      flipLayoutOnSecondRead = true;
      plotReadCount = 0;
    },
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("migration pause stops impression sessions and batch writes", async () => {
  const context = await setup(false, { enabled: false, acceptAfterMs: 0 });
  try {
    const session = await context.app.request("/impressions/session", {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    assert.equal(session.status, 503);
    assert.equal((await session.json()).code, "IMPRESSION_INTAKE_PAUSED");
    const batch = await context.postJson("/impressions", { events: [] });
    assert.equal(batch.status, 503);
    assert.equal((await batch.json()).code, "IMPRESSION_INTAKE_PAUSED");
    assert.equal(
      (
        context.store.db
          .prepare("SELECT COUNT(*) AS count FROM impression_sessions")
          .get() as { count: number }
      ).count,
      0,
    );
  } finally {
    await context.close();
  }
});

test("impression cutover rejects old views and accepts new ones", async () => {
  const context = await setup(false, {
    enabled: true,
    acceptAfterMs: 999_500,
  });
  try {
    context.setMediaEligibility("Logo", true);
    const session = await context.app.request("/impressions/session", {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    assert.equal(session.status, 200);
    const cookie = session.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    const old = await context.postJson(
      "/impressions",
      {
        events: [
          {
            eventId: "11111111-1111-4111-8111-111111111111",
            plotId: PLOT,
            surface: "Logo",
            observedAt: 1_000_000,
            msVisible: 1_200,
          },
        ],
      },
      cookie,
    );
    assert.equal(old.status, 409);
    assert.deepEqual(await old.json(), {
      code: "IMPRESSION_BEFORE_CUTOVER",
      message: "Discard views from before the city reopened",
      acceptAfterMs: 999_500,
    });
    context.setNow(1_001);
    const current = await context.postJson(
      "/impressions",
      {
        events: [
          {
            eventId: "22222222-2222-4222-8222-222222222222",
            plotId: PLOT,
            surface: "Logo",
            observedAt: 1_001_000,
            msVisible: 1_200,
          },
        ],
      },
      cookie,
    );
    assert.equal(current.status, 200);
    assert.equal(
      (
        context.store.db
          .prepare("SELECT COUNT(*) AS count FROM impression_events")
          .get() as { count: number }
      ).count,
      1,
    );
  } finally {
    await context.close();
  }
});

test("published version-2 manifest and full-size sprite are readable", async () => {
  const context = await setup();
  try {
    const building = await sharp({
      create: {
        width: 656,
        height: 640,
        channels: 4,
        background: "#ae6350",
      },
    })
      .png()
      .toBuffer();
    const source = await sharp({
      create: {
        width: 680,
        height: 760,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: building, left: 12, top: 120 }])
      .png()
      .toBuffer();
    const candidate = await normalizeVariableGeneratedFacade(source, {
      frontageUnits: 2,
      designChoice: 1,
      buildingType: "Retail",
      level: 4,
    });
    await Promise.all([
      saveImmutablePng(
        context.store.assetDir,
        candidate.spriteHash,
        candidate.sprite,
      ),
      saveImmutablePng(
        context.store.assetDir,
        candidate.thumbnailHash,
        candidate.thumbnail,
      ),
    ]);
    const job = context.store.createGeneration({
      accountId: ACCOUNT,
      plotId: PLOT,
      buildingType: "Retail",
      level: 4,
      layoutRevision: 1,
      appearanceRevision: 1,
      description: "Local variable facade fixture",
      candidates: [
        {
          id: 1,
          variant: 1,
          palette: "#F6C85F",
          manifest: candidate.manifest,
          manifestHash: candidate.manifestHash,
          spriteHash: candidate.spriteHash,
          thumbnailHash: candidate.thumbnailHash,
        },
      ],
      createdAt: 1_000,
    });
    assert(context.store.selectGeneration(job.id, ACCOUNT, 1));
    context.store.markGenerationSubmitted(job.id, 2);
    context.store.markGenerationDecided(job.id, "approved", 1_001, null);
    const manifestResponse = await context.app.request(
      `/manifests/${candidate.manifestHash}`,
    );
    assert.equal(manifestResponse.status, 200);
    assert.deepEqual(await manifestResponse.json(), candidate.manifest);
    const assetResponse = await context.app.request(
      `/assets/${candidate.spriteHash}`,
    );
    assert.equal(assetResponse.status, 200);
    assert.deepEqual(
      Buffer.from(await assetResponse.arrayBuffer()),
      candidate.sprite,
    );
  } finally {
    await context.close();
  }
});

test("variable-width paid request reserves its fixed-shape prompt while legacy preview stays closed", async () => {
  const context = await setup(true);
  try {
    const signedIn = await context.signIn();
    assert.equal(signedIn.verified.status, 200);
    const cookie = signedIn.verified.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    context.setVariableDesign(2, 1);
    const request = {
      plotId: PLOT,
      description: "A small roof garden",
      palette: "#F6C85F",
    };
    const legacy = await context.postJson("/generations", request, cookie);
    assert.equal(legacy.status, 409);
    assert.equal((await legacy.json()).code, "UNSUPPORTED_CITY_VERSION");
    const paid = await context.app.request("/paid-generations", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        cookie,
        "idempotency-key": "variable-city-test-001",
      },
      body: JSON.stringify(request),
    });
    assert.equal(paid.status, 202);
    const queued = await paid.json();
    assert.equal(queued.status, "queued");
    const snapshot = context.paidLedger?.job(queued.id)?.snapshot;
    assert.equal(snapshot?.promptSpec.version, 5);
    if (snapshot?.promptSpec.version === 5) {
      assert.equal(snapshot.promptSpec.frontageUnits, 2);
      assert.equal(snapshot.promptSpec.designChoice, 1);
      assert.equal(snapshot.promptSpec.description, request.description);
    }
    const replay = await context.app.request("/paid-generations", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        cookie,
        "idempotency-key": "variable-city-test-001",
      },
      body: JSON.stringify(request),
    });
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).id, queued.id);
  } finally {
    await context.close();
  }
});

test("an owner can reuse only their intact approved image after a layout change", async () => {
  const context = await setup();
  try {
    const signedIn = await context.signIn();
    assert.equal(signedIn.verified.status, 200);
    const cookie = signedIn.verified.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    const png = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 4,
        background: "#73D9A6",
      },
    })
      .png()
      .toBuffer();
    const assetHash = createHash("sha256").update(png).digest("hex");
    await saveImmutablePng(context.store.assetDir, assetHash, png);
    context.setMediaSlot("Logo", {
      ...emptyMediaSlot,
      revision: 1,
      active: {
        content: { asset_hash: assetHash, link: "https://near.org" },
        approved_layout_revision: 1,
        approved_at: 1000,
      },
    });
    const request = { plotId: PLOT, kind: "Logo" };
    assert.equal(
      (await context.postJson("/media/uploads/reuse", request)).status,
      401,
    );
    assert.equal(
      (await context.postJson("/media/uploads/reuse", request, cookie)).status,
      409,
    );
    context.setLayoutRevision(2);
    context.setOwner("another.testnet");
    assert.equal(
      (await context.postJson("/media/uploads/reuse", request, cookie)).status,
      403,
    );
    context.setOwner(ACCOUNT);
    const reused = await context.postJson(
      "/media/uploads/reuse",
      request,
      cookie,
    );
    assert.equal(reused.status, 200);
    const upload = (await reused.json()) as {
      uploadId: string;
      hash: string;
      layoutRevision: number;
    };
    assert.equal(upload.hash, assetHash);
    assert.equal(upload.layoutRevision, 2);
    assert.equal(context.store.upload(upload.uploadId)?.accountId, ACCOUNT);
    const repeated = await context.postJson(
      "/media/uploads/reuse",
      request,
      cookie,
    );
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).uploadId, upload.uploadId);
    const proposal = await context.postJson(
      "/media/proposals",
      { uploadId: upload.uploadId, link: "https://near.org" },
      cookie,
    );
    assert.equal(proposal.status, 201);
    assert.equal((await proposal.json()).assetHash, assetHash);
    context.setLayoutRevision(3);
    context.flipLayoutOnSecondRead();
    assert.equal(
      (await context.postJson("/media/uploads/reuse", request, cookie)).status,
      409,
    );
    assert.equal(
      context.store.latestUpload(ACCOUNT, PLOT, "Logo")?.id,
      upload.uploadId,
    );
    context.setLayoutRevision(3);
    await writeFile(
      join(context.store.assetDir, `${assetHash}.png`),
      "corrupt",
    );
    assert.equal(
      (await context.postJson("/media/uploads/reuse", request, cookie)).status,
      503,
    );
    assert.equal(
      context.store.latestUpload(ACCOUNT, PLOT, "Logo")?.id,
      upload.uploadId,
    );
  } finally {
    await context.close();
  }
});

test("moderator status checks the live restricted key behind Basic auth", async () => {
  const context = await setup();
  try {
    const path = "/moderation/status";
    const admin = `Basic ${Buffer.from("reviewer:test-only-password").toString("base64")}`;
    assert.equal((await context.app.request(path)).status, 401);
    const ready = await context.app.request(path, {
      headers: { authorization: admin },
    });
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ok", role: "moderator" });
    assert.equal(ready.headers.get("cache-control"), "no-store");
    context.setModeratorKeyReady(false);
    const unavailable = await context.app.request(path, {
      headers: { authorization: admin },
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      code: "MODERATOR_KEY_UNAVAILABLE",
      message: "Moderator role or restricted key is unavailable",
    });
    assert.equal((await context.app.request("/health")).status, 200);
  } finally {
    await context.close();
  }
});

test("wallet challenge is one-use, account-bound, and session can be revoked", async () => {
  const context = await setup();
  try {
    const { challenge, signedMessage, verified } = await context.signIn();
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    assert.match(cookie, /^estate_session=/);
    const me = await context.app.request("/auth/me", { headers: { cookie } });
    assert.equal((await me.json()).accountId, ACCOUNT);
    const replay = await context.postJson("/auth/verify", {
      challengeId: challenge.challengeId,
      signedMessage,
    });
    assert.equal(replay.status, 409);
    const wrongOrigin = await context.app.request("/auth/challenge", {
      method: "POST",
      headers: {
        origin: "https://other.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ accountId: ACCOUNT }),
    });
    assert.equal(wrongOrigin.status, 403);
    for (const accountId of [
      `${"a".repeat(57)}.testnet`,
      "bad..name.testnet",
      "-bad.testnet",
    ]) {
      const invalidAccount = await context.postJson("/auth/challenge", {
        accountId,
      });
      assert.equal(invalidAccount.status, 400);
    }
    const maximumLength = await context.postJson("/auth/challenge", {
      accountId: `${"a".repeat(56)}.testnet`,
    });
    assert.equal(maximumLength.status, 200);
    const logout = await context.postJson("/auth/logout", {}, cookie);
    assert.equal(logout.status, 200);
    assert.equal(
      (await context.app.request("/auth/me", { headers: { cookie } })).status,
      401,
    );
  } finally {
    await context.close();
  }
});

test("artwork session stops authorizing writes when its wallet key is revoked", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    context.setKeyLookupFails(true);
    assert.equal(
      (
        await context.app.request("/paid-generations/status", {
          headers: { cookie },
        })
      ).status,
      200,
      "public service status remains available during an RPC outage",
    );
    assert.equal(
      (await context.app.request("/auth/me", { headers: { cookie } })).status,
      503,
    );
    assert.equal(
      (
        context.store.db
          .prepare("SELECT COUNT(*) AS count FROM auth_sessions")
          .get() as { count: number }
      ).count,
      1,
      "a temporary RPC failure keeps the session for a retry",
    );
    context.setKeyLookupFails(false);
    assert.equal(
      (await context.app.request("/auth/me", { headers: { cookie } })).status,
      200,
    );
    context.setActiveKey(false);
    const blocked = await context.postJson(
      "/generations",
      {
        plotId: PLOT,
        description: "Should not be created",
        palette: "#73D9A6",
      },
      cookie,
    );
    assert.equal(blocked.status, 401);
    assert.equal((await blocked.json()).code, "KEY_REVOKED");
    assert.equal(
      (
        context.store.db
          .prepare("SELECT COUNT(*) AS count FROM auth_sessions")
          .get() as { count: number }
      ).count,
      0,
    );
    context.setActiveKey(true);
    assert.equal(
      (await context.app.request("/auth/me", { headers: { cookie } })).status,
      401,
    );
  } finally {
    await context.close();
  }
});

test("legacy artwork sessions expire when key-bound sessions are added", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-session-migration-"));
  const dbPath = join(dir, "estate.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT`);
  legacy
    .prepare(
      "INSERT INTO auth_sessions(token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .run("legacy-token", ACCOUNT, 1_000, 44_200);
  legacy.close();
  const store = new ApiStore(dbPath, join(dir, "assets"));
  try {
    assert.equal(store.sessionIdentity("legacy-token", 1_001), null);
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM auth_sessions")
          .get() as { count: number }
      ).count,
      0,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("challenge issuance is bounded across accounts and prunes expired authentication records", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    assert.equal(verified.status, 200);
    for (let index = 0; index < 299; index++) {
      const response = await context.postJson("/auth/challenge", {
        accountId: `driver${index}.testnet`,
      });
      assert.equal(response.status, 200, `challenge ${index}`);
    }
    const limited = await context.postJson("/auth/challenge", {
      accountId: "another.testnet",
    });
    assert.equal(limited.status, 429);
    assert.equal(
      (
        context.store.db
          .prepare("SELECT COUNT(*) AS count FROM auth_challenges")
          .get() as { count: number }
      ).count,
      300,
    );
    context.setNow(1_301);
    const afterExpiry = await context.postJson("/auth/challenge", {
      accountId: "another.testnet",
    });
    assert.equal(afterExpiry.status, 200);
    assert.equal(
      (
        context.store.db
          .prepare("SELECT COUNT(*) AS count FROM auth_challenges")
          .get() as { count: number }
      ).count,
      1,
    );
    context.setNow(44_301);
    const next = await context.postJson("/auth/challenge", {
      accountId: "later.testnet",
    });
    assert.equal(next.status, 200);
    assert.equal(
      (
        context.store.db
          .prepare("SELECT COUNT(*) AS count FROM auth_sessions")
          .get() as { count: number }
      ).count,
      0,
    );
  } finally {
    await context.close();
  }
});

test("expired challenge and removed access key do not create sessions", async () => {
  const context = await setup();
  try {
    context.setActiveKey(false);
    assert.equal((await context.signIn()).verified.status, 401);
    context.setActiveKey(true);
    assert.equal((await context.signIn(false)).verified.status, 200);
    const challengeResponse = await context.postJson("/auth/challenge", {
      accountId: ACCOUNT,
    });
    const challenge = await challengeResponse.json();
    context.setNow(challenge.expiresAt + 1);
    const response = await context.postJson("/auth/verify", {
      challengeId: challenge.challengeId,
      signedMessage: {
        accountId: ACCOUNT,
        publicKey: "ed25519:11111111111111111111111111111111111111111111",
        signature: "A".repeat(86) + "==",
      },
    });
    assert.equal(response.status, 409);
  } finally {
    await context.close();
  }
});

test("upload checks ownership, normalizes image, and keeps pending asset private", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const original = await sharp({
      create: { width: 32, height: 16, channels: 4, background: "#ff0000" },
    })
      .withExif({ IFD0: { Copyright: "private test metadata" } })
      .jpeg()
      .toBuffer();
    const form = new FormData();
    form.set("plot_id", PLOT);
    form.set("file", new File([original], "logo.jpg", { type: "image/jpeg" }));
    const upload = await context.app.request("/logos", {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
      body: form,
    });
    assert.equal(upload.status, 200);
    const result = await upload.json();
    assert.equal(result.status, "pending");
    assert.match(result.hash, /^[0-9a-f]{64}$/);
    assert.equal(
      (await context.app.request(`/assets/${result.hash}`)).status,
      404,
    );
    const asset = await context.app.request(`/assets/${result.hash}`, {
      headers: { cookie },
    });
    assert.equal(asset.status, 200);
    const bytes = Buffer.from(await asset.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), result.hash);
    const metadata = await sharp(bytes).metadata();
    assert.deepEqual(
      [metadata.width, metadata.height, metadata.format],
      [256, 256, "png"],
    );
    assert.equal(metadata.exif, undefined);
    context.setOwner("someone-else.testnet");
    const denied = await context.app.request("/logos", {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
      body: form,
    });
    assert.equal(denied.status, 403);
    context.setOwner(ACCOUNT);
    const invalid = new FormData();
    invalid.set("plot_id", PLOT);
    invalid.set(
      "file",
      new File(["<svg/>"], "bad.svg", { type: "image/svg+xml" }),
    );
    assert.equal(
      (
        await context.app.request("/logos", {
          method: "POST",
          headers: { origin: ORIGIN, cookie },
          body: invalid,
        })
      ).status,
      400,
    );
  } finally {
    await context.close();
  }
});

test("variable-width uploads offer billboards only on illustrated sign surfaces", async () => {
  const context = await setup();
  try {
    context.setVariableDesign(3, 2);
    context.setBuildingLevel(4);
    const { verified } = await context.signIn();
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const png = await sharp({
      create: {
        width: 24,
        height: 12,
        channels: 4,
        background: "#2d79d2",
      },
    })
      .png()
      .toBuffer();
    const send = (path: string) => {
      const form = new FormData();
      form.set("plot_id", PLOT);
      form.set("file", new File([png], "media.png", { type: "image/png" }));
      return context.app.request(path, {
        method: "POST",
        headers: { origin: ORIGIN, cookie },
        body: form,
      });
    };
    const unsupported = await send("/ads");
    assert.equal(unsupported.status, 409);
    assert.equal((await unsupported.json()).code, "NO_MEDIA_SURFACE");
    assert.equal((await send("/logos")).status, 200);
    context.setVariableDesign(2, 4);
    assert.equal((await send("/ads")).status, 200);
  } finally {
    await context.close();
  }
});

test("version-2 owner media reaches the exact illustrated moderator preview", async () => {
  const context = await setup();
  try {
    context.setVariableDesign(2, 1);
    context.setBuildingLevel(3);
    const { verified } = await context.signIn();
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const admin = `Basic ${Buffer.from("reviewer:test-only-password").toString("base64")}`;
    async function propose(
      kind: "Logo" | "Billboard",
      color: string,
      link: string,
    ) {
      const png = await sharp({
        create: {
          width: kind === "Logo" ? 24 : 48,
          height: 24,
          channels: 4,
          background: color,
        },
      })
        .png()
        .toBuffer();
      const form = new FormData();
      form.set("plot_id", PLOT);
      form.set("file", new File([png], `${kind}.png`, { type: "image/png" }));
      const uploaded = await context.app.request(
        kind === "Logo" ? "/logos" : "/ads",
        { method: "POST", headers: { origin: ORIGIN, cookie }, body: form },
      );
      assert.equal(uploaded.status, 200);
      const upload = (await uploaded.json()) as {
        uploadId: string;
        hash: string;
      };
      const created = await context.postJson(
        "/media/proposals",
        { uploadId: upload.uploadId, link },
        cookie,
      );
      assert.equal(created.status, 201);
      const proposal = (await created.json()) as { id: string };
      context.setMediaSlot(kind, {
        ...emptyMediaSlot,
        revision: 1,
        pending: {
          revision: 1,
          owner: ACCOUNT,
          building_type: "Retail",
          level: 3,
          layout_revision: 1,
          content: { asset_hash: upload.hash, link },
        },
      });
      assert.equal(
        (
          await context.postJson(
            `/media/proposals/${proposal.id}/reconcile`,
            {},
            cookie,
          )
        ).status,
        200,
      );
      return { proposal, upload };
    }
    async function reviewImage(): Promise<Buffer> {
      const page = await context.app.request("/moderation", {
        headers: { authorization: admin },
      });
      assert.equal(page.status, 200);
      const html = await page.text();
      const match = html.match(
        /Facade with approved media after this decision<\/p><img src="data:image\/png;base64,([^"]+)"/,
      );
      assert(match, "moderator sees the exact combined facade");
      return Buffer.from(match[1]!, "base64");
    }
    async function rgbAt(image: Buffer, x: number, y: number) {
      const { data, info } = await sharp(image)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const offset =
        (Math.floor(y) * info.width + Math.floor(x)) * info.channels;
      return [...data.subarray(offset, offset + 3)];
    }
    const layout = variableFrontageMediaLayout(2, 1, 3);
    const logo = await propose("Logo", "#ee3010", "https://brand.example/logo");
    const logoPreview = await reviewImage();
    assert.equal((await sharp(logoPreview).metadata()).width, 170);
    assert.deepEqual(
      await rgbAt(
        logoPreview,
        layout.logo.x + layout.logo.width / 2,
        layout.logo.y + layout.logo.height / 2,
      ),
      [238, 48, 16],
    );
    assert.equal(
      (
        await context.app.request(
          `/moderation/media/${logo.proposal.id}/approve`,
          { method: "POST", headers: { origin: ORIGIN, authorization: admin } },
        )
      ).status,
      303,
    );
    assert.equal(
      context.store.mediaProposal(logo.proposal.id)?.status,
      "approved",
    );
    context.setMediaEligibility("Logo", true);
    const billboard = await propose(
      "Billboard",
      "#1234ef",
      "https://brand.example/billboard",
    );
    const combined = await reviewImage();
    assert.deepEqual(
      await rgbAt(
        combined,
        layout.logo.x + layout.logo.width / 2,
        layout.logo.y + layout.logo.height / 2,
      ),
      [238, 48, 16],
    );
    assert(layout.billboard);
    assert.deepEqual(
      await rgbAt(
        combined,
        layout.billboard.x + layout.billboard.width / 2,
        layout.billboard.y + layout.billboard.height / 2,
      ),
      [18, 52, 239],
    );
    assert.equal(
      (
        await context.app.request(
          `/moderation/media/${billboard.proposal.id}/approve`,
          { method: "POST", headers: { origin: ORIGIN, authorization: admin } },
        )
      ).status,
      303,
    );
    assert.equal(
      context.store.mediaProposal(billboard.proposal.id)?.status,
      "approved",
    );
  } finally {
    await context.close();
  }
});

test("upload rejects a changed plot and oversized multipart body", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const image = await sharp({
      create: { width: 10, height: 10, channels: 4, background: "#00ff00" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("plot_id", PLOT);
    form.set("file", new File([image], "small.png", { type: "image/png" }));
    context.flipLayoutOnSecondRead();
    const changed = await context.app.request("/logos", {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
      body: form,
    });
    assert.equal(changed.status, 409);
    const oversized = new FormData();
    oversized.set("plot_id", PLOT);
    oversized.set(
      "file",
      new File([Buffer.alloc(2 * 1024 * 1024 + 1)], "huge.png", {
        type: "image/png",
      }),
    );
    const rejected = await context.app.request("/logos", {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
      body: oversized,
    });
    assert.equal(rejected.status, 413);
  } finally {
    await context.close();
  }
});

test("image upload attempts are bounded before image decoding", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const invalidForm = () => {
      const form = new FormData();
      form.set("plot_id", PLOT);
      form.set(
        "file",
        new File(["<svg/>"], "bad.svg", { type: "image/svg+xml" }),
      );
      return form;
    };
    for (let attempt = 0; attempt < 12; attempt++) {
      const rejected = await context.app.request("/logos", {
        method: "POST",
        headers: { origin: ORIGIN, cookie },
        body: invalidForm(),
      });
      assert.equal(rejected.status, 400);
    }
    const limited = await context.app.request("/logos", {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
      body: invalidForm(),
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, "RATE_LIMITED");
    context.setNow(1_000 + 86_401);
    const renewed = await context.signIn();
    const nextCookie = renewed.verified.headers
      .get("set-cookie")!
      .split(";")[0]!;
    const image = await sharp({
      create: { width: 8, height: 8, channels: 4, background: "#00ff00" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("plot_id", PLOT);
    form.set("file", new File([image], "logo.png", { type: "image/png" }));
    assert.equal(
      (
        await context.app.request("/logos", {
          method: "POST",
          headers: { origin: ORIGIN, cookie: nextCookie },
          body: form,
        })
      ).status,
      200,
    );
  } finally {
    await context.close();
  }
});

test("the daily image budget spans an owner's plots", async () => {
  const context = await setup();
  try {
    const now = 1_000;
    for (let plot = 0; plot < 4; plot++) {
      for (let attempt = 0; attempt < 12; attempt++) {
        assert.equal(
          context.store.reserveUploadAttempt(
            ACCOUNT,
            `plot-main-n-${plot}`,
            now,
            86_400,
            12,
            48,
          ),
          true,
        );
      }
    }
    assert.equal(
      context.store.reserveUploadAttempt(
        ACCOUNT,
        "plot-main-n-4",
        now,
        86_400,
        12,
        48,
      ),
      false,
    );
    assert.equal(
      context.store.reserveUploadAttempt(
        ACCOUNT,
        "plot-main-n-4",
        now + 86_401,
        86_400,
        12,
        48,
      ),
      true,
    );
  } finally {
    await context.close();
  }
});

test("logo upload becomes a media proposal only after exact chain reconciliation", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const bytes = await sharp({
      create: { width: 32, height: 32, channels: 4, background: "#00bb88" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("plot_id", PLOT);
    form.set("file", new File([bytes], "logo.png", { type: "image/png" }));
    const uploaded = await context.app.request("/logos", {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
      body: form,
    });
    assert.equal(uploaded.status, 200);
    const upload = await uploaded.json();
    assert.equal(
      (
        await context.postJson("/media/proposals", {
          uploadId: upload.uploadId,
          link: null,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await context.postJson(
          "/media/proposals",
          { uploadId: upload.uploadId, link: "https://person@brand.example" },
          cookie,
        )
      ).status,
      400,
    );
    const created = await context.postJson(
      "/media/proposals",
      { uploadId: upload.uploadId, link: "https://brand.example/shop" },
      cookie,
    );
    assert.equal(created.status, 201);
    const proposal = await created.json();
    assert.equal(proposal.status, "selected");
    assert.equal(proposal.expectedMediaRevision, 0);
    assert.equal(proposal.assetHash, upload.hash);
    assert.equal(
      (
        await context.postJson(
          `/media/proposals/${proposal.id}/reconcile`,
          {},
          cookie,
        )
      ).status,
      409,
    );
    context.setMediaSlot("Logo", {
      ...emptyMediaSlot,
      revision: 1,
      pending: {
        revision: 1,
        owner: ACCOUNT,
        building_type: "Retail",
        level: 1,
        layout_revision: 1,
        content: {
          asset_hash: upload.hash,
          link: "https://brand.example/other",
        },
      },
    });
    assert.equal(
      (
        await context.postJson(
          `/media/proposals/${proposal.id}/reconcile`,
          {},
          cookie,
        )
      ).status,
      409,
    );
    context.setMediaSlot("Logo", {
      ...emptyMediaSlot,
      revision: 1,
      pending: {
        revision: 1,
        owner: ACCOUNT,
        building_type: "Retail",
        level: 1,
        layout_revision: 1,
        content: {
          asset_hash: upload.hash,
          link: "https://brand.example/shop",
        },
      },
    });
    const reconciled = await context.postJson(
      `/media/proposals/${proposal.id}/reconcile`,
      {},
      cookie,
    );
    assert.equal(reconciled.status, 200);
    assert.equal((await reconciled.json()).status, "submitted");
    const latest = await context.app.request(
      `/media/proposals/latest?plot_id=${PLOT}&kind=Logo`,
      { headers: { cookie } },
    );
    assert.equal((await latest.json()).id, proposal.id);
    assert.equal(
      (await context.app.request(`/assets/${upload.hash}`)).status,
      404,
    );
    context.setLayoutRevision(2);
    assert.equal(
      (
        await context.postJson(
          "/media/proposals",
          { uploadId: upload.uploadId, link: null },
          cookie,
        )
      ).status,
      409,
    );
  } finally {
    await context.close();
  }
});

test("media proposals reuse identical requests and bound unresolved slot choices", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const bytes = await sharp({
      create: { width: 24, height: 24, channels: 4, background: "#23aa88" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("plot_id", PLOT);
    form.set("file", new File([bytes], "logo.png", { type: "image/png" }));
    const uploaded = await context.app.request("/logos", {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
      body: form,
    });
    assert.equal(uploaded.status, 200);
    const { uploadId } = (await uploaded.json()) as { uploadId: string };
    const propose = (suffix: number) =>
      context.postJson(
        "/media/proposals",
        { uploadId, link: `https://brand.example/${suffix}` },
        cookie,
      );
    const first = await propose(0);
    assert.equal(first.status, 201);
    const firstId = ((await first.json()) as { id: string }).id;
    const repeated = await propose(0);
    assert.equal(repeated.status, 200);
    assert.equal(((await repeated.json()) as { id: string }).id, firstId);
    const distinct = await Promise.all(
      Array.from({ length: 2 }, (_, index) => propose(index + 1)),
    );
    for (const result of distinct) assert.equal(result.status, 201);
    const limited = await propose(3);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, "RATE_LIMITED");
    assert.equal((await propose(0)).status, 200);
    assert.equal(
      (
        context.store.db
          .prepare("SELECT COUNT(*) AS count FROM media_proposals")
          .get() as { count: number }
      ).count,
      3,
    );
  } finally {
    await context.close();
  }
});

test("media proposal quota spans an owner's uploads", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    for (let image = 0; image < 4; image++) {
      const upload = context.store.recordUpload({
        accountId: ACCOUNT,
        plotId: PLOT,
        kind: "Logo",
        hash: image.toString(16).repeat(64),
        layoutRevision: 1,
        createdAt: 1_000,
      });
      for (let link = 0; link < 12; link++) {
        const proposal = context.store.createMediaProposal({
          uploadId: upload.id,
          accountId: ACCOUNT,
          plotId: PLOT,
          kind: "Logo",
          assetHash: upload.hash,
          link: `https://brand.example/seed-${image}-${link}`,
          buildingType: "Retail",
          level: 1,
          layoutRevision: 1,
          expectedMediaRevision: 0,
          createdAt: 1_000,
        });
        context.store.markMediaSuperseded(proposal.id, 1_000);
      }
    }
    const nextUpload = context.store.recordUpload({
      accountId: ACCOUNT,
      plotId: PLOT,
      kind: "Logo",
      hash: "a".repeat(64),
      layoutRevision: 1,
      createdAt: 1_000,
    });
    const limited = await context.postJson(
      "/media/proposals",
      { uploadId: nextUpload.id, link: "https://brand.example/new" },
      cookie,
    );
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, "RATE_LIMITED");
    context.setNow(1_000 + 86_401);
    const renewed = await context.signIn();
    const renewedCookie = renewed.verified.headers
      .get("set-cookie")!
      .split(";")[0]!;
    assert.equal(
      (
        await context.postJson(
          "/media/proposals",
          { uploadId: nextUpload.id, link: "https://brand.example/new" },
          renewedCookie,
        )
      ).status,
      201,
    );
  } finally {
    await context.close();
  }
});

test("media proposal quota remains bound to one uploaded image", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const upload = context.store.recordUpload({
      accountId: ACCOUNT,
      plotId: PLOT,
      kind: "Logo",
      hash: "a".repeat(64),
      layoutRevision: 1,
      createdAt: 1_000,
    });
    for (let link = 0; link < 12; link++) {
      const proposal = context.store.createMediaProposal({
        uploadId: upload.id,
        accountId: ACCOUNT,
        plotId: PLOT,
        kind: "Logo",
        assetHash: upload.hash,
        link: `https://brand.example/seed-${link}`,
        buildingType: "Retail",
        level: 1,
        layoutRevision: 1,
        expectedMediaRevision: 0,
        createdAt: 1_000,
      });
      context.store.markMediaSuperseded(proposal.id, 1_000);
    }
    const limited = await context.postJson(
      "/media/proposals",
      { uploadId: upload.id, link: "https://brand.example/new" },
      cookie,
    );
    assert.equal(limited.status, 429);
    assert.match(
      (await limited.json()).message,
      /image has too many proposals/,
    );
  } finally {
    await context.close();
  }
});

test("moderator approves and revokes the exact logo while keeping immutable history", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const bytes = await sharp({
      create: { width: 24, height: 24, channels: 4, background: "#12ab34" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("plot_id", PLOT);
    form.set("file", new File([bytes], "logo.png", { type: "image/png" }));
    const uploaded = await context.app.request("/logos", {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
      body: form,
    });
    const upload = await uploaded.json();
    const created = await context.postJson(
      "/media/proposals",
      { uploadId: upload.uploadId, link: "https://brand.example/shop" },
      cookie,
    );
    const proposal = await created.json();
    const pending: NonNullable<ChainMediaSlot["pending"]> = {
      revision: 1,
      owner: ACCOUNT,
      building_type: "Retail",
      level: 1,
      layout_revision: 1,
      content: {
        asset_hash: upload.hash,
        link: "https://brand.example/shop",
      },
    };
    context.setMediaSlot("Logo", { ...emptyMediaSlot, revision: 1, pending });
    assert.equal(
      (
        await context.postJson(
          `/media/proposals/${proposal.id}/reconcile`,
          {},
          cookie,
        )
      ).status,
      200,
    );
    const admin = `Basic ${Buffer.from("reviewer:test-only-password").toString("base64")}`;
    const page = await context.app.request("/moderation", {
      headers: { authorization: admin },
    });
    const reviewHtml = await page.text();
    assert.match(reviewHtml, /Approve exact logo/);
    assert.match(reviewHtml, /Facade with approved media after this decision/);
    assert.match(
      reviewHtml,
      /Logo link: <code>https:\/\/brand.example\/shop<\/code>/,
    );
    assert.equal(
      (await context.app.request(`/assets/${upload.hash}`)).status,
      404,
    );
    const unauthorized = await context.app.request(
      `/moderation/media/${proposal.id}/approve`,
      { method: "POST", headers: { origin: ORIGIN } },
    );
    assert.equal(unauthorized.status, 401);
    const wrongOrigin = await context.app.request(
      `/moderation/media/${proposal.id}/approve`,
      {
        method: "POST",
        headers: { origin: "https://other.example", authorization: admin },
      },
    );
    assert.equal(wrongOrigin.status, 403);
    const changed = {
      ...pending,
      content: { ...pending.content, link: "https://brand.example/other" },
    };
    context.setMediaSlot("Logo", {
      ...emptyMediaSlot,
      revision: 1,
      pending: changed,
    });
    assert.equal(
      (
        await context.app.request(`/moderation/media/${proposal.id}/approve`, {
          method: "POST",
          headers: { origin: ORIGIN, authorization: admin },
        })
      ).status,
      409,
    );
    context.setMediaSlot("Logo", { ...emptyMediaSlot, revision: 1, pending });
    const assetPath = join(context.store.assetDir, `${upload.hash}.png`);
    const savedAsset = await readFile(assetPath);
    await rm(assetPath);
    const missingPage = await context.app.request("/moderation", {
      headers: { authorization: admin },
    });
    assert.match(await missingPage.text(), /Final facade preview unavailable/);
    assert.equal(
      (
        await context.app.request(`/moderation/media/${proposal.id}/approve`, {
          method: "POST",
          headers: { origin: ORIGIN, authorization: admin },
        })
      ).status,
      409,
    );
    await writeFile(assetPath, savedAsset);
    assert.equal(
      (
        await context.app.request(`/moderation/media/${proposal.id}/approve`, {
          method: "POST",
          headers: { origin: ORIGIN, authorization: admin },
        })
      ).status,
      303,
    );
    assert.equal(context.store.mediaProposal(proposal.id)?.status, "approved");
    assert.equal(
      (await context.app.request(`/assets/${upload.hash}`)).status,
      200,
    );
    const activePage = await context.app.request("/moderation", {
      headers: { authorization: admin },
    });
    assert.match(await activePage.text(), /Revoke active logo/);
    const revoked = await context.app.request(
      `/moderation/media/${proposal.id}/revoke`,
      {
        method: "POST",
        headers: {
          origin: ORIGIN,
          authorization: admin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "reason=Brand+withdrawn",
      },
    );
    assert.equal(revoked.status, 303);
    assert.equal(context.store.mediaProposal(proposal.id)?.status, "revoked");
    assert.equal(
      context.store.mediaProposal(proposal.id)?.decisionReason,
      "Brand withdrawn",
    );
    assert.equal(
      (await context.app.request(`/assets/${upload.hash}`)).status,
      200,
    );
  } finally {
    await context.close();
  }
});

test("rejected billboard remains private and records the decision", async () => {
  const context = await setup();
  try {
    const now = Math.floor(Date.now() / 1_000);
    context.setNow(now);
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const bytes = await sharp({
      create: { width: 24, height: 12, channels: 4, background: "#ae152c" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("plot_id", PLOT);
    form.set("file", new File([bytes], "billboard.png", { type: "image/png" }));
    const uploaded = await context.app.request("/ads", {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
      body: form,
    });
    const upload = await uploaded.json();
    const created = await context.postJson(
      "/media/proposals",
      { uploadId: upload.uploadId, link: null },
      cookie,
    );
    const proposal = await created.json();
    context.setMediaSlot("Billboard", {
      ...emptyMediaSlot,
      revision: 1,
      pending: {
        revision: 1,
        owner: ACCOUNT,
        building_type: "Retail",
        level: 1,
        layout_revision: 1,
        content: { asset_hash: upload.hash, link: null },
      },
    });
    await context.postJson(
      `/media/proposals/${proposal.id}/reconcile`,
      {},
      cookie,
    );
    const admin = `Basic ${Buffer.from("reviewer:test-only-password").toString("base64")}`;
    assert.equal(
      (
        await context.app.request(`/moderation/media/${proposal.id}/reject`, {
          method: "POST",
          headers: { origin: ORIGIN, authorization: admin },
        })
      ).status,
      400,
    );
    for (const reason of ["r".repeat(241), "🔥".repeat(61)]) {
      const invalidReason = await context.app.request(
        `/moderation/media/${proposal.id}/reject`,
        {
          method: "POST",
          headers: {
            origin: ORIGIN,
            authorization: admin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ reason }).toString(),
        },
      );
      assert.equal(invalidReason.status, 400);
      assert.equal(
        context.store.mediaProposal(proposal.id)?.status,
        "submitted",
      );
    }
    assert.equal(
      (
        await context.app.request(`/moderation/media/${proposal.id}/reject`, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            authorization: admin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "reason=Too+much+text",
        })
      ).status,
      303,
    );
    assert.equal(context.store.mediaProposal(proposal.id)?.status, "rejected");
    assert.equal(
      context.store.mediaProposal(proposal.id)?.decisionReason,
      "Too much text",
    );
    assert.equal(
      (await context.app.request(`/assets/${upload.hash}`)).status,
      404,
    );
    context.setNow(now + 8 * 24 * 60 * 60);
    assert.deepEqual(
      await sweepPrivateAssets(context.store, now + 8 * 24 * 60 * 60),
      { assetLinksExpired: 0, uploadsExpired: 1, filesRemoved: 1 },
    );
    const renewed = await context.signIn();
    const renewedCookie = renewed.verified.headers
      .get("set-cookie")!
      .split(";")[0]!;
    const history = await context.app.request(
      `/media/proposals/${proposal.id}`,
      { headers: { cookie: renewedCookie } },
    );
    assert.equal(history.status, 200);
    const historical = (await history.json()) as {
      id: string;
      status: string;
      decisionReason: string;
      assetUrl: string | null;
    };
    assert.equal(historical.id, proposal.id);
    assert.equal(historical.status, "rejected");
    assert.equal(historical.decisionReason, "Too much text");
    assert.equal(historical.assetUrl, null);
    assert.equal(
      (
        await context.app.request(
          `/media/uploads/latest?plot_id=${PLOT}&kind=Billboard`,
          { headers: { cookie: renewedCookie } },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await context.app.request(`/assets/${upload.hash}`, {
          headers: { cookie: renewedCookie },
        })
      ).status,
      404,
    );
  } finally {
    await context.close();
  }
});

test("paid generation queue authenticates owners, deduplicates requests and keeps candidates private", async () => {
  const context = await setup(true);
  try {
    assert.deepEqual(
      await (await context.app.request("/paid-generations/status")).json(),
      { enabled: true },
    );
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const request = {
      plotId: PLOT,
      description: "A mint storefront with a copper roof",
      palette: "#73D9A6",
      materialHints: ["Glass", "Timber"],
    };
    const postPaid = (body: unknown, key = "paid-request-key-123") =>
      context.app.request("/paid-generations", {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      });
    assert.equal((await postPaid(request, "short")).status, 400);
    const queued = await postPaid(request);
    assert.equal(queued.status, 202);
    const first = await queued.json();
    assert.equal(first.status, "queued");
    assert.equal(first.mode, "paid");
    assert.equal((await (await postPaid(request)).json()).id, first.id);
    context.setOwner("new-owner.testnet");
    assert.equal(
      (
        await (
          await postPaid({ ...request, materialHints: ["Timber", "Glass"] })
        ).json()
      ).id,
      first.id,
    );
    context.setOwner(ACCOUNT);
    assert.equal(
      (await postPaid({ ...request, description: "A different design" }))
        .status,
      409,
    );
    assert.equal(
      (await postPaid({ ...request, usePriorArt: false })).status,
      409,
    );
    assert.equal(
      (await context.app.request(`/paid-generations/${first.id}`)).status,
      401,
    );
    const latest = await context.app.request(
      `/paid-generations/latest?plot_id=${PLOT}`,
      { headers: { cookie } },
    );
    assert.equal((await latest.json()).id, first.id);
    const ledger = context.paidLedger!;
    ledger.claim("worker_a", 1_000);
    const attempt = ledger.beginAttempt(first.id, "worker_a", 1_000);
    const png = await sharp(
      Buffer.from(
        '<svg width="1024" height="1536" xmlns="http://www.w3.org/2000/svg"><rect x="200" y="600" width="624" height="500" fill="#73D9A6"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await processPaidImageResult({
      ledger,
      jobId: first.id,
      workerId: "worker_a",
      clientRequestId: attempt.clientRequestId,
      providerRequestId: "provider_1",
      png,
      assetDir: context.store.assetDir,
      now: 1_000,
    });
    const job = await context.app.request(`/paid-generations/${first.id}`, {
      headers: { cookie },
    });
    const result = await job.json();
    assert.equal(result.acceptedCount, 1);
    assert.equal(result.candidates.length, 0);
    const spriteHash = ledger.candidates(first.id)[0]!.spriteHash;
    assert.equal(
      (await context.app.request(`/assets/${spriteHash}`)).status,
      404,
    );
    assert.equal(
      (
        await context.app.request(`/assets/${spriteHash}`, {
          headers: { cookie },
        })
      ).status,
      404,
    );
    const cancelled = await context.app.request(
      `/paid-generations/${first.id}/cancel`,
      { method: "POST", headers: { origin: ORIGIN, cookie } },
    );
    assert.equal((await cancelled.json()).status, "cancelled");
    assert.equal(ledger.day(0).chargedCalls, 1);
    assert.equal(ledger.day(0).reservedCalls, 0);
  } finally {
    await context.close();
  }
});

test("paid generation refuses changed plots and stays off by default", async () => {
  const disabled = await setup();
  try {
    assert.deepEqual(
      await (await disabled.app.request("/paid-generations/status")).json(),
      { enabled: false },
    );
    assert.equal(
      (
        await disabled.postJson("/paid-generations", {
          plotId: PLOT,
          description: "A cafe",
          palette: "#73D9A6",
        })
      ).status,
      503,
    );
  } finally {
    await disabled.close();
  }
  const enabled = await setup(true);
  try {
    const { verified } = await enabled.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    enabled.flipLayoutOnSecondRead();
    const response = await enabled.app.request("/paid-generations", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie,
        "content-type": "application/json",
        "idempotency-key": "paid-request-key-123",
      },
      body: JSON.stringify({
        plotId: PLOT,
        description: "A cafe",
        palette: "#73D9A6",
      }),
    });
    assert.equal(response.status, 409);
    assert.equal(enabled.paidLedger!.day(0).reservedCalls, 0);
  } finally {
    await enabled.close();
  }
});

test("paid upgrade request selects the owner's last approved lower-level facade", async () => {
  const context = await setup(true);
  try {
    const original = await renderMockCandidate("Retail", 1, 1, "#73D9A6");
    await Promise.all([
      saveImmutablePng(
        context.store.assetDir,
        original.spriteHash,
        original.sprite,
      ),
      saveImmutablePng(
        context.store.assetDir,
        original.thumbnailHash,
        original.thumbnail,
      ),
    ]);
    const published = context.store.createGeneration({
      accountId: ACCOUNT,
      plotId: PLOT,
      buildingType: "Retail",
      level: 1,
      layoutRevision: 1,
      appearanceRevision: 1,
      description: "Original shop",
      candidates: [
        {
          id: 1,
          variant: 1,
          palette: "#73D9A6",
          manifest: original.manifest,
          manifestHash: original.manifestHash,
          spriteHash: original.spriteHash,
          thumbnailHash: original.thumbnailHash,
        },
      ],
      createdAt: 100,
    });
    context.store.selectGeneration(published.id, ACCOUNT, 1);
    context.store.markGenerationSubmitted(published.id, 2);
    context.store.markGenerationDecided(published.id, "approved", 200, null);
    context.setBuildingLevel(2);
    context.setLayoutRevision(2);
    context.setAppearanceRevision(2);
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const queued = await context.app.request("/paid-generations", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie,
        "content-type": "application/json",
        "idempotency-key": "upgrade-reference-request-123",
      },
      body: JSON.stringify({
        plotId: PLOT,
        description: "Keep the shop shape and add a floor",
        palette: "#73D9A6",
      }),
    });
    assert.equal(queued.status, 202);
    const job = await queued.json();
    const snapshot = context.paidLedger!.job(job.id)?.snapshot;
    assert.equal(snapshot?.approvedManifestHashAtRequest, null);
    assert.equal(
      snapshot?.promptSpec.referenceManifestHash,
      original.manifestHash,
    );
    context.paidLedger!.cancel(job.id);
    context.setNow(90_000);
    const freshSignIn = await context.signIn();
    const freshCookie = freshSignIn.verified.headers
      .get("set-cookie")!
      .split(";")[0]!;
    const fresh = await context.app.request("/paid-generations", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie: freshCookie,
        "content-type": "application/json",
        "idempotency-key": "upgrade-fresh-request-456",
      },
      body: JSON.stringify({
        plotId: PLOT,
        description: "A completely new shop",
        palette: "#73D9A6",
        usePriorArt: false,
      }),
    });
    assert.equal(fresh.status, 202);
    const freshJob = await fresh.json();
    assert.equal(
      context.paidLedger!.job(freshJob.id)?.snapshot?.promptSpec
        .referenceManifestHash,
      null,
    );
  } finally {
    await context.close();
  }
});

test("a completed paid candidate enters the exact owner and moderator review flow", async () => {
  const context = await setup(true);
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const queued = await context.app.request("/paid-generations", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie,
        "content-type": "application/json",
        "idempotency-key": "paid-review-request-123",
      },
      body: JSON.stringify({
        plotId: PLOT,
        description: "A mint shop with broad windows",
        palette: "#73D9A6",
      }),
    });
    assert.equal(queued.status, 202);
    const queuedJob = await queued.json();
    const ledger = context.paidLedger!;
    ledger.claim("worker_review", 1_000);
    const firstAttempt = ledger.beginAttempt(
      queuedJob.id,
      "worker_review",
      1_000,
    );
    const png = await sharp(
      Buffer.from(
        '<svg width="1024" height="1536" xmlns="http://www.w3.org/2000/svg"><rect x="200" y="600" width="624" height="500" fill="#73D9A6"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await processPaidImageResult({
      ledger,
      jobId: queuedJob.id,
      workerId: "worker_review",
      clientRequestId: firstAttempt.clientRequestId,
      providerRequestId: "provider_paid_review",
      png,
      assetDir: context.store.assetDir,
      now: 1_000,
    });
    const secondAttempt = ledger.beginAttempt(
      queuedJob.id,
      "worker_review",
      1_001,
    );
    const secondPng = await sharp(
      Buffer.from(
        '<svg width="1024" height="1536" xmlns="http://www.w3.org/2000/svg"><rect x="280" y="600" width="464" height="500" fill="#73D9A6"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await processPaidImageResult({
      ledger,
      jobId: queuedJob.id,
      workerId: "worker_review",
      clientRequestId: secondAttempt.clientRequestId,
      providerRequestId: "provider_paid_review_2",
      png: secondPng,
      assetDir: context.store.assetDir,
      now: 1_001,
    });
    for (let index = 0; index < 2; index++) {
      const attempt = ledger.beginAttempt(
        queuedJob.id,
        "worker_review",
        1_002 + index,
      );
      ledger.finishAttempt({
        jobId: queuedJob.id,
        workerId: "worker_review",
        clientRequestId: attempt.clientRequestId,
        outcome: "rejected",
        now: 1_002 + index,
      });
    }
    assert.equal(ledger.job(queuedJob.id)?.status, "complete");
    const originalCandidate = ledger.candidates(queuedJob.id)[1]!;
    assert.ok(originalCandidate.manifest.billboardRect);
    assert.ok(originalCandidate.manifest.logoRect);
    const adjustedLogoX = originalCandidate.manifest.logoRect.x + 4;
    const adjustedLogoY = originalCandidate.manifest.logoRect.y + 2;
    const paidResponse = await context.app.request(
      `/paid-generations/${queuedJob.id}`,
      { headers: { cookie } },
    );
    const paidJob = await paidResponse.json();
    assert.equal(paidJob.status, "awaiting_review");
    assert.equal(paidJob.designJobId, null);
    assert.equal(paidJob.candidates.length, 0);
    const admin = `Basic ${Buffer.from("reviewer:test-only-password").toString("base64")}`;
    context.setNeighborEnabled(true);
    const reviewPage = await context.app.request("/moderation", {
      headers: { authorization: admin },
    });
    const pendingHtml = await reviewPage.text();
    assert.match(pendingHtml, /generated candidate 1/);
    assert.match(pendingHtml, /generated candidate 2/);
    assert.match(pendingHtml, /Logo/);
    assert.match(pendingHtml, /Remove the proposed billboard area/);
    assert.match(pendingHtml, /Preview adjusted placement/);
    assert.match(pendingHtml, /Style and perspective match the game/);
    assert.match(pendingHtml, /Game-size street comparison/);
    assert.match(pendingHtml, /Neighbour cafe/);
    assert.match(pendingHtml, /Generated candidate at game size/);
    const reviewPath = `/moderation/paid-generations/${queuedJob.id}/candidates/2/approve`;
    const previewPath = `/moderation/paid-generations/${queuedJob.id}/candidates/2/preview?logo_x=${adjustedLogoX}&logo_y=${adjustedLogoY}&suppress_billboard=on`;
    assert.equal((await context.app.request(previewPath)).status, 401);
    const preview = await context.app.request(previewPath, {
      headers: { authorization: admin },
    });
    assert.equal(preview.status, 200);
    const previewHtml = await preview.text();
    assert.match(previewHtml, /Review adjusted placement/);
    assert.match(previewHtml, /Adjusted candidate at game size/);
    assert.match(previewHtml, /Neighbour cafe/);
    const previewHash = previewHtml.match(
      /name="preview_manifest_hash" value="([a-f0-9]{64})"/,
    )?.[1];
    assert.ok(previewHash);
    assert.equal(
      (
        await context.app.request(
          `/moderation/paid-generations/${queuedJob.id}/candidates/2/preview?logo_x=0&logo_y=0`,
          { headers: { authorization: admin } },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await context.app.request(
          `/moderation/paid-generations/${queuedJob.id}/candidates/2/preview?logo_x=${originalCandidate.manifest.billboardRect.x}&logo_y=${originalCandidate.manifest.billboardRect.y}`,
          { headers: { authorization: admin } },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await context.app.request(reviewPath, {
          method: "POST",
          headers: { origin: ORIGIN },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await context.app.request(reviewPath, {
          method: "POST",
          headers: {
            origin: "https://other.example",
            authorization: admin,
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await context.app.request(reviewPath, {
          method: "POST",
          headers: { origin: ORIGIN, authorization: admin },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await context.app.request(reviewPath, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            authorization: admin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: `content_ok=on&style_ok=on&placement_ok=on&suppress_billboard=on&logo_x=${adjustedLogoX}&logo_y=${adjustedLogoY}`,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await context.app.request(reviewPath, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            authorization: admin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: `content_ok=on&style_ok=on&placement_ok=on&suppress_billboard=on&logo_x=${adjustedLogoX}&logo_y=${adjustedLogoY}&preview_manifest_hash=${previewHash}`,
        })
      ).status,
      303,
    );
    assert.equal(ledger.candidates(queuedJob.id)[1]?.reviewStatus, "approved");
    assert.equal(ledger.candidates(queuedJob.id)[1]?.reviewedBy, "reviewer");
    assert.equal(
      ledger.candidates(queuedJob.id)[1]?.manifest.billboardRect,
      null,
    );
    assert.equal(
      ledger.candidates(queuedJob.id)[1]?.manifest.logoRect?.x,
      adjustedLogoX,
    );
    assert.equal(
      ledger.candidates(queuedJob.id)[1]?.manifest.logoRect?.y,
      adjustedLogoY,
    );
    assert.notEqual(
      ledger.candidates(queuedJob.id)[1]?.manifestHash,
      originalCandidate.manifestHash,
    );
    assert.equal(
      (
        await context.app.request(`/paid-generations/${queuedJob.id}`, {
          headers: { cookie },
        })
      ).status,
      200,
    );
    assert.equal(context.store.generation(queuedJob.id), null);
    const rejectPath = `/moderation/paid-generations/${queuedJob.id}/candidates/1/reject`;
    assert.equal(
      (
        await context.app.request(rejectPath, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            authorization: admin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "reason=Perspective+does+not+match",
        })
      ).status,
      303,
    );
    assert.equal(ledger.candidates(queuedJob.id)[0]?.reviewStatus, "rejected");
    const reviewedResponse = await context.app.request(
      `/paid-generations/${queuedJob.id}`,
      { headers: { cookie } },
    );
    const reviewedJob = await reviewedResponse.json();
    assert.equal(reviewedJob.status, "partial");
    assert.equal(reviewedJob.designJobId, queuedJob.id);
    const promoted = await context.app.request(`/generations/${queuedJob.id}`, {
      headers: { cookie },
    });
    assert.equal(promoted.status, 200);
    const design = await promoted.json();
    assert.equal(design.mode, "paid");
    assert.equal(design.candidates.length, 1);
    assert.equal(design.candidates[0].id, 2);
    assert.equal(design.candidates[0].manifest.billboardRect, null);
    assert.equal(design.candidates[0].manifest.logoRect.x, adjustedLogoX);
    assert.equal(
      design.candidates[0].manifestHash,
      ledger.candidates(queuedJob.id)[1]?.manifestHash,
    );
    assert.equal(
      (await context.app.request(`/assets/${design.candidates[0].spriteHash}`))
        .status,
      404,
    );
    assert.equal(
      (
        await context.postJson(
          `/generations/${design.id}/select`,
          { candidateId: 2 },
          cookie,
        )
      ).status,
      200,
    );
    context.setAppearanceRevision(2);
    context.setPendingAppearance({
      revision: 2,
      owner: ACCOUNT,
      building_type: "Retail",
      level: 1,
      manifest_hash: design.candidates[0].manifestHash,
    });
    assert.equal(
      (
        await context.postJson(
          `/generations/${design.id}/reconcile`,
          {},
          cookie,
        )
      ).status,
      200,
    );
    const review = await context.app.request("/moderation", {
      headers: { authorization: admin },
    });
    assert.match(await review.text(), /Selected design 2/);
    const approved = await context.app.request(
      `/moderation/generations/${design.id}/approve`,
      { method: "POST", headers: { origin: ORIGIN, authorization: admin } },
    );
    assert.equal(approved.status, 303);
    assert.equal(context.store.generation(design.id)?.status, "approved");
    assert.equal(
      (await context.app.request(`/assets/${design.candidates[0].spriteHash}`))
        .status,
      200,
    );
    assert.equal(
      (
        await context.app.request(`/paid-generations/${queuedJob.id}`, {
          headers: { cookie },
        })
      ).status,
      200,
    );
  } finally {
    await context.close();
  }
});

test("variable paid art reaches fixed-layout moderation and owner review locally", async () => {
  const context = await setup(true);
  try {
    context.setVariableDesign(3, 0);
    context.setBuildingLevel(2);
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const queued = await context.app.request("/paid-generations", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie,
        "content-type": "application/json",
        "idempotency-key": "variable-review-local-001",
      },
      body: JSON.stringify({
        plotId: PLOT,
        description: "Warm market windows",
        palette: "#EF8270",
      }),
    });
    assert.equal(queued.status, 202);
    const queuedJob = await queued.json();
    const ledger = context.paidLedger!;
    ledger.claim("variable-review-worker", 1_000);
    const attempt = ledger.beginAttempt(
      queuedJob.id,
      "variable-review-worker",
      1_000,
    );
    const png = await sharp(
      Buffer.from(
        '<svg width="1024" height="768" xmlns="http://www.w3.org/2000/svg"><rect x="20" y="300" width="984" height="400" fill="#d08065"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await processPaidImageResult({
      ledger,
      jobId: queuedJob.id,
      workerId: "variable-review-worker",
      clientRequestId: attempt.clientRequestId,
      providerRequestId: "fake_variable_review",
      png,
      assetDir: context.store.assetDir,
      now: 1_000,
    });
    for (let index = 0; index < 3; index++) {
      const rejected = ledger.beginAttempt(
        queuedJob.id,
        "variable-review-worker",
        1_001 + index,
      );
      ledger.finishAttempt({
        jobId: queuedJob.id,
        workerId: "variable-review-worker",
        clientRequestId: rejected.clientRequestId,
        outcome: "rejected",
        now: 1_001 + index,
      });
    }
    assert.equal(ledger.job(queuedJob.id)?.status, "complete");
    const candidate = ledger.candidates(queuedJob.id)[0]!;
    assert.equal(candidate.manifest.schemaVersion, 2);
    const admin = `Basic ${Buffer.from("reviewer:test-only-password").toString("base64")}`;
    const review = await context.app.request("/moderation", {
      headers: { authorization: admin },
    });
    assert.equal(review.status, 200);
    const html = await review.text();
    assert.match(html, /width="255" height="190"/);
    assert.match(html, /fixed outlines match the selected street design/);
    assert.doesNotMatch(html, /Preview adjusted placement/);
    const base = `/moderation/paid-generations/${queuedJob.id}/candidates/1`;
    assert.equal(
      (
        await context.app.request(`${base}/preview?logo_x=10&logo_y=10`, {
          headers: { authorization: admin },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await context.app.request(`${base}/approve`, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            authorization: admin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "content_ok=on&style_ok=on&placement_ok=on&logo_x=10&logo_y=10",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await context.app.request(`${base}/approve`, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            authorization: admin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "content_ok=on&style_ok=on&placement_ok=on",
        })
      ).status,
      303,
    );
    const reviewed = await context.app.request(
      `/paid-generations/${queuedJob.id}`,
      { headers: { cookie } },
    );
    assert.equal((await reviewed.json()).designJobId, queuedJob.id);
    const ownerJob = await context.app.request(`/generations/${queuedJob.id}`, {
      headers: { cookie },
    });
    assert.equal(ownerJob.status, 200);
    const design = await ownerJob.json();
    assert.equal(design.candidates[0].manifest.schemaVersion, 2);
    assert.equal(design.candidates[0].manifest.frontageUnits, 3);
    assert.equal(design.candidates[0].manifest.designChoice, 0);
    const selected = await context.postJson(
      `/generations/${design.id}/select`,
      { candidateId: 1 },
      cookie,
    );
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).manifestHash, candidate.manifestHash);
    context.setAppearanceRevision(2);
    context.setPendingAppearance({
      revision: 2,
      owner: ACCOUNT,
      building_type: "Retail",
      level: 2,
      manifest_hash: candidate.manifestHash,
    });
    const reconciled = await context.postJson(
      `/generations/${design.id}/reconcile`,
      {},
      cookie,
    );
    assert.equal(reconciled.status, 200);
    assert.equal((await reconciled.json()).status, "submitted");
    const exactReview = await context.app.request("/moderation", {
      headers: { authorization: admin },
    });
    assert.match(await exactReview.text(), /3 unit frontage · design 1/);
    assert.equal(
      (
        await context.app.request(
          `/moderation/generations/${design.id}/approve`,
          { method: "POST", headers: { origin: ORIGIN, authorization: admin } },
        )
      ).status,
      303,
    );
    assert.equal(context.store.generation(design.id)?.status, "approved");
    assert.equal(
      (await context.app.request(`/manifests/${candidate.manifestHash}`))
        .status,
      200,
    );
    assert.equal(
      (await context.app.request(`/assets/${candidate.spriteHash}`)).status,
      200,
    );
  } finally {
    await context.close();
  }
});

test("billboard movement is previewed and published with its exact candidate hash", async () => {
  const context = await setup(true);
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const queued = await context.app.request("/paid-generations", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie,
        "content-type": "application/json",
        "idempotency-key": "billboard-placement-request-123",
      },
      body: JSON.stringify({
        plotId: PLOT,
        description: "A shop with a clear rooftop ad frame",
        palette: "#73D9A6",
      }),
    });
    assert.equal(queued.status, 202);
    const job = await queued.json();
    const ledger = context.paidLedger!;
    ledger.claim("worker_billboard", 1_000);
    const first = ledger.beginAttempt(job.id, "worker_billboard", 1_000);
    const png = await sharp(
      Buffer.from(
        '<svg width="1024" height="1536" xmlns="http://www.w3.org/2000/svg"><rect x="200" y="600" width="624" height="500" fill="#73D9A6"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await processPaidImageResult({
      ledger,
      jobId: job.id,
      workerId: "worker_billboard",
      clientRequestId: first.clientRequestId,
      providerRequestId: "provider_billboard_1",
      png,
      assetDir: context.store.assetDir,
      now: 1_000,
    });
    for (let index = 0; index < 3; index++) {
      const attempt = ledger.beginAttempt(
        job.id,
        "worker_billboard",
        1_001 + index,
      );
      ledger.finishAttempt({
        jobId: job.id,
        workerId: "worker_billboard",
        clientRequestId: attempt.clientRequestId,
        outcome: "rejected",
        now: 1_001 + index,
      });
    }
    assert.equal(ledger.job(job.id)?.status, "complete");
    const original = ledger.candidates(job.id)[0]!;
    assert.ok(original.manifest.logoRect);
    assert.ok(original.manifest.billboardRect);
    const billboardX = original.manifest.billboardRect.x + 2;
    const billboardY = original.manifest.billboardRect.y + 1;
    const admin = `Basic ${Buffer.from("reviewer:test-only-password").toString("base64")}`;
    const path = `/moderation/paid-generations/${job.id}/candidates/1`;
    const moderation = await context.app.request("/moderation", {
      headers: { authorization: admin },
    });
    assert.equal(moderation.status, 200);
    const moderationHtml = await moderation.text();
    assert.match(moderationHtml, /name="billboard_x"/);
    assert.match(moderationHtml, /name="billboard_y"/);
    const coordinates = new URLSearchParams({
      logo_x: String(original.manifest.logoRect.x),
      logo_y: String(original.manifest.logoRect.y),
      billboard_x: String(billboardX),
      billboard_y: String(billboardY),
    });
    assert.equal(
      (
        await context.app.request(
          `${path}/preview?logo_x=${original.manifest.logoRect.x}&logo_y=${original.manifest.logoRect.y}`,
          { headers: { authorization: admin } },
        )
      ).status,
      200,
    );
    const preview = await context.app.request(
      `${path}/preview?${coordinates}`,
      {
        headers: { authorization: admin },
      },
    );
    assert.equal(preview.status, 200);
    const previewHtml = await preview.text();
    assert.match(previewHtml, /Billboard/);
    const previewHash = previewHtml.match(
      /name="preview_manifest_hash" value="([a-f0-9]{64})"/,
    )?.[1];
    assert.ok(previewHash);
    assert.notEqual(previewHash, original.manifestHash);
    assert.equal(
      (
        await context.app.request(
          `${path}/preview?logo_x=${original.manifest.logoRect.x}&logo_y=${original.manifest.logoRect.y}&billboard_x=${original.manifest.logoRect.x}&billboard_y=${original.manifest.logoRect.y}`,
          { headers: { authorization: admin } },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await context.app.request(
          `${path}/preview?logo_x=${original.manifest.logoRect.x}&logo_y=${original.manifest.logoRect.y}&billboard_x=1.5&billboard_y=${billboardY}`,
          { headers: { authorization: admin } },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await context.app.request(
          `${path}/preview?logo_x=${original.manifest.logoRect.x}&logo_y=${original.manifest.logoRect.y}&billboard_x=0&billboard_y=0`,
          { headers: { authorization: admin } },
        )
      ).status,
      400,
    );
    const approval = new URLSearchParams({
      content_ok: "on",
      style_ok: "on",
      placement_ok: "on",
      logo_x: String(original.manifest.logoRect.x),
      logo_y: String(original.manifest.logoRect.y),
      billboard_x: String(billboardX),
      billboard_y: String(billboardY),
    });
    const headers = {
      origin: ORIGIN,
      authorization: admin,
      "content-type": "application/x-www-form-urlencoded",
    };
    assert.equal(
      (
        await context.app.request(`${path}/approve`, {
          method: "POST",
          headers,
          body: approval.toString(),
        })
      ).status,
      400,
    );
    approval.set("preview_manifest_hash", previewHash);
    approval.set("billboard_x", String(billboardX + 1));
    assert.equal(
      (
        await context.app.request(`${path}/approve`, {
          method: "POST",
          headers,
          body: approval.toString(),
        })
      ).status,
      400,
    );
    approval.set("billboard_x", String(billboardX));
    assert.equal(
      (
        await context.app.request(`${path}/approve`, {
          method: "POST",
          headers,
          body: approval.toString(),
        })
      ).status,
      303,
    );
    const reviewed = ledger.candidates(job.id)[0]!;
    assert.equal(reviewed.reviewStatus, "approved");
    assert.equal(reviewed.manifest.billboardRect?.x, billboardX);
    assert.equal(reviewed.manifest.billboardRect?.y, billboardY);
    assert.equal(reviewed.manifestHash, previewHash);
    const promoted = await context.app.request(`/generations/${job.id}`, {
      headers: { cookie },
    });
    assert.equal(promoted.status, 200);
    const ownerJob = await promoted.json();
    assert.equal(ownerJob.candidates[0]?.manifestHash, previewHash);
    assert.equal(ownerJob.candidates[0]?.manifest.billboardRect.x, billboardX);
  } finally {
    await context.close();
  }
});

test("owner mock design jobs are private, bounded and tied to a plot revision", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const request = {
      plotId: PLOT,
      description: "A bright café with hanging plants",
      palette: "#73D9A6",
      themeHint: "Garden",
      materialHints: ["Glass", "Timber"],
    };
    const created = await context.postJson("/generations", request, cookie);
    assert.equal(created.status, 201);
    const job = await created.json();
    assert.equal(job.mode, "curated_mock");
    assert.equal(job.description, request.description);
    assert.equal(job.layoutRevision, 1);
    assert.equal(job.appearanceRevision, 1);
    assert.equal(job.promptSpec.version, 4);
    assert.equal(job.promptSpec.themeHint, "Garden");
    assert.deepEqual(job.promptSpec.materialHints, ["Timber", "Glass"]);
    assert.match(job.promptSpec.prompt, /70 logical pixels tall/);
    assert.match(job.promptSpec.promptHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      job.candidates.map((candidate: { variant: number; palette: string }) => [
        candidate.variant,
        candidate.palette,
      ]),
      [
        [1, "#73D9A6"],
        [2, "#73D9A6"],
        [1, "#F6C85F"],
      ],
    );
    assert.equal(job.candidates.length, 3);
    assert.equal(
      new Set(
        job.candidates.map(
          (candidate: { spriteHash: string }) => candidate.spriteHash,
        ),
      ).size,
      3,
    );
    const first = job.candidates[0];
    assert.match(first.manifestHash, /^[0-9a-f]{64}$/);
    assert.equal(first.manifest.spriteHash, first.spriteHash);
    assert.equal(
      (await context.app.request(`/assets/${first.spriteHash}`)).status,
      404,
    );
    const privateSprite = await context.app.request(
      `/assets/${first.spriteHash}`,
      { headers: { cookie } },
    );
    assert.equal(privateSprite.status, 200);
    const spriteBytes = Buffer.from(await privateSprite.arrayBuffer());
    assert.equal(
      createHash("sha256").update(spriteBytes).digest("hex"),
      first.spriteHash,
    );
    const spriteInfo = await sharp(spriteBytes).metadata();
    assert.deepEqual([spriteInfo.width, spriteInfo.height], [560, 640]);
    assert.equal(
      (await context.app.request(`/generations/${job.id}`)).status,
      401,
    );
    const fetched = await context.app.request(`/generations/${job.id}`, {
      headers: { cookie },
    });
    assert.equal((await fetched.json()).id, job.id);
    const latest = await context.app.request(
      `/generations/latest?plot_id=${PLOT}`,
      { headers: { cookie } },
    );
    assert.equal((await latest.json()).id, job.id);
    context.setOwner("someone-else.testnet");
    assert.equal(
      (await context.postJson("/generations", request, cookie)).status,
      403,
    );
    context.setOwner(ACCOUNT);
    context.flipLayoutOnSecondRead();
    assert.equal(
      (await context.postJson("/generations", request, cookie)).status,
      409,
    );
    assert.equal(context.store.recentGenerations(ACCOUNT, 0), 1);
    for (let index = 0; index < 9; index++) {
      assert.equal(
        (await context.postJson("/generations", request, cookie)).status,
        201,
      );
    }
    assert.equal(
      (await context.postJson("/generations", request, cookie)).status,
      429,
    );
  } finally {
    await context.close();
  }
});

test("an 800-character UTF-8 design description fits the bounded request", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const description = "ก".repeat(800);
    const created = await context.postJson(
      "/generations",
      {
        plotId: PLOT,
        description,
        palette: "#73D9A6",
        themeHint: "Garden",
        materialHints: ["Timber", "Glass"],
      },
      cookie,
    );
    assert.equal(created.status, 201);
    const job = await created.json();
    assert.equal(job.description, description);
    assert.equal(job.promptSpec.description, description);
  } finally {
    await context.close();
  }
});

test("mock design jobs survive a SQLite restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-job-"));
  const path = join(dir, "estate.sqlite");
  try {
    const first = new ApiStore(path, join(dir, "assets"));
    const looks = await Promise.all([
      renderMockCandidate("Retail", 1, 2, "#EF8270"),
      renderMockCandidate("Retail", 2, 2, "#EF8270"),
      renderMockCandidate("Retail", 1, 2, "#69B9E9"),
    ]);
    const job = first.createGeneration({
      accountId: ACCOUNT,
      plotId: PLOT,
      buildingType: "Retail",
      level: 2,
      layoutRevision: 3,
      appearanceRevision: 4,
      description: "Brick arches",
      promptSpec: buildGenerationPrompt({
        buildingType: "Retail",
        level: 2,
        variant: 1,
        palette: "#EF8270",
        description: "Brick arches",
        themeHint: "Classic",
        materialHints: ["Brick"],
      }),
      candidates: looks.map((look, index) => ({
        id: (index + 1) as 1 | 2 | 3,
        variant: (index === 1 ? 2 : 1) as 1 | 2,
        palette: index === 2 ? "#69B9E9" : "#EF8270",
        manifest: look.manifest,
        manifestHash: look.manifestHash,
        spriteHash: look.spriteHash,
        thumbnailHash: look.thumbnailHash,
      })) as [
        import("./store.js").MockCandidate,
        import("./store.js").MockCandidate,
        import("./store.js").MockCandidate,
      ],
      createdAt: 123,
    });
    first.close();
    const second = new ApiStore(path, join(dir, "assets"));
    assert.deepEqual(second.generation(job.id), job);
    assert.deepEqual(second.latestGeneration(ACCOUNT, PLOT), job);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing design jobs gain a nullable versioned prompt without losing history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-prompt-migration-"));
  const path = join(dir, "estate.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE generation_jobs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      plot_id TEXT NOT NULL,
      building_type TEXT NOT NULL,
      level INTEGER NOT NULL,
      layout_revision INTEGER NOT NULL,
      description TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
    legacy
      .prepare(
        `INSERT INTO generation_jobs
       (id, account_id, plot_id, building_type, level, layout_revision,
        description, candidates_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-job", ACCOUNT, PLOT, "Retail", 1, 1, "Old design", "[]", 42);
    legacy.close();
    const upgraded = new ApiStore(path, join(dir, "assets"));
    assert.equal(upgraded.generation("legacy-job")?.description, "Old design");
    assert.equal(upgraded.generation("legacy-job")?.mode, "curated_mock");
    assert.equal(upgraded.generation("legacy-job")?.promptSpec, null);
    assert.ok(
      (
        upgraded.db.prepare("PRAGMA table_info(generation_jobs)").all() as {
          name: string;
        }[]
      ).some((column) => column.name === "prompt_json"),
    );
    upgraded.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a selected design is immutable and only the exact on-chain proposal reconciles", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const created = await context.postJson(
      "/generations",
      {
        plotId: PLOT,
        description: "A bright shop with a green roof",
        palette: "#73D9A6",
      },
      cookie,
    );
    assert.equal(created.status, 201);
    const job = await created.json();
    const selectPath = `/generations/${job.id}/select`;
    assert.equal(
      (await context.postJson(selectPath, { candidateId: 2 })).status,
      401,
    );
    const selected = await context.postJson(
      selectPath,
      { candidateId: 2 },
      cookie,
    );
    assert.equal(selected.status, 200);
    const proposal = await selected.json();
    assert.deepEqual(proposal, {
      jobId: job.id,
      candidateId: 2,
      plotId: PLOT,
      expectedRevision: 1,
      manifestHash: job.candidates[1].manifestHash,
    });
    assert.equal(
      (await context.postJson(selectPath, { candidateId: 2 }, cookie)).status,
      200,
    );
    assert.equal(
      (await context.postJson(selectPath, { candidateId: 3 }, cookie)).status,
      409,
    );
    const reconcilePath = `/generations/${job.id}/reconcile`;
    assert.equal(
      (await context.postJson(reconcilePath, {}, cookie)).status,
      409,
    );
    context.setAppearanceRevision(2);
    context.setPendingAppearance({
      revision: 2,
      owner: ACCOUNT,
      building_type: "Retail",
      level: 1,
      manifest_hash: job.candidates[0].manifestHash,
    });
    assert.equal(
      (await context.postJson(reconcilePath, {}, cookie)).status,
      409,
    );
    context.setPendingAppearance({
      revision: 2,
      owner: ACCOUNT,
      building_type: "Retail",
      level: 1,
      manifest_hash: job.candidates[1].manifestHash,
    });
    const reconciled = await context.postJson(reconcilePath, {}, cookie);
    assert.equal(reconciled.status, 200);
    const confirmed = await reconciled.json();
    assert.equal(confirmed.status, "submitted");
    assert.equal(confirmed.selectedCandidateId, 2);
    assert.equal(confirmed.proposalRevision, 2);
    assert.equal(
      (await context.postJson(reconcilePath, {}, cookie)).status,
      200,
    );
    assert.equal(
      (await context.app.request(`/assets/${job.candidates[1].spriteHash}`))
        .status,
      404,
    );
  } finally {
    await context.close();
  }
});

test("a new appearance revision makes an unsubmitted design job stale", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const created = await context.postJson(
      "/generations",
      {
        plotId: PLOT,
        description: "A corner shop",
        palette: "#73D9A6",
      },
      cookie,
    );
    const job = await created.json();
    context.setAppearanceRevision(2);
    assert.equal(
      (
        await context.postJson(
          `/generations/${job.id}/select`,
          { candidateId: 1 },
          cookie,
        )
      ).status,
      409,
    );
    assert.equal(context.store.generation(job.id)?.status, "ready");
  } finally {
    await context.close();
  }
});

test("moderator reviews the exact selected image and approval publishes only that asset", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const created = await context.postJson(
      "/generations",
      {
        plotId: PLOT,
        description: "A shop <script>alert(1)</script>",
        palette: "#73D9A6",
      },
      cookie,
    );
    const job = await created.json();
    await context.postJson(
      `/generations/${job.id}/select`,
      { candidateId: 2 },
      cookie,
    );
    context.setAppearanceRevision(2);
    context.setPendingAppearance({
      revision: 2,
      owner: ACCOUNT,
      building_type: "Retail",
      level: 1,
      manifest_hash: job.candidates[1].manifestHash,
    });
    assert.equal(
      (await context.postJson(`/generations/${job.id}/reconcile`, {}, cookie))
        .status,
      200,
    );
    const admin = `Basic ${Buffer.from("reviewer:test-only-password").toString("base64")}`;
    assert.equal((await context.app.request("/moderation")).status, 401);
    const review = await context.app.request("/moderation", {
      headers: { authorization: admin },
    });
    assert.equal(review.status, 200);
    const page = await review.text();
    assert.match(page, /Selected design 2/);
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(!page.includes("<script>alert(1)</script>"));
    for (const assetHash of [
      job.candidates[1].spriteHash,
      job.candidates[1].thumbnailHash,
    ]) {
      const assetPath = join(context.store.assetDir, `${assetHash}.png`);
      const original = await readFile(assetPath);
      await writeFile(assetPath, "altered image bytes");
      const unavailablePage = await context.app.request("/moderation", {
        headers: { authorization: admin },
      });
      const unavailableHtml = await unavailablePage.text();
      assert.doesNotMatch(unavailableHtml, /Selected design 2/);
      assert.match(unavailableHtml, /selected facade unavailable/);
      assert.doesNotMatch(unavailableHtml, /Approve exact design/);
      const blocked = await context.app.request(
        `/moderation/generations/${job.id}/approve`,
        { method: "POST", headers: { origin: ORIGIN, authorization: admin } },
      );
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json()).code, "ASSET_UNAVAILABLE");
      assert.equal(context.store.generation(job.id)?.status, "submitted");
      await writeFile(assetPath, original);
    }
    assert.equal(
      (
        await context.app.request(
          `/manifests/${job.candidates[1].manifestHash}`,
        )
      ).status,
      404,
    );
    const approved = await context.app.request(
      `/moderation/generations/${job.id}/approve`,
      {
        method: "POST",
        headers: { origin: ORIGIN, authorization: admin },
      },
    );
    assert.equal(approved.status, 303);
    assert.equal(context.store.generation(job.id)?.status, "approved");
    assert.equal(
      (
        await context.app.request(
          `/manifests/${job.candidates[1].manifestHash}`,
        )
      ).status,
      200,
    );
    assert.equal(
      (await context.app.request(`/assets/${job.candidates[1].spriteHash}`))
        .status,
      200,
    );
    assert.equal(
      (await context.app.request(`/assets/${job.candidates[0].spriteHash}`))
        .status,
      404,
    );
    const chosenSpritePath = join(
      context.store.assetDir,
      `${job.candidates[1].spriteHash}.png`,
    );
    const chosenSprite = await readFile(chosenSpritePath);
    await writeFile(chosenSpritePath, "altered after approval");
    const corruptImage = await context.app.request(
      `/assets/${job.candidates[1].spriteHash}`,
    );
    assert.equal(corruptImage.status, 503);
    assert.equal((await corruptImage.json()).code, "ASSET_CORRUPT");
    assert.equal(corruptImage.headers.get("cache-control"), "no-store");
    await writeFile(chosenSpritePath, chosenSprite);
    assert.equal(
      (await context.app.request(`/assets/${job.candidates[1].spriteHash}`))
        .status,
      200,
    );
    const storedCandidates = context.store.db
      .prepare("SELECT candidates_json FROM generation_jobs WHERE id = ?")
      .get(job.id) as { candidates_json: string };
    const alteredCandidates = JSON.parse(
      storedCandidates.candidates_json,
    ) as typeof job.candidates;
    alteredCandidates[1].manifest.level = 2;
    context.store.db
      .prepare("UPDATE generation_jobs SET candidates_json = ? WHERE id = ?")
      .run(JSON.stringify(alteredCandidates), job.id);
    const corruptManifest = await context.app.request(
      `/manifests/${job.candidates[1].manifestHash}`,
    );
    assert.equal(corruptManifest.status, 503);
    assert.equal((await corruptManifest.json()).code, "ASSET_CORRUPT");
    assert.equal(corruptManifest.headers.get("cache-control"), "no-store");
    context.store.db
      .prepare("UPDATE generation_jobs SET candidates_json = ? WHERE id = ?")
      .run(storedCandidates.candidates_json, job.id);
    assert.equal(
      (
        await context.app.request(
          `/manifests/${job.candidates[1].manifestHash}`,
        )
      ).status,
      200,
    );
    const activePage = await context.app.request("/moderation", {
      headers: { authorization: admin },
    });
    assert.match(await activePage.text(), /Revoke active design/);
    const revoked = await context.app.request(
      `/moderation/generations/${job.id}/revoke`,
      {
        method: "POST",
        headers: {
          origin: ORIGIN,
          authorization: admin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "reason=Artwork+withdrawn",
      },
    );
    assert.equal(revoked.status, 303);
    assert.equal(context.store.generation(job.id)?.status, "revoked");
    assert.equal(
      context.store.generation(job.id)?.decisionReason,
      "Artwork withdrawn",
    );
    const history = await context.app.request(
      `/generations/history?plot_id=${PLOT}`,
      { headers: { cookie } },
    );
    assert.equal(history.status, 200);
    assert.equal((await history.json())[0].status, "revoked");
    assert.equal(
      (await context.app.request(`/assets/${job.candidates[1].spriteHash}`))
        .status,
      200,
      "an immutable once-published file remains available for history",
    );
  } finally {
    await context.close();
  }
});

test("rejection records a reason without making a selected image public", async () => {
  const context = await setup();
  try {
    const { verified } = await context.signIn();
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const created = await context.postJson(
      "/generations",
      { plotId: PLOT, description: "A small market", palette: "#73D9A6" },
      cookie,
    );
    const job = await created.json();
    await context.postJson(
      `/generations/${job.id}/select`,
      { candidateId: 1 },
      cookie,
    );
    context.setAppearanceRevision(2);
    context.setPendingAppearance({
      revision: 2,
      owner: ACCOUNT,
      building_type: "Retail",
      level: 1,
      manifest_hash: job.candidates[0].manifestHash,
    });
    await context.postJson(`/generations/${job.id}/reconcile`, {}, cookie);
    const admin = `Basic ${Buffer.from("reviewer:test-only-password").toString("base64")}`;
    const invalid = await context.app.request(
      `/moderation/generations/${job.id}/reject`,
      { method: "POST", headers: { origin: ORIGIN, authorization: admin } },
    );
    assert.equal(invalid.status, 400);
    for (const reason of ["r".repeat(241), "🔥".repeat(61)]) {
      const invalidReason = await context.app.request(
        `/moderation/generations/${job.id}/reject`,
        {
          method: "POST",
          headers: {
            origin: ORIGIN,
            authorization: admin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ reason }).toString(),
        },
      );
      assert.equal(invalidReason.status, 400);
      assert.equal(context.store.generation(job.id)?.status, "submitted");
    }
    const rejected = await context.app.request(
      `/moderation/generations/${job.id}/reject`,
      {
        method: "POST",
        headers: {
          origin: ORIGIN,
          authorization: admin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "reason=Artwork+needs+revision",
      },
    );
    assert.equal(rejected.status, 303);
    assert.equal(context.store.generation(job.id)?.status, "rejected");
    assert.equal(
      context.store.generation(job.id)?.decisionReason,
      "Artwork needs revision",
    );
    assert.equal(
      (await context.app.request(`/assets/${job.candidates[0].spriteHash}`))
        .status,
      404,
    );
  } finally {
    await context.close();
  }
});
