import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  InspectorStatus,
  type InspectorStatus as PatrolStatus,
} from "@estate/shared";

export type MonitorConfig = {
  contractId: string;
  dbPath: string;
  maxIndexerAgeSeconds: number;
  inspectorStatusPath: string | null;
  maxInspectorAgeSeconds: number;
  dailyBudgetUsdMicros: number;
  budgetWarnPercent: number;
  reminderSeconds: number;
  intervalSeconds: number;
  webhookUrl: string | null;
  webhookToken: string | null;
};

export type MonitorSnapshot = {
  cursor: {
    contractId: string;
    height: number;
    timestampNs: string | null;
  } | null;
  budget: {
    reservedUsdMicros: number;
    chargedUsdMicros: number;
  } | null;
  inspector?:
    | { state: "ok"; status: PatrolStatus }
    | { state: "missing" }
    | { state: "invalid" }
    | null;
};

export type MonitorIssue = {
  category: "indexer" | "budget" | "inspector" | "storage";
  code: string;
  severity: "warning" | "critical";
  detail: Record<string, string | number | null>;
};

export type MonitorEvent = MonitorIssue & {
  state: "firing" | "resolved";
  observedAt: string;
  contractId: string;
};

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const raw = env[name] ?? String(defaultValue);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be positive`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is too large`);
  return value;
}

export function readMonitorConfig(env: NodeJS.ProcessEnv): MonitorConfig {
  const contractId = env.ESTATE_CONTRACT_ID?.trim();
  if (!contractId || !contractId.endsWith(".testnet"))
    throw new Error("Set a testnet ESTATE_CONTRACT_ID");
  const budgetRaw = env.ESTATE_MONITOR_DAILY_BUDGET_USD_MICROS ?? "0";
  if (!/^(0|[1-9][0-9]*)$/.test(budgetRaw))
    throw new Error("Invalid ESTATE_MONITOR_DAILY_BUDGET_USD_MICROS");
  const dailyBudgetUsdMicros = Number(budgetRaw);
  if (!Number.isSafeInteger(dailyBudgetUsdMicros))
    throw new Error("Monitor budget is too large");
  const budgetWarnPercent = positiveInteger(
    env,
    "ESTATE_MONITOR_BUDGET_WARN_PERCENT",
    80,
  );
  if (budgetWarnPercent > 100)
    throw new Error("Budget warning percentage exceeds 100");
  const webhookUrl = env.ESTATE_MONITOR_WEBHOOK_URL?.trim() || null;
  const inspectorStatusPath =
    env.ESTATE_MONITOR_INSPECTOR_STATUS_FILE?.trim() || null;
  if (inspectorStatusPath && !isAbsolute(inspectorStatusPath))
    throw new Error("Inspector status path must be absolute");
  if (webhookUrl) {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error(
        "Monitor webhook must be an HTTPS URL without credentials",
      );
  }
  const tokenFile = env.ESTATE_MONITOR_WEBHOOK_TOKEN_FILE?.trim();
  const webhookToken = tokenFile
    ? readFileSync(tokenFile, "utf8").trim()
    : null;
  if (webhookUrl && (!webhookToken || webhookToken.length < 16))
    throw new Error("Monitor webhook needs a protected bearer-token file");
  return {
    contractId,
    dbPath: join(
      env.API_DATA_DIR ?? join(process.cwd(), "data"),
      "estate.sqlite",
    ),
    maxIndexerAgeSeconds: positiveInteger(
      env,
      "ESTATE_MONITOR_INDEXER_MAX_AGE_SECONDS",
      900,
    ),
    inspectorStatusPath,
    maxInspectorAgeSeconds: positiveInteger(
      env,
      "ESTATE_MONITOR_INSPECTOR_MAX_AGE_SECONDS",
      900,
    ),
    dailyBudgetUsdMicros,
    budgetWarnPercent,
    reminderSeconds: positiveInteger(
      env,
      "ESTATE_MONITOR_REMINDER_SECONDS",
      1800,
    ),
    intervalSeconds: positiveInteger(
      env,
      "ESTATE_MONITOR_INTERVAL_SECONDS",
      60,
    ),
    webhookUrl,
    webhookToken,
  };
}

export function readMonitorSnapshot(
  dbPath: string,
  nowSeconds: number,
  inspectorStatusPath: string | null = null,
): MonitorSnapshot {
  const file = statSync(dbPath);
  if (!file.isFile()) throw new Error("Monitor database is not a file");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const hasTable = (name: string) =>
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(name),
      );
    const cursor = hasTable("indexer_state")
      ? (db
          .prepare(
            "SELECT contract_id, last_height, last_timestamp_ns FROM indexer_state WHERE id = 1",
          )
          .get() as
          | {
              contract_id: string;
              last_height: number;
              last_timestamp_ns: string | null;
            }
          | undefined)
      : undefined;
    const day = Math.floor(nowSeconds / 86_400);
    const budget = hasTable("paid_generation_days")
      ? (db
          .prepare(
            "SELECT reserved_usd_micros, charged_usd_micros FROM paid_generation_days WHERE utc_day = ?",
          )
          .get(day) as
          | { reserved_usd_micros: number; charged_usd_micros: number }
          | undefined)
      : null;
    return {
      cursor: cursor
        ? {
            contractId: cursor.contract_id,
            height: cursor.last_height,
            timestampNs: cursor.last_timestamp_ns,
          }
        : null,
      budget:
        budget === null
          ? null
          : {
              reservedUsdMicros: budget?.reserved_usd_micros ?? 0,
              chargedUsdMicros: budget?.charged_usd_micros ?? 0,
            },
      inspector: readInspectorStatus(inspectorStatusPath),
    };
  } finally {
    db.close();
  }
}

function readInspectorStatus(
  path: string | null,
): MonitorSnapshot["inspector"] {
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "invalid" };
  }
  try {
    const parsed = InspectorStatus.safeParse(JSON.parse(raw));
    return parsed.success
      ? { state: "ok", status: parsed.data }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

export function evaluateMonitor(
  snapshot: MonitorSnapshot,
  config: MonitorConfig,
  nowSeconds: number,
): MonitorIssue[] {
  const issues: MonitorIssue[] = [];
  const cursor = snapshot.cursor;
  if (!cursor) {
    issues.push({
      category: "indexer",
      code: "INDEXER_MISSING",
      severity: "critical",
      detail: { height: null },
    });
  } else if (cursor.contractId !== config.contractId) {
    issues.push({
      category: "indexer",
      code: "INDEXER_WRONG_CONTRACT",
      severity: "critical",
      detail: { height: cursor.height, contractId: cursor.contractId },
    });
  } else if (!cursor.timestampNs || !/^[0-9]+$/.test(cursor.timestampNs)) {
    issues.push({
      category: "indexer",
      code: "INDEXER_NOT_STARTED",
      severity: "critical",
      detail: { height: cursor.height },
    });
  } else {
    const timestampSeconds = BigInt(cursor.timestampNs) / 1_000_000_000n;
    const age = BigInt(nowSeconds) - timestampSeconds;
    if (age > BigInt(config.maxIndexerAgeSeconds) || age < -60n)
      issues.push({
        category: "indexer",
        code: age < 0n ? "INDEXER_CLOCK_SKEW" : "INDEXER_STALE",
        severity: "critical",
        detail: {
          height: cursor.height,
          ageSeconds:
            age > BigInt(Number.MAX_SAFE_INTEGER) ||
            age < BigInt(Number.MIN_SAFE_INTEGER)
              ? null
              : Number(age),
        },
      });
  }
  if (config.dailyBudgetUsdMicros > 0) {
    if (!snapshot.budget) {
      issues.push({
        category: "budget",
        code: "BUDGET_TABLE_MISSING",
        severity: "critical",
        detail: { day: Math.floor(nowSeconds / 86_400) },
      });
    } else {
      const { reservedUsdMicros, chargedUsdMicros } = snapshot.budget;
      if (
        !Number.isSafeInteger(reservedUsdMicros) ||
        !Number.isSafeInteger(chargedUsdMicros) ||
        reservedUsdMicros < 0 ||
        chargedUsdMicros < 0
      )
        throw new Error("Invalid paid-generation budget counters");
      const committed = BigInt(reservedUsdMicros) + BigInt(chargedUsdMicros);
      const limit = BigInt(config.dailyBudgetUsdMicros);
      if (committed * 100n >= limit * BigInt(config.budgetWarnPercent))
        issues.push({
          category: "budget",
          code: committed >= limit ? "BUDGET_FULL" : "BUDGET_HIGH",
          severity: committed >= limit ? "critical" : "warning",
          detail: {
            day: Math.floor(nowSeconds / 86_400),
            reservedUsdMicros,
            chargedUsdMicros,
            limitUsdMicros: config.dailyBudgetUsdMicros,
          },
        });
    }
  }
  if (config.inspectorStatusPath) {
    const inspector = snapshot.inspector;
    if (!inspector || inspector.state === "missing")
      issues.push({
        category: "inspector",
        code: "INSPECTOR_MISSING",
        severity: "critical",
        detail: {},
      });
    else if (inspector.state === "invalid")
      issues.push({
        category: "inspector",
        code: "INSPECTOR_STATUS_INVALID",
        severity: "critical",
        detail: {},
      });
    else if (inspector.status.contractId !== config.contractId)
      issues.push({
        category: "inspector",
        code: "INSPECTOR_WRONG_CONTRACT",
        severity: "critical",
        detail: { contractId: inspector.status.contractId },
      });
    else {
      const age = nowSeconds - inspector.status.completedAt;
      if (age > config.maxInspectorAgeSeconds || age < -60)
        issues.push({
          category: "inspector",
          code: age < 0 ? "INSPECTOR_CLOCK_SKEW" : "INSPECTOR_STALE",
          severity: "critical",
          detail: { ageSeconds: age },
        });
      else if (inspector.status.consecutiveFailures >= 3)
        issues.push({
          category: "inspector",
          code: "INSPECTOR_FAILING",
          severity: "critical",
          detail: {
            consecutiveFailures: inspector.status.consecutiveFailures,
            attempted: inspector.status.attempted,
            failed: inspector.status.failed,
          },
        });
    }
  }
  return issues;
}

export class AlertMonitor {
  private readonly last = new Map<
    MonitorIssue["category"],
    { issue: MonitorIssue; sentAt: number }
  >();

  constructor(
    private readonly config: MonitorConfig,
    private readonly send: (event: MonitorEvent) => Promise<void>,
    private readonly snapshot: (
      path: string,
      nowSeconds: number,
      inspectorStatusPath?: string | null,
    ) => MonitorSnapshot = readMonitorSnapshot,
  ) {}

  async tick(
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<MonitorIssue[]> {
    let issues: MonitorIssue[];
    try {
      issues = evaluateMonitor(
        this.snapshot(
          this.config.dbPath,
          nowSeconds,
          this.config.inspectorStatusPath,
        ),
        this.config,
        nowSeconds,
      );
    } catch {
      issues = [
        {
          category: "storage",
          code: "MONITOR_DATABASE_UNAVAILABLE",
          severity: "critical",
          detail: {},
        },
      ];
    }
    const observedAt = new Date(nowSeconds * 1_000).toISOString();
    for (const issue of issues) {
      const prior = this.last.get(issue.category);
      if (
        prior?.issue.code === issue.code &&
        nowSeconds - prior.sentAt < this.config.reminderSeconds
      )
        continue;
      await this.send({
        ...issue,
        state: "firing",
        observedAt,
        contractId: this.config.contractId,
      });
      this.last.set(issue.category, { issue, sentAt: nowSeconds });
    }
    for (const [category, prior] of this.last) {
      if (issues.some((issue) => issue.category === category)) continue;
      if (issues.some((issue) => issue.category === "storage")) continue;
      await this.send({
        ...prior.issue,
        state: "resolved",
        observedAt,
        contractId: this.config.contractId,
      });
      this.last.delete(category);
    }
    return issues;
  }
}

export async function sendMonitorWebhook(
  config: MonitorConfig,
  event: MonitorEvent,
): Promise<void> {
  if (!config.webhookUrl || !config.webhookToken)
    throw new Error("Monitor webhook is not configured");
  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.webhookToken}`,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`Monitor webhook returned HTTP ${response.status}`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "--once";
  if (mode !== "--once" && mode !== "--run")
    throw new Error("Use --once or --run");
  const config = readMonitorConfig(process.env);
  if (mode === "--run" && (!config.webhookUrl || !config.webhookToken))
    throw new Error("Running monitor requires an authenticated HTTPS webhook");
  const monitor = new AlertMonitor(config, async (event) => {
    if (config.webhookUrl) await sendMonitorWebhook(config, event);
    console.log(JSON.stringify(event));
  });
  if (mode === "--once") {
    const issues = await monitor.tick();
    console.log(JSON.stringify({ issueCount: issues.length }));
    return;
  }
  let stopped = false;
  let wake: (() => void) | null = null;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  while (!stopped) {
    try {
      await monitor.tick();
    } catch (error) {
      console.error("Monitor delivery failed:", error);
    }
    if (!stopped)
      await new Promise<void>((done) => {
        const timer = setTimeout(done, config.intervalSeconds * 1_000);
        wake = () => {
          clearTimeout(timer);
          done();
        };
      });
    wake = null;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
