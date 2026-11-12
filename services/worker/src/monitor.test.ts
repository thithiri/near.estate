import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventStore } from "./event-store.js";
import {
  AlertMonitor,
  evaluateMonitor,
  probeApiHealth,
  readMonitorConfig,
  readMonitorSnapshot,
  sendMonitorWebhook,
  type MonitorConfig,
  type MonitorEvent,
  type MonitorHeartbeat,
  type MonitorSnapshot,
} from "./monitor.js";

const contractId = "city.testnet";
const now = 1_800_000_000;

function config(): MonitorConfig {
  return {
    contractId,
    dbPath: "/unused/estate.sqlite",
    maxIndexerAgeSeconds: 900,
    inspectorStatusPath: null,
    maxInspectorAgeSeconds: 900,
    expiryStatusPath: null,
    maxExpiryAgeSeconds: 900,
    dailyBudgetUsdMicros: 4_000_000,
    budgetWarnPercent: 80,
    reminderSeconds: 1800,
    intervalSeconds: 60,
    heartbeatSeconds: 300,
    apiHealthUrl: null,
    webhookUrl: null,
    webhookToken: null,
  };
}

function snapshot(
  ageSeconds: number,
  reservedUsdMicros: number,
  chargedUsdMicros: number,
): MonitorSnapshot {
  return {
    cursor: {
      contractId,
      height: 15,
      timestampNs: String(BigInt(now - ageSeconds) * 1_000_000_000n),
    },
    budget: { reservedUsdMicros, chargedUsdMicros },
  };
}

test("monitor reads the shared WAL cursor and paid budget without opening a writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-monitor-"));
  const dbPath = join(dir, "estate.sqlite");
  const writer = new EventStore(dbPath, contractId, 10);
  try {
    writer.applyHeight(10, {
      height: 10,
      hash: "block-10",
      prevHash: "block-9",
      timestampNs: String(BigInt(now - 120) * 1_000_000_000n),
      source: "neardata",
      events: [],
    });
    writer.db.exec(`
      CREATE TABLE paid_generation_days (
        utc_day INTEGER PRIMARY KEY,
        reserved_usd_micros INTEGER NOT NULL,
        charged_usd_micros INTEGER NOT NULL
      ) STRICT;
    `);
    writer.db
      .prepare("INSERT INTO paid_generation_days VALUES (?, ?, ?)")
      .run(Math.floor(now / 86_400), 2_000_000, 1_250_000);
    const actual = readMonitorSnapshot(dbPath, now);
    assert.equal(actual.cursor?.height, 10);
    assert.equal(actual.cursor?.contractId, contractId);
    assert.deepEqual(actual.budget, {
      reservedUsdMicros: 2_000_000,
      chargedUsdMicros: 1_250_000,
    });
    assert.deepEqual(
      evaluateMonitor(actual, config(), now).map((issue) => issue.code),
      ["BUDGET_HIGH"],
    );
  } finally {
    writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("indexer and budget alerts cover stale, wrong contract, missing data and full commitment", () => {
  assert.deepEqual(
    evaluateMonitor(snapshot(901, 0, 0), config(), now).map(
      (issue) => issue.code,
    ),
    ["INDEXER_STALE"],
  );
  assert.deepEqual(
    evaluateMonitor(snapshot(0, 2_000_000, 2_000_000), config(), now).map(
      (issue) => issue.code,
    ),
    ["BUDGET_FULL"],
  );
  assert.deepEqual(
    evaluateMonitor({ cursor: null, budget: null }, config(), now).map(
      (issue) => issue.code,
    ),
    ["INDEXER_MISSING", "BUDGET_TABLE_MISSING"],
  );
  const wrong = snapshot(0, 0, 0);
  wrong.cursor!.contractId = "other.testnet";
  assert.equal(
    evaluateMonitor(wrong, config(), now)[0]?.code,
    "INDEXER_WRONG_CONTRACT",
  );
});

test("inspector alerts cover missing, invalid, stale and repeated failed patrols", async () => {
  const directory = await mkdtemp(join(tmpdir(), "estate-inspector-monitor-"));
  const dbPath = join(directory, "estate.sqlite");
  const statusPath = join(directory, "patrol.json");
  const writer = new EventStore(dbPath, contractId, 10);
  const options = {
    ...config(),
    dailyBudgetUsdMicros: 0,
    inspectorStatusPath: statusPath,
  };
  try {
    writer.applyHeight(10, {
      height: 10,
      hash: "block-10",
      prevHash: "block-9",
      timestampNs: String(BigInt(now) * 1_000_000_000n),
      source: "neardata",
      events: [],
    });
    const codes = () =>
      evaluateMonitor(
        readMonitorSnapshot(dbPath, now, statusPath),
        options,
        now,
      ).map((issue) => issue.code);
    assert.deepEqual(codes(), ["INSPECTOR_MISSING"]);
    await writeFile(statusPath, "bad JSON");
    assert.deepEqual(codes(), ["INSPECTOR_STATUS_INVALID"]);
    const status = {
      contractId,
      completedAt: now - 901,
      outcome: "ok",
      consecutiveFailures: 0,
      eligible: 0,
      attempted: 0,
      failed: 0,
    };
    await writeFile(statusPath, JSON.stringify(status));
    assert.deepEqual(codes(), ["INSPECTOR_STALE"]);
    status.completedAt = now;
    status.contractId = "other.testnet";
    await writeFile(statusPath, JSON.stringify(status));
    assert.deepEqual(codes(), ["INSPECTOR_WRONG_CONTRACT"]);
    status.contractId = contractId;
    status.outcome = "error";
    status.consecutiveFailures = 3;
    status.attempted = 2;
    status.failed = 2;
    await writeFile(statusPath, JSON.stringify(status));
    assert.deepEqual(codes(), ["INSPECTOR_FAILING"]);
    status.outcome = "ok";
    status.consecutiveFailures = 0;
    status.attempted = 0;
    status.failed = 0;
    await writeFile(statusPath, JSON.stringify(status));
    assert.deepEqual(codes(), []);
  } finally {
    writer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("expiry alerts cover stopped, malformed, stale and repeatedly failing sweeps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "estate-expiry-monitor-"));
  const dbPath = join(directory, "estate.sqlite");
  const statusPath = join(directory, "sweep.json");
  const writer = new EventStore(dbPath, contractId, 10);
  const options = {
    ...config(),
    dailyBudgetUsdMicros: 0,
    expiryStatusPath: statusPath,
  };
  try {
    writer.applyHeight(10, {
      height: 10,
      hash: "block-10",
      prevHash: "block-9",
      timestampNs: String(BigInt(now) * 1_000_000_000n),
      source: "neardata",
      events: [],
    });
    const codes = () =>
      evaluateMonitor(
        readMonitorSnapshot(dbPath, now, null, statusPath),
        options,
        now,
      ).map((issue) => issue.code);
    assert.deepEqual(codes(), ["EXPIRY_MISSING"]);
    await writeFile(statusPath, "bad JSON");
    assert.deepEqual(codes(), ["EXPIRY_STATUS_INVALID"]);
    const status = {
      contractId,
      completedAt: now - 901,
      outcome: "ok",
      consecutiveFailures: 0,
      eligible: 0,
      attempted: 0,
      settled: 0,
      raced: 0,
      failed: 0,
    };
    await writeFile(statusPath, JSON.stringify(status));
    assert.deepEqual(codes(), ["EXPIRY_STALE"]);
    status.completedAt = now;
    status.contractId = "other.testnet";
    await writeFile(statusPath, JSON.stringify(status));
    assert.deepEqual(codes(), ["EXPIRY_WRONG_CONTRACT"]);
    status.contractId = contractId;
    status.outcome = "error";
    status.consecutiveFailures = 3;
    status.eligible = 2;
    status.attempted = 2;
    status.failed = 2;
    await writeFile(statusPath, JSON.stringify(status));
    assert.deepEqual(codes(), ["EXPIRY_FAILING"]);
    status.outcome = "ok";
    status.consecutiveFailures = 0;
    status.failed = 0;
    await writeFile(statusPath, JSON.stringify(status));
    assert.deepEqual(codes(), []);
  } finally {
    writer.close();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(
    readMonitorConfig({
      ESTATE_CONTRACT_ID: contractId,
      ESTATE_MONITOR_EXPIRY_STATUS_FILE: "/expiry-status/sweep.json",
    }).expiryStatusPath,
    "/expiry-status/sweep.json",
  );
  assert.throws(
    () =>
      readMonitorConfig({
        ESTATE_CONTRACT_ID: contractId,
        ESTATE_MONITOR_EXPIRY_STATUS_FILE: "relative/sweep.json",
      }),
    /Expiry status path must be absolute/,
  );
});

test("alerts repeat after the reminder interval and send a resolution after recovery", async () => {
  const sent: MonitorEvent[] = [];
  let current = snapshot(1_000, 3_200_000, 0);
  const monitor = new AlertMonitor(
    config(),
    async (event) => {
      sent.push(event);
    },
    () => current,
  );
  assert.equal((await monitor.tick(now)).length, 2);
  assert.deepEqual(
    sent.map((event) => `${event.state}:${event.code}`),
    ["firing:INDEXER_STALE", "firing:BUDGET_HIGH"],
  );
  await monitor.tick(now + 60);
  assert.equal(sent.length, 2);
  await monitor.tick(now + 1800);
  assert.equal(sent.length, 4);
  current = snapshot(-1801, 0, 0);
  await monitor.tick(now + 1801);
  assert.deepEqual(
    sent.slice(-2).map((event) => `${event.state}:${event.code}`),
    ["resolved:INDEXER_STALE", "resolved:BUDGET_HIGH"],
  );
});

test("failed alert delivery remains pending for the next tick", async () => {
  let calls = 0;
  const monitor = new AlertMonitor(
    config(),
    async () => {
      calls++;
      if (calls === 1) throw new Error("delivery failed");
    },
    () => snapshot(1_000, 0, 0),
  );
  await assert.rejects(monitor.tick(now), /delivery failed/);
  await monitor.tick(now + 60);
  assert.equal(calls, 2);
});

test("heartbeat repeats on cadence and retries a failed delivery", async () => {
  const heartbeats: MonitorHeartbeat[] = [];
  let rejectNext = true;
  const monitor = new AlertMonitor(
    { ...config(), dailyBudgetUsdMicros: 0 },
    async () => {},
    () => snapshot(0, 0, 0),
    async () => true,
    async (event) => {
      if (rejectNext) {
        rejectNext = false;
        throw new Error("receiver unavailable");
      }
      heartbeats.push(event);
    },
  );
  await assert.rejects(monitor.tick(now), /receiver unavailable/);
  await monitor.tick(now + 60);
  await monitor.tick(now + 299);
  await monitor.tick(now + 360);
  assert.deepEqual(heartbeats, [
    {
      kind: "heartbeat",
      contractId,
      observedAt: new Date((now + 60) * 1_000).toISOString(),
      expectedIntervalSeconds: 300,
    },
    {
      kind: "heartbeat",
      contractId,
      observedAt: new Date((now + 360) * 1_000).toISOString(),
      expectedIntervalSeconds: 300,
    },
  ]);
  assert.equal(
    readMonitorConfig({ ESTATE_CONTRACT_ID: contractId }).heartbeatSeconds,
    300,
  );
  assert.throws(
    () =>
      readMonitorConfig({
        ESTATE_CONTRACT_ID: contractId,
        ESTATE_MONITOR_HEARTBEAT_SECONDS: "0",
      }),
    /must be positive/,
  );
  assert.throws(
    () =>
      readMonitorConfig({
        ESTATE_CONTRACT_ID: contractId,
        ESTATE_MONITOR_HEARTBEAT_SECONDS: "30",
      }),
    /at least one polling interval/,
  );
});

test("API health probe accepts only the expected service response", async () => {
  const url = "http://api:3000/health";
  const healthy = new Response(
    JSON.stringify({ status: "ok", service: "api", schemaVersion: 1 }),
  );
  assert.equal(
    await probeApiHealth(url, async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return healthy;
    }),
    true,
  );
  assert.equal(
    await probeApiHealth(
      url,
      async () =>
        new Response(JSON.stringify({ status: "ok", service: "web" })),
    ),
    false,
  );
  assert.equal(
    await probeApiHealth(url, async () => new Response(null, { status: 503 })),
    false,
  );
  assert.equal(
    await probeApiHealth(url, async () => {
      throw new Error("connection refused");
    }),
    false,
  );
  const environment = {
    ESTATE_CONTRACT_ID: contractId,
    ESTATE_MONITOR_API_HEALTH_URL: url,
  };
  assert.equal(readMonitorConfig(environment).apiHealthUrl, url);
  assert.throws(
    () =>
      readMonitorConfig({
        ...environment,
        ESTATE_MONITOR_API_HEALTH_URL: "file:///tmp/secret",
      }),
    /health URL/,
  );
});

test("API outage alerts and recovery stay independent of database access", async () => {
  const sent: MonitorEvent[] = [];
  let apiHealthy = false;
  let databaseHealthy = true;
  const monitor = new AlertMonitor(
    {
      ...config(),
      apiHealthUrl: "http://api:3000/health",
      dailyBudgetUsdMicros: 0,
    },
    async (event) => {
      sent.push(event);
    },
    () => {
      if (!databaseHealthy) throw new Error("database unavailable");
      return snapshot(0, 0, 0);
    },
    async () => apiHealthy,
  );
  assert.deepEqual(
    (await monitor.tick(now)).map((issue) => issue.code),
    ["API_UNAVAILABLE"],
  );
  apiHealthy = true;
  databaseHealthy = false;
  assert.deepEqual(
    (await monitor.tick(now + 60)).map((issue) => issue.code),
    ["MONITOR_DATABASE_UNAVAILABLE"],
  );
  databaseHealthy = true;
  assert.deepEqual(await monitor.tick(now + 120), []);
  assert.deepEqual(
    sent.map((event) => `${event.state}:${event.code}`),
    [
      "firing:API_UNAVAILABLE",
      "firing:MONITOR_DATABASE_UNAVAILABLE",
      "resolved:API_UNAVAILABLE",
      "resolved:MONITOR_DATABASE_UNAVAILABLE",
    ],
  );
});

test("webhook sends authenticated JSON and treats a rejected response as failure", async () => {
  const originalFetch = globalThis.fetch;
  const calls: {
    url: string;
    authorization: string;
    redirect: string | undefined;
    body: unknown;
  }[] = [];
  let responseStatus = 204;
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      authorization: String(new Headers(init?.headers).get("authorization")),
      redirect: init?.redirect,
      body: JSON.parse(String(init?.body)),
    });
    return new Response(null, { status: responseStatus });
  }) as typeof fetch;
  try {
    const event: MonitorEvent = {
      category: "indexer",
      code: "INDEXER_STALE",
      severity: "critical",
      detail: { height: 10, ageSeconds: 901 },
      state: "firing",
      observedAt: "2027-01-15T08:00:00.000Z",
      contractId,
    };
    const options = {
      ...config(),
      webhookUrl: "https://alerts.example.com/estate",
      webhookToken: "test-token-at-least-sixteen-bytes",
    };
    await sendMonitorWebhook(options, event);
    assert.deepEqual(calls[0], {
      url: options.webhookUrl,
      authorization: `Bearer ${options.webhookToken}`,
      redirect: "error",
      body: event,
    });
    const heartbeat: MonitorHeartbeat = {
      kind: "heartbeat",
      contractId,
      observedAt: event.observedAt,
      expectedIntervalSeconds: 300,
    };
    await sendMonitorWebhook(options, heartbeat);
    assert.deepEqual(calls[1]?.body, heartbeat);
    responseStatus = 503;
    await assert.rejects(sendMonitorWebhook(options, event), /HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("monitor loads only a private absolute webhook token file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "estate-monitor-token-"));
  const tokenPath = join(directory, "token");
  const environment = {
    ESTATE_CONTRACT_ID: contractId,
    ESTATE_MONITOR_WEBHOOK_URL: "https://alerts.example.com/estate",
    ESTATE_MONITOR_WEBHOOK_TOKEN_FILE: tokenPath,
  };
  try {
    await writeFile(tokenPath, "test-token-at-least-sixteen-bytes\n", {
      mode: 0o600,
    });
    assert.equal(
      readMonitorConfig(environment).webhookToken,
      "test-token-at-least-sixteen-bytes",
    );
    assert.throws(
      () =>
        readMonitorConfig({
          ...environment,
          ESTATE_MONITOR_WEBHOOK_TOKEN_FILE: "relative/token",
        }),
      /path must be absolute/,
    );
    await chmod(tokenPath, 0o644);
    assert.throws(() => readMonitorConfig(environment), /file must be private/);
    assert.throws(
      () =>
        readMonitorConfig({
          ...environment,
          ESTATE_MONITOR_WEBHOOK_TOKEN_FILE: directory,
        }),
      /file must be private/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
