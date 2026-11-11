import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { saveImmutablePng } from "./asset-storage.js";
import { AssetRetentionWorker, sweepPrivateAssets } from "./asset-retention.js";
import type { ChainGateway } from "./chain.js";
import { readImageGenerationSettings } from "./image-generation-settings.js";
import { ImpressionLedger } from "./impression-ledger.js";
import { renderMockCandidate } from "./mock-art.js";
import { PaidGenerationLedger } from "./paid-generation-ledger.js";
import { buildGenerationPrompt } from "./prompt-builder.js";
import { ApiStore, type MockCandidate } from "./store.js";

test("seven-day cleanup removes unselected previews while retaining selected and published art", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-retention-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const now = Math.floor(Date.now() / 1_000);
  const old = now - 8 * 24 * 60 * 60;
  try {
    const artwork = await Promise.all(
      ["#73D9A6", "#FA8A6A", "#F6C75A", "#61A8DF"].map((palette) =>
        renderMockCandidate("Cafe", 1, 1, palette),
      ),
    );
    const candidates: MockCandidate[] = [];
    for (const [index, art] of artwork.entries()) {
      await Promise.all([
        saveImmutablePng(store.assetDir, art.spriteHash, art.sprite),
        saveImmutablePng(store.assetDir, art.thumbnailHash, art.thumbnail),
      ]);
      for (const hash of [art.spriteHash, art.thumbnailHash]) {
        await utimes(join(store.assetDir, `${hash}.png`), old, old);
      }
      candidates.push({
        id: (index < 3 ? index + 1 : 1) as 1 | 2 | 3,
        variant: 1,
        palette: ["#73D9A6", "#FA8A6A", "#F6C75A", "#61A8DF"][index]!,
        manifest: art.manifest,
        manifestHash: art.manifestHash,
        spriteHash: art.spriteHash,
        thumbnailHash: art.thumbnailHash,
      });
    }
    const expired = store.createGeneration({
      accountId: "one.testnet",
      plotId: "plot-main-n-0",
      buildingType: "Cafe",
      level: 1,
      layoutRevision: 1,
      appearanceRevision: 1,
      description: "Unchosen",
      candidates: [candidates[0]!],
      createdAt: old,
    });
    const selected = store.createGeneration({
      accountId: "one.testnet",
      plotId: "plot-main-n-1",
      buildingType: "Cafe",
      level: 1,
      layoutRevision: 1,
      appearanceRevision: 1,
      description: "Chosen",
      candidates: [
        { ...candidates[1]!, id: 1 },
        { ...candidates[2]!, id: 2 },
      ],
      createdAt: old,
    });
    store.selectGeneration(selected.id, "one.testnet", 1);
    const published = store.createGeneration({
      accountId: "one.testnet",
      plotId: "plot-main-n-2",
      buildingType: "Cafe",
      level: 1,
      layoutRevision: 1,
      appearanceRevision: 1,
      description: "Published",
      candidates: [candidates[3]!],
      createdAt: old,
    });
    store.selectGeneration(published.id, "one.testnet", 1);
    store.markGenerationSubmitted(published.id, 2);
    store.markGenerationDecided(published.id, "approved", old + 10, null);
    store.markGenerationRevoked(published.id, old + 20, "Retired design");
    const delayedArt = await renderMockCandidate("Cafe", 2, 1, "#73D9A6");
    await Promise.all([
      saveImmutablePng(
        store.assetDir,
        delayedArt.spriteHash,
        delayedArt.sprite,
      ),
      saveImmutablePng(
        store.assetDir,
        delayedArt.thumbnailHash,
        delayedArt.thumbnail,
      ),
    ]);
    for (const hash of [delayedArt.spriteHash, delayedArt.thumbnailHash])
      await utimes(join(store.assetDir, `${hash}.png`), old, old);
    const delayed = store.createGeneration({
      accountId: "one.testnet",
      plotId: "plot-main-n-3",
      buildingType: "Cafe",
      level: 1,
      layoutRevision: 1,
      appearanceRevision: 1,
      description: "Generated a week after queueing",
      candidates: [
        {
          id: 1,
          variant: 2,
          palette: "#73D9A6",
          manifest: delayedArt.manifest,
          manifestHash: delayedArt.manifestHash,
          spriteHash: delayedArt.spriteHash,
          thumbnailHash: delayedArt.thumbnailHash,
        },
      ],
      createdAt: old,
      readyAt: now - 24 * 60 * 60,
    });

    const result = await sweepPrivateAssets(store, now);
    assert.equal(result.assetLinksExpired, 4);
    assert.equal(result.filesRemoved, 4);
    assert.equal(store.generation(expired.id)?.status, "expired");
    assert.deepEqual(store.generation(expired.id)?.candidates, []);
    assert.equal(store.generation(delayed.id)?.status, "ready");
    assert.deepEqual(
      store.generation(selected.id)?.candidates.map((item) => item.id),
      [1],
    );
    assert.equal(
      store.canReadAsset(candidates[0]!.spriteHash, "one.testnet"),
      false,
    );
    assert.equal(
      store.canReadAsset(candidates[1]!.spriteHash, "one.testnet"),
      true,
    );
    assert.equal(store.canReadAsset(candidates[3]!.spriteHash, null), true);
    assert.equal(
      store.publicManifest(candidates[3]!.manifestHash)?.spriteHash,
      candidates[3]!.spriteHash,
    );
    assert.deepEqual(
      await readFile(join(store.assetDir, `${candidates[3]!.spriteHash}.png`)),
      artwork[3]!.sprite,
    );
    await assert.rejects(
      access(join(store.assetDir, `${candidates[0]!.spriteHash}.png`)),
    );
    assert.deepEqual(await sweepPrivateAssets(store, now), {
      assetLinksExpired: 0,
      uploadsExpired: 0,
      filesRemoved: 0,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("idle service sweep expires raw impression and auth rows while retaining totals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-idle-retention-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const now = 1_800_000;
  const expiredAt = now - 86_400;
  try {
    const impressions = new ImpressionLedger(store.db);
    impressions.issueSession("expired-impression", expiredAt);
    impressions.issueSession("active-impression", now - 10);
    impressions.recordBatch(
      "expired-impression",
      [
        {
          eventId: randomUUID(),
          plotId: "plot-main-n-0",
          surface: "Logo",
          observedAt: (expiredAt + 1) * 1_000,
          msVisible: 1_200,
        },
      ],
      expiredAt + 2,
    );
    store.createSession(
      "expired-auth",
      "owner.testnet",
      "ed25519:expired",
      now - 100,
      now - 1,
    );
    store.createSession(
      "active-auth",
      "owner.testnet",
      "ed25519:active",
      now - 10,
      now + 100,
    );
    store.createChallenge(
      {
        id: randomUUID(),
        account_id: "owner.testnet",
        nonce: "expired",
        message: "expired",
        recipient: "localhost",
        callback_url: "http://localhost/",
        expires_at: now - 1,
      },
      now - 100,
    );

    const worker = new AssetRetentionWorker(store, null, () => now);
    worker.start();
    await worker.stop();

    assert.equal(impressions.sessionExpiry("expired-impression", now), null);
    assert.equal(
      impressions.sessionExpiry("active-impression", now),
      now - 10 + 86_400,
    );
    assert.equal(store.sessionIdentity("expired-auth", now), null);
    assert.equal(
      store.sessionIdentity("active-auth", now)?.accountId,
      "owner.testnet",
    );
    for (const table of [
      "impression_events",
      "impression_minutes",
      "auth_challenges",
    ]) {
      const row = store.db
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as {
        count: number;
      };
      assert.equal(
        row.count,
        0,
        `${table} should be cleared during an idle sweep`,
      );
    }
    const daily = store.db
      .prepare("SELECT impressions, dwell_ms FROM impression_daily_stats")
      .get() as { impressions: number; dwell_ms: number };
    assert.deepEqual({ ...daily }, { impressions: 1, dwell_ms: 1_200 });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unused uploads expire while proposed and renewed images remain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-upload-retention-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const now = Math.floor(Date.now() / 1_000);
  const old = now - 8 * 24 * 60 * 60;
  try {
    const art = await Promise.all(
      ["#73D9A6", "#FA8A6A", "#F6C75A"].map((palette) =>
        renderMockCandidate("Cafe", 1, 1, palette),
      ),
    );
    const uploads = [];
    for (const item of art) {
      await saveImmutablePng(store.assetDir, item.spriteHash, item.sprite);
      await utimes(join(store.assetDir, `${item.spriteHash}.png`), old, old);
      uploads.push(
        store.recordUpload({
          accountId: "owner.testnet",
          plotId: "plot-main-n-0",
          kind: "Logo",
          hash: item.spriteHash,
          layoutRevision: 1,
          createdAt: old,
        }),
      );
    }
    const unused = uploads[0]!;
    const proposed = uploads[1]!;
    const renewed = uploads[2]!;
    store.createMediaProposal({
      uploadId: proposed.id,
      accountId: proposed.accountId,
      plotId: proposed.plotId,
      kind: proposed.kind,
      assetHash: proposed.hash,
      link: null,
      buildingType: "Cafe",
      level: 1,
      layoutRevision: 1,
      expectedMediaRevision: 1,
      createdAt: old,
    });
    assert.equal(
      store.recordUpload({
        accountId: renewed.accountId,
        plotId: renewed.plotId,
        kind: renewed.kind,
        hash: renewed.hash,
        layoutRevision: 1,
        createdAt: now - 60,
      }).id,
      renewed.id,
    );
    const result = await sweepPrivateAssets(store, now);
    assert.equal(result.uploadsExpired, 1);
    assert.equal(result.filesRemoved, 1);
    assert.equal(store.upload(unused.id), null);
    assert.ok(store.upload(proposed.id));
    assert.equal(store.upload(renewed.id)?.createdAt, now - 60);
    await assert.rejects(access(join(store.assetDir, `${unused.hash}.png`)));
    await access(join(store.assetDir, `${proposed.hash}.png`));
    await access(join(store.assetDir, `${renewed.hash}.png`));
    assert.deepEqual(await sweepPrivateAssets(store, now), {
      assetLinksExpired: 0,
      uploadsExpired: 0,
      filesRemoved: 0,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("chain-aware cleanup retires only obsolete selected media proposals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-media-chain-retention-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const day = 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1_000);
  const old = now - 16 * day;
  const firstSweep = now - 8 * day;
  try {
    const cases = [
      "obsolete",
      "valid",
      "pending",
      "active",
      "offline",
    ] as const;
    const hashes = new Map<string, string>();
    const proposalIds = new Map<string, string>();
    for (const [index, name] of cases.entries()) {
      const palette = ["#73D9A6", "#FA8A6A", "#F6C75A", "#61A8DF", "#BF83E6"][
        index
      ]!;
      const art = await renderMockCandidate("Cafe", 1, 1, palette);
      await saveImmutablePng(store.assetDir, art.spriteHash, art.sprite);
      await utimes(join(store.assetDir, `${art.spriteHash}.png`), old, old);
      const upload = store.recordUpload({
        accountId: "owner.testnet",
        plotId: `plot-main-n-${index}`,
        kind: "Logo",
        hash: art.spriteHash,
        layoutRevision: 1,
        createdAt: old,
      });
      const record = store.createMediaProposal({
        uploadId: upload.id,
        accountId: upload.accountId,
        plotId: upload.plotId,
        kind: upload.kind,
        assetHash: upload.hash,
        link: null,
        buildingType: "Cafe",
        level: 1,
        layoutRevision: 1,
        expectedMediaRevision: 1,
        createdAt: old,
      });
      hashes.set(name, upload.hash);
      proposalIds.set(name, record.id);
    }
    const chain: ChainGateway = {
      hasAccessKey: async () => false,
      plot: async (plotId) => {
        const index = Number(plotId.slice(-1));
        if (index === 4) throw new Error("RPC unavailable");
        const name = cases[index]!;
        const hash = hashes.get(name)!;
        const proposal = {
          revision: 2,
          owner: "owner.testnet",
          building_type: "Cafe",
          level: 1,
          layout_revision: 1,
          content: { asset_hash: hash, link: null },
        };
        return {
          plot: {
            building: { layout_revision: 1 },
            logo: {
              revision: index === 1 ? 1 : 2,
              pending: index === 2 ? proposal : null,
              active:
                index === 3
                  ? {
                      content: proposal.content,
                      approved_layout_revision: 1,
                      approved_at: old,
                    }
                  : null,
              last_decision: null,
            },
          },
        } as unknown as Awaited<ReturnType<ChainGateway["plot"]>>;
      },
    };
    const first = await sweepPrivateAssets(store, firstSweep, chain);
    assert.equal(first.uploadsExpired, 0);
    assert.equal(
      store.mediaProposal(proposalIds.get("obsolete")!)?.status,
      "superseded",
    );
    assert.equal(
      store.mediaProposal(proposalIds.get("pending")!)?.status,
      "submitted",
    );
    for (const name of ["valid", "active", "offline"])
      assert.equal(
        store.mediaProposal(proposalIds.get(name)!)?.status,
        "selected",
      );
    const second = await sweepPrivateAssets(store, now, chain);
    assert.equal(second.uploadsExpired, 1);
    assert.equal(second.filesRemoved, 1);
    await assert.rejects(
      access(join(store.assetDir, `${hashes.get("obsolete")}.png`)),
    );
    for (const name of ["valid", "pending", "active", "offline"])
      await access(join(store.assetDir, `${hashes.get(name)}.png`));
    assert.equal(
      store.mediaProposal(proposalIds.get("obsolete")!)?.status,
      "superseded",
    );
    const oldProposal = store.mediaProposal(proposalIds.get("obsolete")!)!;
    const replacementArt = await renderMockCandidate("Cafe", 1, 1, "#73D9A6");
    await saveImmutablePng(
      store.assetDir,
      replacementArt.spriteHash,
      replacementArt.sprite,
    );
    assert.equal(
      store.recordUpload({
        accountId: oldProposal.accountId,
        plotId: oldProposal.plotId,
        kind: oldProposal.kind,
        hash: oldProposal.assetHash,
        layoutRevision: oldProposal.layoutRevision,
        createdAt: now,
      }).id,
      oldProposal.uploadId,
    );
    const replacement = store.createOrReuseMediaProposal(
      {
        uploadId: oldProposal.uploadId,
        accountId: oldProposal.accountId,
        plotId: oldProposal.plotId,
        kind: oldProposal.kind,
        assetHash: oldProposal.assetHash,
        link: oldProposal.link,
        buildingType: oldProposal.buildingType,
        level: oldProposal.level,
        layoutRevision: oldProposal.layoutRevision,
        expectedMediaRevision: oldProposal.expectedMediaRevision,
        createdAt: now,
      },
      now - day,
      12,
      48,
      3,
    );
    assert.ok("record" in replacement && replacement.created);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing media database gains a checked-time column without losing proposals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-media-migration-"));
  const dbPath = join(dir, "estate.sqlite");
  const assetDir = join(dir, "assets");
  try {
    const first = new ApiStore(dbPath, assetDir);
    const upload = first.recordUpload({
      accountId: "owner.testnet",
      plotId: "plot-main-n-0",
      kind: "Logo",
      hash: "a".repeat(64),
      layoutRevision: 1,
      createdAt: 100,
    });
    const proposal = first.createMediaProposal({
      uploadId: upload.id,
      accountId: upload.accountId,
      plotId: upload.plotId,
      kind: upload.kind,
      assetHash: upload.hash,
      link: null,
      buildingType: "Cafe",
      level: 1,
      layoutRevision: 1,
      expectedMediaRevision: 1,
      createdAt: 100,
    });
    first.close();
    const oldSchema = new DatabaseSync(dbPath);
    oldSchema.exec("ALTER TABLE media_proposals DROP COLUMN last_checked_at");
    oldSchema.close();
    const upgraded = new ApiStore(dbPath, assetDir);
    assert.equal(upgraded.mediaProposal(proposal.id)?.status, "selected");
    assert.equal(upgraded.staleSelectedMediaProposals(101, 101, 1).length, 1);
    upgraded.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("old rejected images expire without losing their decisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-rejected-retention-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const now = Math.floor(Date.now() / 1_000);
  const old = now - 8 * 24 * 60 * 60;
  try {
    const art = await Promise.all(
      ["#73D9A6", "#FA8A6A", "#F6C75A", "#61A8DF"].map((palette) =>
        renderMockCandidate("Cafe", 1, 1, palette),
      ),
    );
    const uploads = [];
    const proposals = [];
    for (const item of art) {
      await saveImmutablePng(store.assetDir, item.spriteHash, item.sprite);
      await utimes(join(store.assetDir, `${item.spriteHash}.png`), old, old);
      const upload = store.recordUpload({
        accountId: "owner.testnet",
        plotId: "plot-main-n-0",
        kind: "Logo",
        hash: item.spriteHash,
        layoutRevision: 1,
        createdAt: old,
      });
      uploads.push(upload);
      proposals.push(
        store.createMediaProposal({
          uploadId: upload.id,
          accountId: upload.accountId,
          plotId: upload.plotId,
          kind: upload.kind,
          assetHash: upload.hash,
          link: null,
          buildingType: "Cafe",
          level: 1,
          layoutRevision: 1,
          expectedMediaRevision: 1,
          createdAt: old,
        }),
      );
    }
    store.markMediaSubmitted(proposals[0]!.id, 1);
    store.markMediaDecided(proposals[0]!.id, "rejected", old + 10, "No");
    store.markMediaSubmitted(proposals[1]!.id, 1);
    store.markMediaDecided(
      proposals[1]!.id,
      "rejected",
      now - 24 * 60 * 60,
      "Recent",
    );
    store.markMediaSubmitted(proposals[2]!.id, 1);
    store.markMediaDecided(proposals[2]!.id, "approved", old + 10, null);

    const result = await sweepPrivateAssets(store, now);
    assert.equal(result.uploadsExpired, 1);
    assert.equal(result.filesRemoved, 1);
    assert.equal(store.upload(uploads[0]!.id), null);
    assert.equal(store.canReadAsset(uploads[0]!.hash, "owner.testnet"), false);
    assert.equal(store.mediaProposal(proposals[0]!.id)?.status, "rejected");
    assert.equal(store.mediaProposal(proposals[0]!.id)?.decisionReason, "No");
    await assert.rejects(
      access(join(store.assetDir, `${uploads[0]!.hash}.png`)),
    );
    for (const upload of uploads.slice(1)) {
      assert.ok(store.upload(upload.id));
      await access(join(store.assetDir, `${upload.hash}.png`));
    }
    assert.equal(store.isPublicAsset(uploads[2]!.hash), true);
    await saveImmutablePng(store.assetDir, art[0]!.spriteHash, art[0]!.sprite);
    assert.equal(
      store.recordUpload({
        accountId: "owner.testnet",
        plotId: "plot-main-n-0",
        kind: "Logo",
        hash: art[0]!.spriteHash,
        layoutRevision: 1,
        createdAt: now,
      }).id,
      uploads[0]!.id,
    );
    assert.equal(store.canReadAsset(uploads[0]!.hash, "owner.testnet"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("asset cleanup waits for a reused image to be recorded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-upload-race-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const now = Math.floor(Date.now() / 1_000);
  const old = now - 8 * 24 * 60 * 60;
  try {
    const art = await renderMockCandidate("Cafe", 1, 1, "#73D9A6");
    const path = join(store.assetDir, `${art.spriteHash}.png`);
    await saveImmutablePng(store.assetDir, art.spriteHash, art.sprite);
    await utimes(path, old, old);
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writer = store.withAssetMutation(async () => {
      entered();
      await gate;
      store.recordUpload({
        accountId: "owner.testnet",
        plotId: "plot-main-n-0",
        kind: "Logo",
        hash: art.spriteHash,
        layoutRevision: 1,
        createdAt: now,
      });
    });
    await ready;
    let swept = false;
    const sweep = sweepPrivateAssets(store, now).then((result) => {
      swept = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const waitedForWriter = !swept;
    release();
    await writer;
    assert.equal(waitedForWriter, true);
    assert.equal((await sweep).filesRemoved, 0);
    await access(path);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejected paid candidate bytes expire without deleting its review record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-paid-retention-"));
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
    assert.equal(settings.enabled, true);
    if (!settings.enabled) return;
    const ledger = new PaidGenerationLedger(store.db, settings);
    const now = Math.floor(Date.now() / 1_000);
    const old = now - 8 * 24 * 60 * 60;
    const art = await renderMockCandidate("Cafe", 1, 1, "#73D9A6");
    await Promise.all([
      saveImmutablePng(store.assetDir, art.spriteHash, art.sprite),
      saveImmutablePng(store.assetDir, art.thumbnailHash, art.thumbnail),
    ]);
    for (const hash of [art.spriteHash, art.thumbnailHash])
      await utimes(join(store.assetDir, `${hash}.png`), old, old);
    const promptSpec = buildGenerationPrompt({
      buildingType: "Cafe",
      level: 1,
      variant: 1,
      palette: "#73D9A6",
      description: "A cafe",
    });
    const job = ledger.reserve({
      accountId: "one.testnet",
      plotId: "plot-main-n-0",
      idempotencyKey: "rejected-retention-123",
      snapshot: {
        buildingType: "Cafe",
        level: 1,
        layoutRevision: 1,
        appearanceRevision: 1,
        promptSpec,
      },
      now: old,
    });
    ledger.claim("retention_worker", old + 1);
    const first = ledger.beginAttempt(job.id, "retention_worker", old + 1);
    ledger.finishAttempt({
      jobId: job.id,
      workerId: "retention_worker",
      clientRequestId: first.clientRequestId,
      outcome: "accepted",
      candidate: art,
      now: old + 1,
    });
    for (let attemptNo = 2; attemptNo <= 4; attemptNo++) {
      const attempt = ledger.beginAttempt(
        job.id,
        "retention_worker",
        old + attemptNo,
      );
      ledger.finishAttempt({
        jobId: job.id,
        workerId: "retention_worker",
        clientRequestId: attempt.clientRequestId,
        outcome: "rejected",
        now: old + attemptNo,
      });
    }
    assert.equal(ledger.job(job.id)?.status, "complete");
    ledger.reviewCandidate({
      jobId: job.id,
      ordinal: 1,
      decision: "rejected",
      reason: "Wrong perspective",
      now: old + 5,
      reviewer: "reviewer",
    });
    assert.equal(
      ledger.canReadCandidateAsset(art.spriteHash, "one.testnet"),
      false,
    );
    const result = await sweepPrivateAssets(store, now);
    assert.equal(result.filesRemoved, 2);
    assert.equal(
      ledger.candidates(job.id)[0]?.reviewReason,
      "Wrong perspective",
    );
    await assert.rejects(access(join(store.assetDir, `${art.spriteHash}.png`)));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
