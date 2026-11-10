import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { attachProviderCostReport, readBetaMetrics } from "./beta-metrics.mjs";

const now = Date.parse("2026-11-10T12:00:00Z") / 1_000;
const city = JSON.parse(
  readFileSync(new URL("../contracts/estate/seed.json", import.meta.url)),
);

test("empty beta data reports missing measurements rather than zero rates", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const report = readBetaMetrics(db, now);
    assert.equal(report.source.indexedThroughHeight, null);
    assert.equal(report.source.completeThroughNow, false);
    assert.equal(report.onboarding.medianSecondsToFirstPark, null);
    assert.equal(report.parking.indexedOccupancy, null);
    assert.equal(report.parking.timeWeightedOccupancyPercent, null);
    assert.equal(report.generation.paidCandidateApprovalRate, null);
    assert.equal(report.provider.actualInvoicedCostUsdMicros, null);
  } finally {
    db.close();
  }
});

test("legacy economy aggregates cannot claim complete amount coverage", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE indexer_state (id INTEGER, contract_id TEXT, start_height INTEGER, last_height INTEGER, last_timestamp_ns TEXT);
      CREATE TABLE economy_daily_stats (day TEXT, curb_parks INTEGER, tower_parks INTEGER, collections INTEGER, tickets INTEGER, gross TEXT, known_coin_costs TEXT);
    `);
    db.prepare(
      "INSERT INTO indexer_state VALUES (1, 'city.testnet', 1, 1, ?)",
    ).run((BigInt(now - 5) * 1_000_000_000n).toString());
    db.prepare(
      "INSERT INTO economy_daily_stats VALUES ('2026-11-10', 1, 0, 1, 0, '100', '0')",
    ).run();
    const report = readBetaMetrics(db, now);
    assert.equal(report.coinPacing.amountCoverageComplete, false);
    assert.match(report.coinPacing.note, /older economy aggregate schema/);
  } finally {
    db.close();
  }
});

test("beta report separates measured activity from incomplete amounts and invoices", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE indexer_state (id INTEGER, contract_id TEXT, start_height INTEGER, last_height INTEGER, last_timestamp_ns TEXT);
      CREATE TABLE indexed_blocks (height INTEGER, timestamp_ns TEXT);
      CREATE TABLE chain_events (block_height INTEGER, block_day TEXT, event_name TEXT, payload_json TEXT, log_index INTEGER, data_index INTEGER);
      CREATE TABLE economy_daily_stats (day TEXT, curb_parks INTEGER, tower_parks INTEGER, collections INTEGER, tickets INTEGER, gross TEXT, known_coin_costs TEXT, unpriced_cost_events INTEGER, unpriced_grant_events INTEGER);
      CREATE TABLE paid_generation_candidates (reviewed_at INTEGER, review_status TEXT);
      CREATE TABLE paid_generation_attempts (started_at INTEGER, finished_at INTEGER);
      CREATE TABLE paid_generation_days (utc_day INTEGER, charged_usd_micros INTEGER);
    `);
    const block = db.prepare("INSERT INTO indexed_blocks VALUES (?, ?)");
    const event = db.prepare(
      "INSERT INTO chain_events VALUES (?, ?, ?, ?, 0, 0)",
    );
    const entries = [
      [1, now - 100, "player_registered", { account_id: "a.testnet" }],
      [
        2,
        now - 80,
        "parked",
        {
          driver: "a.testnet",
          session_id: 1,
          location_id: "plot-main-n-0",
          facility: "Curb",
          expires_at: now + 300,
        },
      ],
      [3, now - 70, "player_registered", { account_id: "b.testnet" }],
      [
        4,
        now - 30,
        "parked",
        {
          driver: "b.testnet",
          session_id: 2,
          location_id: "plot-main-n-0",
          facility: "Curb",
          expires_at: now + 300,
        },
      ],
      [5, now - 20, "plot_seeded", { plot_id: "plot-main-n-0" }],
      [6, now - 10, "collected", { session_id: 1 }],
    ];
    for (const [height, second, name, payload] of entries) {
      block.run(height, (BigInt(second) * 1_000_000_000n).toString());
      event.run(height, "2026-11-10", name, JSON.stringify(payload));
    }
    db.prepare("INSERT INTO indexer_state VALUES (1, ?, 1, 6, ?)").run(
      "city.testnet",
      (BigInt(now - 5) * 1_000_000_000n).toString(),
    );
    db.prepare(
      "INSERT INTO economy_daily_stats VALUES (?, 2, 1, 2, 1, ?, ?, 1, 2)",
    ).run("2026-11-10", "9007199254740993", "123");
    db.prepare("INSERT INTO paid_generation_candidates VALUES (?, ?)").run(
      now - 20,
      "approved",
    );
    db.prepare("INSERT INTO paid_generation_candidates VALUES (?, ?)").run(
      now - 15,
      "rejected",
    );
    db.prepare("INSERT INTO paid_generation_attempts VALUES (?, ?)").run(
      now - 17,
      now - 10,
    );
    db.prepare("INSERT INTO paid_generation_attempts VALUES (?, ?)").run(
      now - 14,
      now - 1,
    );
    db.prepare("INSERT INTO paid_generation_days VALUES (?, 3000)").run(
      Math.floor(now / 86_400),
    );

    const report = readBetaMetrics(db, now);
    assert.equal(report.source.completeThroughNow, true);
    assert.equal(report.onboarding.registrations, 2);
    assert.equal(report.onboarding.firstParks, 2);
    assert.equal(report.onboarding.medianSecondsToFirstPark, 30);
    assert.equal(report.parking.towerShareOfParks, 1 / 3);
    assert.deepEqual(report.parking.indexedOccupancy?.curbs, {
      occupied: 1,
      capacity: 2,
      percent: 0.5,
    });
    assert.equal(report.coinPacing.grossEarnedSubunits, "9007199254740993");
    assert.equal(report.coinPacing.amountCoverageComplete, false);
    assert.equal(report.coinPacing.unpricedGrantEvents, 2);
    assert.equal(report.generation.paidCandidateApprovalRate, 0.5);
    assert.equal(report.provider.medianAttemptSeconds, 10);
    assert.equal(report.provider.conservativeBudgetDebitUsdMicros, "3000");
    assert.equal(report.provider.actualInvoicedCostUsdMicros, null);
  } finally {
    db.close();
  }
});

test("seven-day occupancy counts curb settlements and tower expiry against seeded capacity", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE indexer_state (id INTEGER, contract_id TEXT, start_height INTEGER, last_height INTEGER, last_timestamp_ns TEXT);
      CREATE TABLE indexed_blocks (height INTEGER, timestamp_ns TEXT);
      CREATE TABLE chain_events (block_height INTEGER, block_day TEXT, event_name TEXT, payload_json TEXT, log_index INTEGER, data_index INTEGER);
    `);
    const firstSecond = (Math.floor(now / 86_400) - 6) * 86_400;
    const block = db.prepare("INSERT INTO indexed_blocks VALUES (?, ?)");
    const event = db.prepare(
      "INSERT INTO chain_events VALUES (?, '2026-11-10', ?, ?, 0, ?)",
    );
    const addBlock = (height, second) =>
      block.run(height, (BigInt(second) * 1_000_000_000n).toString());
    addBlock(1, firstSecond - 100);
    for (const [index, plot] of city.plots.entries())
      event.run(1, "plot_seeded", JSON.stringify({ plot_id: plot.id }), index);
    for (const [index, site] of city.npcSites
      .filter((item) => item.role === "ParkingTower")
      .entries())
      event.run(
        1,
        "npc_site_seeded",
        JSON.stringify({ site_id: site.id }),
        city.plots.length + index,
      );
    addBlock(2, firstSecond - 30);
    event.run(
      2,
      "parked",
      JSON.stringify({
        session_id: 1,
        location_id: city.plots[0].id,
        facility: "Curb",
        expires_at: firstSecond + 100,
      }),
      0,
    );
    addBlock(3, firstSecond + 50);
    event.run(3, "collected", JSON.stringify({ session_id: 1 }), 0);
    const tower = city.npcSites.find((site) => site.role === "ParkingTower");
    addBlock(4, now - 200);
    event.run(
      4,
      "parked",
      JSON.stringify({
        session_id: 2,
        location_id: tower.id,
        facility: "Tower",
        expires_at: now - 100,
      }),
      0,
    );
    addBlock(5, now - 5);
    db.prepare(
      "INSERT INTO indexer_state VALUES (1, 'city.testnet', 1, 5, ?)",
    ).run((BigInt(now - 5) * 1_000_000_000n).toString());

    const report = readBetaMetrics(db, now);
    const occupancy = report.parking.timeWeightedOccupancy;
    const duration = now - 5 - firstSecond;
    assert.equal(occupancy?.curbs.occupiedSlotSeconds, 50);
    assert.equal(occupancy?.curbs.availableSlotSeconds, 160 * duration);
    assert.equal(occupancy?.towers.occupiedSlotSeconds, 100);
    assert.equal(occupancy?.towers.availableSlotSeconds, 96 * duration);
    assert.equal(
      report.parking.timeWeightedOccupancyPercent,
      150 / (256 * duration),
    );
  } finally {
    db.close();
  }
});

test("provider cost export needs every day and one scoped project", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const report = readBetaMetrics(db, now);
    const first = Date.parse(`${report.windowUtc.firstDay}T00:00:00Z`) / 1_000;
    const page = {
      object: "page",
      has_more: false,
      next_page: null,
      data: Array.from({ length: 7 }, (_, index) => ({
        object: "bucket",
        start_time: first + index * 86_400,
        end_time: first + (index + 1) * 86_400,
        results: [
          {
            object: "organization.costs.result",
            project_id: "proj_estate",
            amount: { currency: "usd", value: index === 3 ? 0.06 : 0 },
          },
        ],
      })),
    };
    const measured = attachProviderCostReport(report, page, "proj_estate");
    assert.equal(measured.provider.actualProviderCostUsdMicros, "60000");
    assert.equal(measured.provider.actualInvoicedCostUsdMicros, null);
    assert.equal(measured.provider.costSource?.projectId, "proj_estate");
    assert.equal(report.provider.actualProviderCostUsdMicros, null);
    assert.throws(
      () =>
        attachProviderCostReport(
          report,
          { ...page, data: page.data.slice(1) },
          "proj_estate",
        ),
      /missing a day/,
    );
    assert.throws(
      () =>
        attachProviderCostReport(
          report,
          { ...page, has_more: true, next_page: "next" },
          "proj_estate",
        ),
      /complete page/,
    );
    assert.throws(
      () => attachProviderCostReport(report, page, "proj_other"),
      /unscoped or invalid amount/,
    );
  } finally {
    db.close();
  }
});
