import { readFileSync } from "node:fs";

const DAY_SECONDS = 86_400;
const city = JSON.parse(
  readFileSync(
    new URL("../contracts/estate/seed.json", import.meta.url),
    "utf8",
  ),
);
const variableCity = JSON.parse(
  readFileSync(
    new URL("../contracts/estate/seed-v2.json", import.meta.url),
    "utf8",
  ),
);
const variableCityRelease = JSON.parse(
  readFileSync(
    new URL(
      "../deployments/variable-city-release-db33845c80179c1a.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const deployment = JSON.parse(
  readFileSync(new URL("../deployments/testnet.json", import.meta.url), "utf8"),
);
const variablePlotWidths = new Map(
  variableCity.plots.map((plot) => [plot.id, plot.frontageUnits]),
);
const variableCurbCapacity = [...variablePlotWidths.values()].reduce(
  (sum, width) => sum + width,
  0,
);
if (variablePlotWidths.size !== 100 || variableCurbCapacity !== 180)
  throw new Error("Version-2 curb seed has unexpected capacity");
const towerIds = new Set(
  city.npcSites
    .filter((site) => site.role === "ParkingTower")
    .map((site) => site.id),
);

function hasTable(db, name) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

function capacityVersion(cursor, cursorSecond) {
  return cursor?.contract_id === variableCityRelease.contractId &&
    deployment.contractId === variableCityRelease.contractId &&
    deployment.citySeedVersion === 2 &&
    variableCityRelease.status === "active" &&
    Number.isSafeInteger(cursor?.last_height) &&
    cursor.last_height >= variableCityRelease.frozenBlock.height &&
    cursorSecond !== null &&
    cursorSecond >= Math.ceil(variableCityRelease.reopenedAtMs / 1_000)
    ? 2
    : 1;
}

function completeLegacySeed(plots) {
  return (
    plots.size === city.plots.length &&
    city.plots.every((plot) => plots.has(plot.id))
  );
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function providerTokenUsage(attempts) {
  let reportedAttempts = 0;
  let input = 0n;
  let output = 0n;
  let total = 0n;
  for (const attempt of attempts) {
    if (attempt.usage_json === null) continue;
    let usage;
    try {
      usage = JSON.parse(attempt.usage_json);
    } catch {
      throw new Error("Stored provider token usage is invalid JSON");
    }
    if (
      !usage ||
      !["inputTokens", "outputTokens", "totalTokens"].every(
        (field) => Number.isSafeInteger(usage[field]) && usage[field] >= 0,
      )
    )
      throw new Error("Stored provider token usage has invalid counts");
    reportedAttempts++;
    input += BigInt(usage.inputTokens);
    output += BigInt(usage.outputTokens);
    total += BigInt(usage.totalTokens);
  }
  return {
    reportedAttempts,
    inputTokens: reportedAttempts ? input.toString() : null,
    outputTokens: reportedAttempts ? output.toString() : null,
    totalTokens: reportedAttempts ? total.toString() : null,
  };
}

function eventRows(db, firstDay, lastDay) {
  if (!hasTable(db, "chain_events") || !hasTable(db, "indexed_blocks"))
    return [];
  return db
    .prepare(
      `SELECT event_name, payload_json, timestamp_ns
       FROM chain_events AS event
       JOIN indexed_blocks AS block ON block.height = event.block_height
       WHERE event.block_day BETWEEN ? AND ?
         AND event.event_name IN ('player_registered', 'parked')
       ORDER BY event.block_height, event.log_index, event.data_index`,
    )
    .all(firstDay, lastDay);
}

function unpricedEvents(db, firstDay, lastDay) {
  if (!hasTable(db, "chain_events")) return { costs: 0, grants: 0 };
  const rows = db
    .prepare(
      `SELECT event_name, payload_json FROM chain_events
       WHERE block_day BETWEEN ? AND ?
         AND event_name IN ('player_registered', 'car_minted', 'cosmetic_bought')`,
    )
    .all(firstDay, lastDay);
  let costs = 0;
  let grants = 0;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json);
    if (row.event_name === "player_registered" && payload.grant === undefined)
      grants++;
    if (
      (row.event_name === "car_minted" ||
        row.event_name === "cosmetic_bought") &&
      payload.cost === undefined
    )
      costs++;
  }
  return { costs, grants };
}

function indexedOccupancy(db, cursorSecond, version) {
  if (cursorSecond === null || !hasTable(db, "chain_events")) return null;
  const plots = new Set();
  const towers = new Set();
  const parked = new Map();
  const opens = db.prepare(
    `SELECT event_name, payload_json FROM chain_events
     WHERE event_name IN ('plot_seeded', 'npc_site_seeded', 'parked')`,
  );
  for (const row of opens.iterate()) {
    const payload = JSON.parse(row.payload_json);
    if (row.event_name === "plot_seeded") plots.add(payload.plot_id);
    else if (row.event_name === "npc_site_seeded") {
      if (towerIds.has(payload.site_id)) towers.add(payload.site_id);
    } else if (payload.expires_at > cursorSecond) {
      parked.set(payload.session_id, payload);
    }
  }
  if (!plots.size || (version === 2 && !completeLegacySeed(plots))) return null;
  const settlements = db.prepare(
    `SELECT payload_json FROM chain_events
     WHERE event_name IN ('collected', 'expired', 'ticketed')`,
  );
  for (const row of settlements.iterate())
    parked.delete(JSON.parse(row.payload_json).session_id);
  let occupiedCurbs = 0;
  let occupiedTowers = 0;
  for (const session of parked.values()) {
    if (
      session.facility === "Curb" &&
      (version === 2
        ? variablePlotWidths.has(session.location_id)
        : plots.has(session.location_id))
    )
      occupiedCurbs++;
    if (session.facility === "Tower" && towers.has(session.location_id))
      occupiedTowers++;
  }
  return {
    asOf: cursorSecond,
    curbs: {
      occupied: occupiedCurbs,
      capacity: version === 2 ? variableCurbCapacity : plots.size * 2,
      percent:
        occupiedCurbs / (version === 2 ? variableCurbCapacity : plots.size * 2),
    },
    towers: towers.size
      ? {
          occupied: occupiedTowers,
          capacity: towers.size * 32,
          percent: occupiedTowers / (towers.size * 32),
        }
      : null,
  };
}

function timeWeightedOccupancy(db, firstSecond, cursorSecond, version) {
  if (
    cursorSecond === null ||
    cursorSecond <= firstSecond ||
    !hasTable(db, "chain_events") ||
    !hasTable(db, "indexed_blocks")
  )
    return null;

  const plots = new Map();
  const towers = new Map();
  const sessions = new Map();
  const settlements = new Map();
  const rows = db.prepare(
    `SELECT event.event_name, event.payload_json, block.timestamp_ns
     FROM chain_events AS event
     JOIN indexed_blocks AS block ON block.height = event.block_height
     WHERE event.event_name IN
       ('plot_seeded', 'npc_site_seeded', 'parked', 'collected', 'expired', 'ticketed')
     ORDER BY event.block_height, event.log_index, event.data_index`,
  );
  for (const row of rows.iterate()) {
    const payload = JSON.parse(row.payload_json);
    const second = Number(BigInt(row.timestamp_ns) / 1_000_000_000n);
    if (row.event_name === "plot_seeded") {
      if (!plots.has(payload.plot_id)) plots.set(payload.plot_id, second);
    } else if (row.event_name === "npc_site_seeded") {
      if (towerIds.has(payload.site_id) && !towers.has(payload.site_id))
        towers.set(payload.site_id, second);
    } else if (row.event_name === "parked") {
      if (payload.session_id !== undefined)
        sessions.set(String(payload.session_id), {
          ...payload,
          startedAt: second,
        });
    } else if (payload.session_id !== undefined) {
      const id = String(payload.session_id);
      if (!settlements.has(id)) settlements.set(id, second);
    }
  }

  // The fixed launch-city capacity is known only if its complete seed is indexed.
  if (!completeLegacySeed(plots) || towers.size !== towerIds.size) return null;

  const endSecond = cursorSecond;
  const capacitySeconds = (seededAt, slots) =>
    slots * Math.max(0, endSecond - Math.max(firstSecond, seededAt));
  const cutoverSecond = Math.floor(variableCityRelease.cutoverAtMs / 1_000);
  const legacyEnd =
    version === 2 ? Math.min(endSecond, cutoverSecond) : endSecond;
  const legacyCurbCapacitySeconds = [...plots.values()].reduce(
    (total, seededAt) =>
      total + 2 * Math.max(0, legacyEnd - Math.max(firstSecond, seededAt)),
    0,
  );
  const variableCurbCapacitySeconds =
    version === 2
      ? variableCurbCapacity *
        Math.max(0, endSecond - Math.max(firstSecond, cutoverSecond))
      : 0;
  const curbCapacitySeconds =
    legacyCurbCapacitySeconds + variableCurbCapacitySeconds;
  const towerCapacitySeconds = [...towers.values()].reduce(
    (total, seededAt) => total + capacitySeconds(seededAt, 32),
    0,
  );
  let curbOccupiedSeconds = 0;
  let towerOccupiedSeconds = 0;
  for (const [id, session] of sessions) {
    const variableSession =
      version === 2 &&
      session.facility === "Curb" &&
      session.startedAt >= cutoverSecond;
    const seedTime =
      session.facility === "Curb"
        ? variableSession
          ? variablePlotWidths.has(session.location_id)
            ? cutoverSecond
            : undefined
          : plots.get(session.location_id)
        : towers.get(session.location_id);
    if (seedTime === undefined) continue;
    if (
      version === 2 &&
      session.facility === "Curb" &&
      !variableSession &&
      (settlements.get(id) ?? session.expires_at) > cutoverSecond
    )
      return null;
    const occupiedFrom = Math.max(firstSecond, seedTime, session.startedAt);
    const occupiedUntil = Math.min(
      endSecond,
      session.expires_at,
      settlements.get(id) ?? endSecond,
    );
    const seconds = Math.max(0, occupiedUntil - occupiedFrom);
    if (session.facility === "Curb") curbOccupiedSeconds += seconds;
    else if (session.facility === "Tower") towerOccupiedSeconds += seconds;
  }
  const fraction = (occupied, capacity) =>
    capacity > 0 ? occupied / capacity : null;
  return {
    windowStart: firstSecond,
    indexedThroughAt: endSecond,
    curbs: {
      occupiedSlotSeconds: curbOccupiedSeconds,
      availableSlotSeconds: curbCapacitySeconds,
      percent: fraction(curbOccupiedSeconds, curbCapacitySeconds),
    },
    towers: {
      occupiedSlotSeconds: towerOccupiedSeconds,
      availableSlotSeconds: towerCapacitySeconds,
      percent: fraction(towerOccupiedSeconds, towerCapacitySeconds),
    },
    combinedPercent: fraction(
      curbOccupiedSeconds + towerOccupiedSeconds,
      curbCapacitySeconds + towerCapacitySeconds,
    ),
  };
}

export function readBetaMetrics(
  db,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const today = Math.floor(nowSeconds / DAY_SECONDS);
  const firstDay = new Date((today - 6) * DAY_SECONDS * 1_000)
    .toISOString()
    .slice(0, 10);
  const lastDay = new Date(today * DAY_SECONDS * 1_000)
    .toISOString()
    .slice(0, 10);
  const firstSecond = (today - 6) * DAY_SECONDS;
  const lastSecond = (today + 1) * DAY_SECONDS;
  const cursor = hasTable(db, "indexer_state")
    ? db
        .prepare(
          "SELECT contract_id, start_height, last_height, last_timestamp_ns FROM indexer_state WHERE id = 1",
        )
        .get()
    : null;
  const cursorSecond = cursor?.last_timestamp_ns
    ? Number(BigInt(cursor.last_timestamp_ns) / 1_000_000_000n)
    : null;

  const registered = new Map();
  const firstParks = new Map();
  for (const row of eventRows(db, firstDay, lastDay)) {
    const payload = JSON.parse(row.payload_json);
    const second = Number(BigInt(row.timestamp_ns) / 1_000_000_000n);
    if (row.event_name === "player_registered") {
      if (
        typeof payload.account_id === "string" &&
        !registered.has(payload.account_id)
      )
        registered.set(payload.account_id, second);
    } else if (
      row.event_name === "parked" &&
      typeof payload.driver === "string" &&
      !firstParks.has(payload.driver)
    ) {
      firstParks.set(payload.driver, second);
    }
  }
  const firstParkSeconds = [];
  for (const [accountId, registeredAt] of registered) {
    const parkedAt = firstParks.get(accountId);
    if (parkedAt !== undefined && parkedAt >= registeredAt)
      firstParkSeconds.push(parkedAt - registeredAt);
  }

  const economyRows = hasTable(db, "economy_daily_stats")
    ? db
        .prepare(
          "SELECT * FROM economy_daily_stats WHERE day BETWEEN ? AND ? ORDER BY day",
        )
        .all(firstDay, lastDay)
    : [];
  const economyColumns = hasTable(db, "economy_daily_stats")
    ? new Set(
        db
          .prepare("PRAGMA table_info(economy_daily_stats)")
          .all()
          .map((row) => row.name),
      )
    : new Set();
  const hasFullEconomySchema = [
    "starter_grants",
    "unpriced_cost_events",
    "unpriced_grant_events",
  ].every((column) => economyColumns.has(column));
  const economy = economyRows.reduce(
    (total, row) => ({
      curbParks: total.curbParks + row.curb_parks,
      towerParks: total.towerParks + row.tower_parks,
      collections: total.collections + row.collections,
      tickets: total.tickets + row.tickets,
      grossCoinSubunits: total.grossCoinSubunits + BigInt(row.gross),
      knownCostCoinSubunits:
        total.knownCostCoinSubunits + BigInt(row.known_coin_costs),
      unpricedCostEvents:
        total.unpricedCostEvents + (row.unpriced_cost_events ?? 0),
      unpricedGrantEvents:
        total.unpricedGrantEvents + (row.unpriced_grant_events ?? 0),
    }),
    {
      curbParks: 0,
      towerParks: 0,
      collections: 0,
      tickets: 0,
      grossCoinSubunits: 0n,
      knownCostCoinSubunits: 0n,
      unpricedCostEvents: 0,
      unpricedGrantEvents: 0,
    },
  );
  const totalParks = economy.curbParks + economy.towerParks;
  const missingAmounts = unpricedEvents(db, firstDay, lastDay);
  const unpricedCostEvents = Math.max(
    economy.unpricedCostEvents,
    missingAmounts.costs,
  );
  const unpricedGrantEvents = Math.max(
    economy.unpricedGrantEvents,
    missingAmounts.grants,
  );

  const paidReviews = hasTable(db, "paid_generation_candidates")
    ? db
        .prepare(
          `SELECT review_status FROM paid_generation_candidates
           WHERE reviewed_at >= ? AND reviewed_at < ?
             AND review_status IN ('approved', 'rejected')`,
        )
        .all(firstSecond, lastSecond)
    : [];
  const approvedCandidates = paidReviews.filter(
    (row) => row.review_status === "approved",
  ).length;
  const attemptColumns = hasTable(db, "paid_generation_attempts")
    ? new Set(
        db
          .prepare("PRAGMA table_info(paid_generation_attempts)")
          .all()
          .map((row) => row.name),
      )
    : new Set();
  const attempts = attemptColumns.size
    ? db
        .prepare(
          `SELECT started_at, finished_at, ${attemptColumns.has("usage_json") ? "usage_json" : "NULL AS usage_json"}
           FROM paid_generation_attempts
           WHERE finished_at >= ? AND finished_at < ? AND finished_at >= started_at`,
        )
        .all(firstSecond, lastSecond)
    : [];
  const chargedRows = hasTable(db, "paid_generation_days")
    ? db
        .prepare(
          "SELECT charged_usd_micros FROM paid_generation_days WHERE utc_day BETWEEN ? AND ?",
        )
        .all(today - 6, today)
    : [];

  const version = capacityVersion(cursor, cursorSecond);
  const occupancy = timeWeightedOccupancy(
    db,
    firstSecond,
    cursorSecond,
    version,
  );
  return {
    windowUtc: { firstDay, lastDay },
    source: {
      contractId: cursor?.contract_id ?? null,
      startHeight: cursor?.start_height ?? null,
      indexedThroughHeight: cursor?.last_height ?? null,
      indexedThroughAt: cursorSecond,
      completeThroughNow:
        cursorSecond !== null &&
        nowSeconds >= cursorSecond &&
        nowSeconds - cursorSecond <= 600,
    },
    onboarding: {
      registrations: registered.size,
      firstParks: firstParkSeconds.length,
      medianSecondsToFirstPark: median(firstParkSeconds),
      note: "First parking after a registration indexed in this seven-day window; wallet sign-in time is not recorded.",
    },
    parking: {
      curbParks: economy.curbParks,
      towerParks: economy.towerParks,
      towerShareOfParks: totalParks ? economy.towerParks / totalParks : null,
      indexedOccupancy: indexedOccupancy(db, cursorSecond, version),
      timeWeightedOccupancy: occupancy,
      timeWeightedOccupancyPercent: occupancy?.combinedPercent ?? null,
      capacityVersion: version,
      note: "Current and time-weighted occupancy use indexed park, settlement and expiry times. The version-2 capacity switch uses the operator release cutover time because migration emitted no plot-seed events. Time-weighted figures require every launch-city seed event and end at the last indexed block; stale or incomplete indexing limits the measurement.",
    },
    coinPacing: {
      grossEarnedSubunits: economy.grossCoinSubunits.toString(),
      knownSpentSubunits: economy.knownCostCoinSubunits.toString(),
      amountCoverageComplete:
        cursorSecond !== null &&
        hasFullEconomySchema &&
        unpricedCostEvents === 0 &&
        unpricedGrantEvents === 0,
      unpricedCostEvents,
      unpricedGrantEvents,
      note: hasFullEconomySchema
        ? "Coin totals cover indexed events only; unpriced historical purchases and starter grants are excluded from their respective totals."
        : "This database has an older economy aggregate schema. Rebuild aggregates with the current worker before using coin amounts for beta decisions.",
    },
    generation: {
      reviewedPaidCandidates: paidReviews.length,
      approvedPaidCandidates: approvedCandidates,
      paidCandidateApprovalRate: paidReviews.length
        ? approvedCandidates / paidReviews.length
        : null,
      note: "A paid candidate review rate requires real provider jobs and human review.",
    },
    provider: {
      completedAttempts: attempts.length,
      tokenUsage: providerTokenUsage(attempts),
      medianAttemptSeconds: median(
        attempts.map((row) => row.finished_at - row.started_at),
      ),
      conservativeBudgetDebitUsdMicros: chargedRows
        .reduce((total, row) => total + BigInt(row.charged_usd_micros), 0n)
        .toString(),
      actualProviderCostUsdMicros: null,
      actualInvoicedCostUsdMicros: null,
      costSource: null,
      note: "The ledger records a conservative budget debit. Attach a complete Costs API export from a dedicated provider project for actual reported cost; invoice cost requires separate reconciliation.",
    },
  };
}

export function attachProviderCostReport(report, page, projectId) {
  if (
    typeof projectId !== "string" ||
    !/^[A-Za-z0-9_-]{5,128}$/.test(projectId)
  )
    throw new Error("Provide the dedicated provider project ID");
  if (
    !page ||
    page.object !== "page" ||
    page.has_more !== false ||
    page.next_page !== null ||
    !Array.isArray(page.data)
  )
    throw new Error("Costs export must be one complete page");

  const firstSecond =
    Date.parse(`${report.windowUtc.firstDay}T00:00:00Z`) / 1_000;
  const lastSecond =
    Date.parse(`${report.windowUtc.lastDay}T00:00:00Z`) / 1_000;
  const days = new Map();
  for (const bucket of page.data) {
    if (
      bucket?.object !== "bucket" ||
      !Number.isSafeInteger(bucket.start_time) ||
      bucket.end_time !== bucket.start_time + DAY_SECONDS ||
      bucket.start_time % DAY_SECONDS !== 0 ||
      bucket.start_time < firstSecond ||
      bucket.start_time > lastSecond ||
      !Array.isArray(bucket.results) ||
      days.has(bucket.start_time)
    )
      throw new Error("Costs export has an invalid or duplicate day bucket");
    let micros = 0n;
    for (const result of bucket.results) {
      const value = result?.amount?.value;
      if (
        result?.object !== "organization.costs.result" ||
        result.project_id !== projectId ||
        result.amount?.currency !== "usd" ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        !Number.isSafeInteger(Math.round(value * 1_000_000))
      )
        throw new Error("Costs export has an unscoped or invalid amount");
      micros += BigInt(Math.round(value * 1_000_000));
    }
    days.set(bucket.start_time, micros);
  }
  let total = 0n;
  for (let day = firstSecond; day <= lastSecond; day += DAY_SECONDS) {
    if (!days.has(day))
      throw new Error("Costs export is missing a day in the report window");
    total += days.get(day);
  }
  return {
    ...report,
    provider: {
      ...report.provider,
      actualProviderCostUsdMicros: total.toString(),
      costSource: {
        kind: "openai_organization_costs",
        projectId,
        firstDay: report.windowUtc.firstDay,
        lastDay: report.windowUtc.lastDay,
        scope: "all charges in the dedicated project",
      },
    },
  };
}
