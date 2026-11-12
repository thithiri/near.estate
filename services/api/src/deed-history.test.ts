import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PlotStats, validateCitySeed } from "@estate/shared";
import { createApiApp } from "./app.js";
import {
  captureDeedHistory,
  verifyActiveCityCutover,
  verifyDeedHistoryCutover,
} from "./deed-history.js";
import { ImpressionLedger } from "./impression-ledger.js";
import { readPlotStats } from "./plot-stats.js";
import { ApiStore } from "./store.js";

test("moved deed history stays separate and frozen after the old plot is reused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-deed-history-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const db = store.db;
  const now = Math.floor(Date.UTC(2026, 10, 12, 12) / 1_000);
  const source = "plot-main-n-2";
  const target = "plot-main-n-3";
  try {
    const ledger = new ImpressionLedger(db);
    ledger.issueSession("history-session", now);
    ledger.recordBatch(
      "history-session",
      [
        {
          eventId: randomUUID(),
          plotId: source,
          surface: "Logo",
          observedAt: now * 1_000 - 2_000,
          msVisible: 1_500,
        },
      ],
      now,
    );
    db.exec(`
      CREATE TABLE indexer_state (id INTEGER PRIMARY KEY, contract_id TEXT, last_height INTEGER, last_timestamp_ns TEXT, updated_at INTEGER);
      CREATE TABLE chain_events (location_id TEXT, block_height INTEGER);
      CREATE TABLE plot_daily_stats (plot_id TEXT, day TEXT, parks INTEGER, tickets INTEGER);
    `);
    db.prepare("INSERT INTO indexer_state VALUES (1, ?, ?, ?, ?)").run(
      "estate.testnet",
      122,
      String(BigInt(now) * 1_000_000_000n),
      now * 1_000,
    );
    db.prepare("INSERT INTO chain_events VALUES (?, ?)").run(source, 120);
    db.prepare("INSERT INTO plot_daily_stats VALUES (?, ?, ?, ?)").run(
      source,
      "2026-11-12",
      2,
      1,
    );
    db.prepare("INSERT INTO plot_daily_stats VALUES (?, ?, ?, ?)").run(
      target,
      "2026-11-12",
      4,
      0,
    );
    db.prepare(
      `INSERT INTO media_uploads
       (id, account_id, plot_id, kind, hash, layout_revision, created_at)
       VALUES ('upload-1', 'owner.testnet', ?, 'Logo', ?, 1, ?)`,
    ).run(source, "a".repeat(64), now);
    db.prepare(
      `INSERT INTO media_proposals
       (id, upload_id, account_id, plot_id, kind, asset_hash, link,
        building_type, level, layout_revision, expected_media_revision, status, created_at)
       VALUES ('proposal-1', 'upload-1', 'owner.testnet', ?, 'Logo', ?, NULL,
        'Shop', 2, 1, 0, 'submitted', ?)`,
    ).run(source, "a".repeat(64), now);
    db.prepare(
      `INSERT INTO media_upload_attempts (id, account_id, plot_id, created_at)
       VALUES ('attempt-1', 'owner.testnet', ?, ?)`,
    ).run(source, now);
    db.prepare(
      `INSERT INTO generation_jobs
       (id, account_id, plot_id, building_type, level, layout_revision,
        description, candidates_json, created_at, status)
       VALUES ('job-1', 'owner.testnet', ?, 'Shop', 2, 1,
        'Existing facade', '[]', ?, 'approved')`,
    ).run(source, now);
    db.exec(
      "CREATE TABLE paid_generation_jobs (id TEXT PRIMARY KEY, plot_id TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO paid_generation_jobs VALUES ('paid-job-1', ?)").run(
      source,
    );
    const moves = [{ from: source, to: target }];
    const reviewedMap = {
      sourceCityVersion: 1,
      targetCityVersion: 2,
      status: "reviewed",
      moves,
    };
    const activeCheck = (
      deedAtMs = now * 1_000,
      impressionAfterMs = now * 1_000 + 1,
      intakeEnabled = true,
    ) =>
      verifyActiveCityCutover(
        db,
        "estate.testnet",
        reviewedMap,
        deedAtMs,
        impressionAfterMs,
        intakeEnabled,
      );
    assert.throws(() => activeCheck(), /deed_history_links/);
    assert.throws(
      () => captureDeedHistory(db, "estate.testnet", moves, 123, now * 1_000),
      /frozen contract block/,
    );
    db.prepare("INSERT INTO chain_events VALUES (?, ?)").run(source, 123);
    assert.throws(
      () => captureDeedHistory(db, "estate.testnet", moves, 122, now * 1_000),
      /Events after the frozen block/,
    );
    db.prepare("DELETE FROM chain_events WHERE block_height = 123").run();
    assert.throws(
      () =>
        captureDeedHistory(db, "estate.testnet", moves, 122, now * 1_000 - 1),
      /Impressions after the cutover/,
    );
    const capture = captureDeedHistory(
      db,
      "estate.testnet",
      moves,
      122,
      now * 1_000,
    );
    assert.deepEqual(capture, { cursorHeight: 122, links: 1, days: 1 });
    assert.deepEqual(
      verifyDeedHistoryCutover(db, "estate.testnet", moves, 122, now * 1_000),
      { ...capture, workflowRowsVerified: 5 },
    );
    assert.deepEqual(activeCheck(), { ...capture, workflowRowsVerified: 5 });
    assert.throws(
      () => activeCheck(now * 1_000 + 1, now * 1_000 + 2),
      /link differs/,
    );
    assert.throws(() => activeCheck(0), /cutover time/);
    assert.throws(
      () => activeCheck(now * 1_000, now * 1_000 - 1),
      /impression cutoff must follow/,
    );
    assert.deepEqual(activeCheck(now * 1_000, 0, false), {
      ...capture,
      workflowRowsVerified: 5,
    });
    assert.throws(
      () =>
        verifyActiveCityCutover(
          db,
          "estate.testnet",
          { ...reviewedMap, status: "draft" },
          now * 1_000,
          now * 1_000 + 1,
          true,
        ),
      /Invalid literal value|Invalid input/,
    );
    db.prepare("INSERT INTO chain_events VALUES (?, ?)").run(source, 123);
    db.prepare(
      `INSERT INTO media_upload_attempts (id, account_id, plot_id, created_at)
       VALUES ('new-plot-attempt', 'new-owner.testnet', ?, ?)`,
    ).run(source, now + 1);
    assert.deepEqual(activeCheck(), { ...capture, workflowRowsVerified: 5 });
    assert.throws(
      () =>
        verifyDeedHistoryCutover(db, "estate.testnet", moves, 122, now * 1_000),
      /Events after the frozen block/,
    );
    db.prepare("DELETE FROM chain_events WHERE block_height = 123").run();
    db.prepare(
      `INSERT INTO impression_events
       (event_id, session_hash, plot_id, surface, observed_at_ms, minute_ms,
        ms_visible, credited_ms, counted, received_at_ms)
       VALUES (?, 'history-session', ?, 'Logo', ?, ?, 1000, 1000, 1, ?)`,
    ).run(randomUUID(), source, now * 1_000 + 1, now * 1_000, now * 1_000 + 1);
    assert.deepEqual(activeCheck(), { ...capture, workflowRowsVerified: 5 });
    assert.throws(
      () =>
        verifyDeedHistoryCutover(db, "estate.testnet", moves, 122, now * 1_000),
      /Impressions after the cutover/,
    );
    db.prepare("DELETE FROM impression_events WHERE received_at_ms > ?").run(
      now * 1_000,
    );
    db.prepare(
      "DELETE FROM media_upload_attempts WHERE id = 'new-plot-attempt'",
    ).run();
    assert.throws(
      () =>
        verifyDeedHistoryCutover(
          db,
          "estate.testnet",
          [{ from: source, to: "plot-main-n-4" }],
          122,
          now * 1_000,
        ),
      /link differs/,
    );
    for (const table of [
      "media_uploads",
      "media_upload_attempts",
      "media_proposals",
      "generation_jobs",
      "paid_generation_jobs",
    ]) {
      assert.equal(
        (
          db.prepare(`SELECT plot_id FROM ${table}`).get() as {
            plot_id: string;
          }
        ).plot_id,
        target,
      );
    }
    db.prepare(
      `INSERT INTO media_upload_attempts (id, account_id, plot_id, created_at)
       VALUES ('stray-attempt', 'owner.testnet', ?, ?)`,
    ).run(source, now);
    assert.throws(
      () =>
        verifyDeedHistoryCutover(db, "estate.testnet", moves, 122, now * 1_000),
      /workflow remains/,
    );
    db.prepare(
      "DELETE FROM media_upload_attempts WHERE id = 'stray-attempt'",
    ).run();
    db.prepare("INSERT INTO chain_events VALUES (?, ?)").run(source, 123);
    assert.throws(
      () =>
        verifyDeedHistoryCutover(db, "estate.testnet", moves, 122, now * 1_000),
      /Events after the frozen block/,
    );
    db.prepare("DELETE FROM chain_events WHERE block_height = 123").run();
    db.prepare(
      "DELETE FROM paid_generation_jobs WHERE id = 'paid-job-1'",
    ).run();
    assert.throws(
      () =>
        verifyDeedHistoryCutover(db, "estate.testnet", moves, 122, now * 1_000),
      /Moved deed workflow row missing/,
    );
    assert.equal(store.mediaProposal("proposal-1")?.plotId, target);
    assert.equal(store.upload("upload-1")?.plotId, target);
    const first = PlotStats.parse(readPlotStats(db, target, now));
    assert.equal(first.totals.parks, 4);
    assert.equal(first.linkedHistory?.sourcePlotId, source);
    assert.equal(first.linkedHistory?.totals.parks, 2);
    assert.equal(first.linkedHistory?.totals.tickets, 1);
    assert.equal(first.linkedHistory?.totals.impressions, 1);
    const citySeed = validateCitySeed(
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL("../../../contracts/estate/seed-v2.json", import.meta.url),
          ),
          "utf8",
        ),
      ),
    );
    const app = createApiApp({
      store,
      chain: null,
      appOrigin: "http://localhost:8080",
      citySeed,
      clock: () => now,
    });
    const response = await app.request(
      `http://localhost:8080/stats/plots/${target}`,
    );
    assert.equal(response.status, 200);
    assert.equal(
      PlotStats.parse(await response.json()).linkedHistory?.totals.parks,
      2,
    );
    db.prepare("UPDATE plot_daily_stats SET parks = 9 WHERE plot_id = ?").run(
      source,
    );
    db.prepare(
      "UPDATE impression_daily_stats SET impressions = 6 WHERE plot_id = ?",
    ).run(source);
    const after = PlotStats.parse(readPlotStats(db, target, now));
    assert.equal(after.linkedHistory?.totals.parks, 2);
    assert.equal(after.linkedHistory?.totals.impressions, 1);
    assert.equal(readPlotStats(db, source, now).totals.parks, 9);
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE deed_history_days SET parks = 9 WHERE source_plot_id = ?",
          )
          .run(source),
      /deed history is immutable/,
    );
    assert.throws(
      () => captureDeedHistory(db, "estate.testnet", moves, 122, now * 1_000),
      /already captured/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two deed moves are captured atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-deed-atomic-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const db = store.db;
  try {
    new ImpressionLedger(db);
    db.exec(`
      CREATE TABLE indexer_state (id INTEGER PRIMARY KEY, contract_id TEXT, last_height INTEGER);
      CREATE TABLE chain_events (location_id TEXT, block_height INTEGER);
      CREATE TABLE plot_daily_stats (plot_id TEXT, day TEXT, parks INTEGER, tickets INTEGER);
      INSERT INTO indexer_state VALUES (1, 'estate.testnet', 100);
      INSERT INTO plot_daily_stats VALUES ('plot-main-n-2', '2026-11-12', 2, 0);
      INSERT INTO chain_events VALUES ('plot-market-n-1', 101);
    `);
    assert.throws(
      () =>
        captureDeedHistory(
          db,
          "estate.testnet",
          [
            { from: "plot-main-n-2", to: "plot-main-n-3" },
            { from: "plot-market-n-1", to: "plot-market-n-2" },
          ],
          100,
          Date.UTC(2026, 10, 12, 12),
        ),
      /Events after the frozen block/,
    );
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deed_history_links'",
        )
        .get(),
      undefined,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow conflict rolls back deed history and all row moves", () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-deed-conflict-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  const db = store.db;
  const source = "plot-main-n-2";
  const target = "plot-main-n-3";
  try {
    new ImpressionLedger(db);
    db.exec(`
      CREATE TABLE indexer_state (id INTEGER PRIMARY KEY, contract_id TEXT, last_height INTEGER);
      CREATE TABLE chain_events (location_id TEXT, block_height INTEGER);
      CREATE TABLE plot_daily_stats (plot_id TEXT, day TEXT, parks INTEGER, tickets INTEGER);
      INSERT INTO indexer_state VALUES (1, 'estate.testnet', 100);
    `);
    for (const [id, plotId] of [
      ["old", source],
      ["target", target],
    ] as Array<[string, string]>)
      db.prepare(
        `INSERT INTO media_upload_attempts (id, account_id, plot_id, created_at)
         VALUES (?, 'owner.testnet', ?, 1)`,
      ).run(id, plotId);
    assert.throws(
      () =>
        captureDeedHistory(
          db,
          "estate.testnet",
          [{ from: source, to: target }],
          100,
          Date.UTC(2026, 10, 12, 12),
        ),
      /already has media_upload_attempts records/,
    );
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deed_history_links'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      (
        db
          .prepare("SELECT plot_id FROM media_upload_attempts WHERE id = 'old'")
          .get() as {
          plot_id: string;
        }
      ).plot_id,
      source,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator command plans without writing and rejects an unreviewed map", () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-history-command-"));
  const dbPath = join(dir, "estate.sqlite");
  const mapPath = join(dir, "moves.json");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE indexer_state (id INTEGER PRIMARY KEY, contract_id TEXT, last_height INTEGER);
      INSERT INTO indexer_state VALUES (1, 'estate.testnet', 100);
    `);
    writeFileSync(
      mapPath,
      JSON.stringify({
        sourceCityVersion: 1,
        targetCityVersion: 2,
        status: "draft-needs-review",
        moves: [{ from: "plot-main-n-2", to: "plot-main-n-3" }],
      }),
    );
    const args = [
      "--import",
      "tsx",
      join(root, "scripts/snapshot-deed-history.ts"),
      "--db",
      dbPath,
      "--contract",
      "estate.testnet",
      "--height",
      "100",
      "--at-ms",
      String(Date.UTC(2026, 10, 12, 12)),
      "--map",
      mapPath,
    ];
    const plan = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).applied, false);
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deed_history_links'",
        )
        .get(),
      undefined,
    );
    const apply = spawnSync(process.execPath, [...args, "--apply"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(apply.status, 0);
    assert.match(apply.stderr, /mark the deed move map reviewed/);
    const rehearsal = spawnSync(process.execPath, [...args, "--rehearse"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(rehearsal.status, 0);
    assert.match(
      rehearsal.stderr,
      /current media API database; missing media_uploads/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator rehearses draft deed moves and verifies an applied cutover read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-history-rehearsal-"));
  const dbPath = join(dir, "estate.sqlite");
  const mapPath = join(dir, "moves.json");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const store = new ApiStore(dbPath, join(dir, "assets"));
  const db = store.db;
  try {
    new ImpressionLedger(db);
    db.exec(`
      CREATE TABLE indexer_state (id INTEGER PRIMARY KEY, contract_id TEXT, last_height INTEGER);
      CREATE TABLE chain_events (location_id TEXT, block_height INTEGER);
      CREATE TABLE plot_daily_stats (plot_id TEXT, day TEXT, parks INTEGER, tickets INTEGER);
      INSERT INTO indexer_state VALUES (1, 'estate.testnet', 100);
      INSERT INTO plot_daily_stats VALUES ('plot-main-n-2', '2026-11-12', 2, 1);
    `);
    db.prepare(
      `INSERT INTO media_upload_attempts (id, account_id, plot_id, created_at)
       VALUES ('attempt-1', 'owner.testnet', 'plot-main-n-2', 1)`,
    ).run();
    writeFileSync(
      mapPath,
      JSON.stringify({
        sourceCityVersion: 1,
        targetCityVersion: 2,
        status: "draft-needs-review",
        moves: [{ from: "plot-main-n-2", to: "plot-main-n-3" }],
      }),
    );
    const rehearsal = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(root, "scripts/snapshot-deed-history.ts"),
        "--db",
        dbPath,
        "--contract",
        "estate.testnet",
        "--height",
        "100",
        "--at-ms",
        String(Date.UTC(2026, 10, 12, 12)),
        "--map",
        mapPath,
        "--rehearse",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(rehearsal.status, 0, rehearsal.stderr);
    assert.deepEqual(JSON.parse(rehearsal.stdout), {
      applied: false,
      rehearsed: true,
      sourceReadOnly: true,
      mapStatus: "draft-needs-review",
      contractId: "estate.testnet",
      cutoverHeight: 100,
      cutoverAtMs: Date.UTC(2026, 10, 12, 12),
      cursorHeight: 100,
      links: 1,
      days: 1,
      workflowRowsVerified: 1,
      workflowRowsMoved: 1,
      moves: [{ from: "plot-main-n-2", to: "plot-main-n-3" }],
    });
    assert.equal(
      (
        db.prepare("SELECT plot_id FROM media_upload_attempts").get() as {
          plot_id: string;
        }
      ).plot_id,
      "plot-main-n-2",
    );
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deed_history_links'",
        )
        .get(),
      undefined,
    );
    writeFileSync(
      mapPath,
      JSON.stringify({
        sourceCityVersion: 1,
        targetCityVersion: 2,
        status: "reviewed",
        moves: [{ from: "plot-main-n-2", to: "plot-main-n-3" }],
      }),
    );
    captureDeedHistory(
      db,
      "estate.testnet",
      [{ from: "plot-main-n-2", to: "plot-main-n-3" }],
      100,
      Date.UTC(2026, 10, 12, 12),
    );
    const verifyArgs = [
      "--import",
      "tsx",
      join(root, "scripts/snapshot-deed-history.ts"),
      "--db",
      dbPath,
      "--contract",
      "estate.testnet",
      "--height",
      "100",
      "--at-ms",
      String(Date.UTC(2026, 10, 12, 12)),
      "--map",
      mapPath,
      "--verify",
    ];
    const verification = spawnSync(process.execPath, verifyArgs, {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(verification.status, 0, verification.stderr);
    assert.deepEqual(JSON.parse(verification.stdout), {
      applied: false,
      verified: true,
      sourceReadOnly: true,
      contractId: "estate.testnet",
      cutoverHeight: 100,
      cutoverAtMs: Date.UTC(2026, 10, 12, 12),
      cursorHeight: 100,
      links: 1,
      days: 1,
      workflowRowsVerified: 1,
      moves: [{ from: "plot-main-n-2", to: "plot-main-n-3" }],
    });
    db.prepare("UPDATE indexer_state SET last_height = 101 WHERE id = 1").run();
    db.prepare("INSERT INTO chain_events VALUES ('plot-main-n-2', 101)").run();
    const strictAfterReuse = spawnSync(process.execPath, verifyArgs, {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(strictAfterReuse.status, 0);
    assert.match(strictAfterReuse.stderr, /Events after the frozen block/);
    const activeAfterReuse = spawnSync(
      process.execPath,
      [...verifyArgs, "--allow-reused-source"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(activeAfterReuse.status, 0, activeAfterReuse.stderr);
    assert.equal(
      JSON.parse(activeAfterReuse.stdout).allowReusedSourceActivity,
      true,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
