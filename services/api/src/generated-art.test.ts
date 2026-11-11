import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, validateAssetManifest } from "@estate/shared";
import sharp from "sharp";
import {
  GeneratedArtError,
  normalizeGeneratedFacade,
  saveGeneratedFacade,
} from "./generated-art.js";
import { readImageGenerationSettings } from "./image-generation-settings.js";
import { PaidGenerationLedger } from "./paid-generation-ledger.js";
import { processPaidImageResult } from "./paid-image-processing.js";
import { buildGenerationPrompt } from "./prompt-builder.js";
import { ApiStore } from "./store.js";

async function facadeSource(width = 624, height = 500): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg width="1024" height="1536" xmlns="http://www.w3.org/2000/svg"><rect x="200" y="600" width="${width}" height="${height}" fill="#72b6d8"/></svg>`,
  );
  return sharp(svg).png().toBuffer();
}

test("provider facade becomes a level-bound immutable sprite, thumbnail and manifest", async () => {
  const source = await facadeSource();
  for (const level of [1, 2, 3, 4] as const) {
    const candidate = await normalizeGeneratedFacade(source, "Cafe", level);
    assert.equal(candidate.manifest.level, level);
    assert.deepEqual(
      validateAssetManifest(candidate.manifest),
      candidate.manifest,
    );
    assert.equal(
      candidate.manifest.alphaBounds.y >= 160 - [70, 100, 130, 160][level - 1]!,
      true,
    );
    assert.ok(candidate.manifest.alphaBounds.x >= 5);
    assert.ok(
      candidate.manifest.alphaBounds.x + candidate.manifest.alphaBounds.width <=
        135,
    );
    assert.ok(candidate.manifest.logoRect);
    assert.equal(
      candidate.manifest.billboardRect === null ||
        candidate.manifest.billboardRect.width >= 48,
      true,
    );
    assert.equal(
      createHash("sha256").update(candidate.sprite).digest("hex"),
      candidate.spriteHash,
    );
    assert.equal(
      createHash("sha256").update(candidate.thumbnail).digest("hex"),
      candidate.thumbnailHash,
    );
    assert.equal(
      createHash("sha256")
        .update(canonicalJson(candidate.manifest))
        .digest("hex"),
      candidate.manifestHash,
    );
    const sprite = await sharp(candidate.sprite).metadata();
    const thumbnail = await sharp(candidate.thumbnail).metadata();
    assert.equal(sprite.width, 560);
    assert.equal(sprite.height, 640);
    assert.equal(sprite.hasAlpha, true);
    assert.equal(thumbnail.width, 140);
    assert.equal(thumbnail.height, 160);
    assert.equal(sprite.exif, undefined);
  }
});

test("illustrated style samples fit the actual owner-generation image envelope", async () => {
  for (const buildingType of [
    "Retail",
    "Cafe",
    "Restaurant",
    "Office",
    "Homes",
  ] as const) {
    const source = await readFile(
      new URL(
        `../../../art/source/illustrated/${buildingType.toLowerCase()}-source.png`,
        import.meta.url,
      ),
    );
    const candidate = await normalizeGeneratedFacade(source, buildingType, 2);
    assert.equal(candidate.manifest.buildingType, buildingType);
    assert.equal(candidate.manifest.level, 2);
    assert.ok(candidate.manifest.alphaBounds.x >= 5);
    assert.ok(candidate.manifest.alphaBounds.y >= 60);
    assert.ok(candidate.manifest.logoRect);
  }
});

test("normalization rejects opaque, empty, oversized and unusably thin art", async () => {
  await assert.rejects(
    normalizeGeneratedFacade(
      await sharp({
        create: {
          width: 1024,
          height: 1536,
          channels: 3,
          background: "#4a738a",
        },
      })
        .png()
        .toBuffer(),
      "Cafe",
      1,
    ),
    GeneratedArtError,
  );
  await assert.rejects(
    normalizeGeneratedFacade(
      await sharp({
        create: {
          width: 1024,
          height: 1536,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer(),
      "Cafe",
      1,
    ),
    GeneratedArtError,
  );
  await assert.rejects(
    normalizeGeneratedFacade(Buffer.alloc(16 * 1024 * 1024 + 1), "Cafe", 1),
    GeneratedArtError,
  );
  await assert.rejects(
    normalizeGeneratedFacade(await facadeSource(80, 1_000), "Office", 4),
    GeneratedArtError,
  );
});

test("normalization is deterministic for the same verified source and paid level", async () => {
  const source = await facadeSource();
  const first = await normalizeGeneratedFacade(source, "Retail", 2);
  const second = await normalizeGeneratedFacade(source, "Retail", 2);
  assert.equal(first.spriteHash, second.spriteHash);
  assert.equal(first.thumbnailHash, second.thumbnailHash);
  assert.equal(first.manifestHash, second.manifestHash);
});

test("accepted generated sprite and thumbnail persist under immutable hashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-generated-art-"));
  try {
    const candidate = await saveGeneratedFacade(
      await facadeSource(),
      "Restaurant",
      2,
      dir,
    );
    assert.deepEqual(
      await readFile(join(dir, `${candidate.spriteHash}.png`)),
      candidate.sprite,
    );
    assert.deepEqual(
      await readFile(join(dir, `${candidate.thumbnailHash}.png`)),
      candidate.thumbnail,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("paid image processing records validated assets and rejects unusable paid output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-art-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  try {
    const settings = readImageGenerationSettings({
      IMAGE_GENERATION_ENABLED: "true",
      IMAGE_GENERATION_INVITES: "one.testnet",
      IMAGE_GENERATION_DAILY_BUDGET_USD_MICROS: "4000000",
      IMAGE_GENERATION_MAX_COST_PER_CALL_USD_MICROS: "1000000",
      IMAGE_GENERATION_TIMEOUT_MS: "120000",
      IMAGE_GENERATION_SAFETY_SECRET:
        "test-secret-with-at-least-thirty-two-bytes",
      OPENAI_API_KEY: "test-api-key",
      OPENAI_IMAGE_MODEL: "gpt-image-2.5-flare-2026-09-08",
    });
    if (!settings.enabled) throw new Error("Test image settings disabled");
    const ledger = new PaidGenerationLedger(store.db, settings);
    const promptSpec = buildGenerationPrompt({
      buildingType: "Cafe",
      level: 1,
      variant: 1,
      palette: "#73D9A6",
      description: "A leafy cafe",
    });
    const job = ledger.reserve({
      accountId: "one.testnet",
      plotId: "plot-main-n-0",
      idempotencyKey: "test-art-request-1",
      snapshot: {
        buildingType: "Cafe",
        level: 1,
        layoutRevision: 1,
        appearanceRevision: 1,
        promptSpec,
      },
      now: 86_401,
    });
    ledger.claim("worker_a", 86_402);
    const firstAttempt = ledger.beginAttempt(job.id, "worker_a", 86_403);
    const accepted = await processPaidImageResult({
      ledger,
      jobId: job.id,
      workerId: "worker_a",
      clientRequestId: firstAttempt.clientRequestId,
      providerRequestId: "provider_1",
      png: await facadeSource(),
      assetDir: store.assetDir,
      now: 86_404,
    });
    assert.equal(accepted.acceptedCount, 1);
    const [candidate] = ledger.candidates(job.id);
    assert.ok(candidate);
    assert.equal(candidate.manifest.buildingType, "Cafe");
    assert.equal(candidate.ordinal, 1);
    assert.equal(
      createHash("sha256")
        .update(
          await readFile(join(store.assetDir, `${candidate.spriteHash}.png`)),
        )
        .digest("hex"),
      candidate.spriteHash,
    );
    const secondAttempt = ledger.beginAttempt(job.id, "worker_a", 86_405);
    const rejected = await processPaidImageResult({
      ledger,
      jobId: job.id,
      workerId: "worker_a",
      clientRequestId: secondAttempt.clientRequestId,
      providerRequestId: "provider_2",
      png: Buffer.from("invalid png"),
      assetDir: store.assetDir,
      now: 86_406,
    });
    assert.equal(rejected.acceptedCount, 1);
    assert.equal(ledger.candidates(job.id).length, 1);
    assert.equal(ledger.attempts(job.id)[1]?.status, "rejected");
    assert.equal(ledger.day(1).chargedCalls, 2);
    const thirdAttempt = ledger.beginAttempt(job.id, "worker_a", 86_407);
    const duplicate = await processPaidImageResult({
      ledger,
      jobId: job.id,
      workerId: "worker_a",
      clientRequestId: thirdAttempt.clientRequestId,
      providerRequestId: "provider_3",
      png: await facadeSource(),
      assetDir: store.assetDir,
      now: 86_408,
    });
    assert.equal(duplicate.acceptedCount, 1);
    assert.equal(ledger.attempts(job.id)[2]?.status, "rejected");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
