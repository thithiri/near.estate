import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import type { ChainGateway } from "./chain.js";
import { saveGeneratedFacade } from "./generated-art.js";
import { readImageGenerationSettings } from "./image-generation-settings.js";
import { ImageProviderError } from "./image-provider.js";
import { PaidGenerationLedger } from "./paid-generation-ledger.js";
import {
  PaidImageWorker,
  type PaidImageProvider,
} from "./paid-image-worker.js";
import { buildGenerationPrompt } from "./prompt-builder.js";
import { ApiStore } from "./store.js";

function settings() {
  const value = readImageGenerationSettings({
    IMAGE_GENERATION_ENABLED: "true",
    IMAGE_GENERATION_INVITES: "owner.testnet",
    IMAGE_GENERATION_DAILY_BUDGET_USD_MICROS: "4000000",
    IMAGE_GENERATION_MAX_COST_PER_CALL_USD_MICROS: "1000000",
    IMAGE_GENERATION_TIMEOUT_MS: "120000",
    IMAGE_GENERATION_SAFETY_SECRET:
      "test-secret-with-at-least-thirty-two-bytes",
    OPENAI_API_KEY: "test-api-key",
    OPENAI_IMAGE_MODEL: "gpt-image-2.5-flare-2026-09-08",
  });
  if (!value.enabled) throw new Error("Test image settings disabled");
  return value;
}

function fakeChain(plot: () => Promise<unknown>): ChainGateway {
  return {
    async hasAccessKey() {
      return true;
    },
    plot: plot as ChainGateway["plot"],
  };
}

function plot(layoutRevision = 1) {
  return {
    plot: {
      owner: "owner.testnet",
      building: {
        building_type: "Cafe",
        level: 1,
        variant: 1,
        layout_revision: layoutRevision,
        appearance_revision: 1,
        approved_manifest_hash: null,
      },
    },
  };
}

async function source(width: number): Promise<Buffer> {
  return sharp(
    Buffer.from(
      `<svg width="1024" height="1536" xmlns="http://www.w3.org/2000/svg"><rect x="180" y="600" width="${width}" height="500" fill="#72b6d8"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-worker-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const ledger = new PaidGenerationLedger(store.db, settings());
  const promptSpec = buildGenerationPrompt({
    buildingType: "Cafe",
    level: 1,
    variant: 1,
    palette: "#73D9A6",
    description: "A leafy cafe",
  });
  const job = ledger.reserve({
    accountId: "owner.testnet",
    plotId: "plot-main-n-0",
    idempotencyKey: "paid-worker-test-key",
    snapshot: {
      buildingType: "Cafe",
      level: 1,
      layoutRevision: 1,
      appearanceRevision: 1,
      promptSpec,
    },
    now: 86_401,
  });
  return {
    dir,
    store,
    ledger,
    job,
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("paid worker produces three private validated candidates within the reserved budget", async () => {
  const fixture = await setup();
  try {
    let calls = 0;
    const provider: PaidImageProvider = {
      async generate(_prompt, _accountId, clientRequestId) {
        calls++;
        return {
          png: await source(560 + calls * 40),
          clientRequestId,
          providerRequestId: `provider_${calls}`,
          model: "gpt-image-2.5-flare-2026-09-08",
        };
      },
    };
    const worker = new PaidImageWorker({
      ledger: fixture.ledger,
      store: fixture.store,
      chain: fakeChain(async () => plot()),
      provider,
      assetDir: fixture.store.assetDir,
      clock: () => 86_402,
      workerId: "worker_a",
    });
    await worker.tick();
    assert.equal(calls, 3);
    assert.equal(fixture.ledger.job(fixture.job.id)?.status, "complete");
    assert.equal(fixture.ledger.job(fixture.job.id)?.acceptedCount, 3);
    assert.equal(fixture.ledger.candidates(fixture.job.id).length, 3);
    assert.equal(fixture.ledger.day(1).chargedCalls, 3);
    assert.equal(fixture.ledger.day(1).reservedCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("paid worker stops before a second call when plot layout changes", async () => {
  const fixture = await setup();
  try {
    let reads = 0;
    let calls = 0;
    const provider: PaidImageProvider = {
      async generate(_prompt, _accountId, clientRequestId) {
        calls++;
        return {
          png: await source(600),
          clientRequestId,
          providerRequestId: "provider_1",
          model: "gpt-image-2.5-flare-2026-09-08",
        };
      },
    };
    const worker = new PaidImageWorker({
      ledger: fixture.ledger,
      store: fixture.store,
      chain: fakeChain(async () => plot(++reads === 1 ? 1 : 2)),
      provider,
      assetDir: fixture.store.assetDir,
      clock: () => 86_402,
      workerId: "worker_a",
    });
    await worker.tick();
    assert.equal(calls, 1);
    assert.equal(fixture.ledger.job(fixture.job.id)?.status, "superseded");
    assert.equal(fixture.ledger.day(1).chargedCalls, 1);
    assert.equal(fixture.ledger.day(1).reservedCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("paid worker holds an uncertain call and does not resend on later ticks", async () => {
  const fixture = await setup();
  try {
    let calls = 0;
    const provider: PaidImageProvider = {
      async generate(_prompt, _accountId, clientRequestId) {
        calls++;
        throw new ImageProviderError(
          "Network timeout",
          "uncertain",
          null,
          clientRequestId,
        );
      },
    };
    const worker = new PaidImageWorker({
      ledger: fixture.ledger,
      store: fixture.store,
      chain: fakeChain(async () => plot()),
      provider,
      assetDir: fixture.store.assetDir,
      clock: () => 86_402,
      workerId: "worker_a",
    });
    await worker.tick();
    await worker.tick();
    assert.equal(calls, 1);
    assert.equal(fixture.ledger.job(fixture.job.id)?.status, "uncertain");
    assert.equal(
      fixture.ledger.attempts(fixture.job.id)[0]?.status,
      "uncertain",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("chain read failure releases an idle lease without charging a provider call", async () => {
  const fixture = await setup();
  try {
    let calls = 0;
    const worker = new PaidImageWorker({
      ledger: fixture.ledger,
      store: fixture.store,
      chain: fakeChain(async () => {
        throw new Error("RPC unavailable");
      }),
      provider: {
        async generate() {
          calls++;
          throw new Error("Should not generate");
        },
      },
      assetDir: fixture.store.assetDir,
      clock: () => 86_402,
      workerId: "worker_a",
    });
    await worker.tick();
    assert.equal(calls, 0);
    assert.equal(fixture.ledger.job(fixture.job.id)?.status, "queued");
    assert.equal(fixture.ledger.day(1).chargedCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("upgraded building uses its approved prior sprite and missing art never starts a paid call", async () => {
  const fixture = await setup();
  try {
    fixture.ledger.cancel(fixture.job.id);
    const previous = await saveGeneratedFacade(
      await source(600),
      "Cafe",
      1,
      fixture.store.assetDir,
    );
    const plotId = "plot-main-n-1";
    const published = fixture.store.createGeneration({
      accountId: "owner.testnet",
      plotId,
      buildingType: "Cafe",
      level: 1,
      layoutRevision: 1,
      appearanceRevision: 1,
      description: "Original cafe",
      candidates: [
        {
          id: 1,
          variant: 1,
          palette: "#73D9A6",
          manifest: previous.manifest,
          manifestHash: previous.manifestHash,
          spriteHash: previous.spriteHash,
          thumbnailHash: previous.thumbnailHash,
        },
      ],
      createdAt: 86_000,
    });
    fixture.store.selectGeneration(published.id, "owner.testnet", 1);
    fixture.store.markGenerationSubmitted(published.id, 2);
    fixture.store.markGenerationDecided(published.id, "approved", 86_100, null);
    const upgradedPrompt = buildGenerationPrompt({
      buildingType: "Cafe",
      level: 2,
      variant: 1,
      palette: "#73D9A6",
      description: "Add one level to the original cafe",
      referenceManifestHash: previous.manifestHash,
    });
    const reserve = (key: string, at = 86_401) =>
      fixture.ledger.reserve({
        accountId: "owner.testnet",
        plotId,
        idempotencyKey: key,
        snapshot: {
          buildingType: "Cafe",
          level: 2,
          layoutRevision: 2,
          appearanceRevision: 2,
          approvedManifestHashAtRequest: null,
          promptSpec: upgradedPrompt,
        },
        now: at,
      });
    const upgraded = reserve("upgrade-reference-123");
    let calls = 0;
    let now = 86_402;
    const worker = new PaidImageWorker({
      ledger: fixture.ledger,
      store: fixture.store,
      chain: fakeChain(async () => ({
        plot: {
          owner: "owner.testnet",
          building: {
            building_type: "Cafe",
            level: 2,
            variant: 1,
            layout_revision: 2,
            appearance_revision: 2,
            approved_manifest_hash: null,
          },
        },
      })),
      provider: {
        async generate(_prompt, _accountId, clientRequestId, referencePng) {
          calls++;
          assert.deepEqual(referencePng, previous.sprite);
          return {
            png: await source(600 + calls * 40),
            clientRequestId,
            providerRequestId: `provider_${calls}`,
            model: "gpt-image-2.5-flare-2026-09-08",
          };
        },
      },
      assetDir: fixture.store.assetDir,
      clock: () => now,
      workerId: "worker_upgrade",
    });
    await worker.tick();
    assert.equal(calls, 3);
    assert.equal(fixture.ledger.job(upgraded.id)?.status, "complete");

    await unlink(join(fixture.store.assetDir, `${previous.spriteHash}.png`));
    const missing = reserve("upgrade-reference-456", 172_801);
    now = 172_802;
    await worker.tick();
    assert.equal(calls, 3);
    assert.equal(fixture.ledger.job(missing.id)?.status, "failed");
    assert.equal(fixture.ledger.job(missing.id)?.chargedCalls, 0);
    assert.equal(fixture.ledger.job(missing.id)?.reservedCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});
