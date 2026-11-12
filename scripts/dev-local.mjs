import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (mode !== "--guest" && mode !== "--city")
  throw new Error("Use --guest or --city");

function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535)
    throw new Error(`${name} must be a TCP port from 1 to 65535`);
  return value;
}

const webPort = port("WEB_PORT", 5173);
const apiPort = port("API_PORT", 3000);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [];
let unavailableApi = null;
let stopping = false;
let exitCode = 0;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  unavailableApi?.close();
  for (const child of children) {
    if (!child.pid) continue;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

function activeCityRelease(contractId) {
  const matches = readdirSync(resolve(root, "deployments"))
    .filter((name) => /^variable-city-release-[a-f0-9]+\.json$/.test(name))
    .map((name) =>
      JSON.parse(readFileSync(resolve(root, "deployments", name), "utf8")),
    )
    .filter(
      (record) =>
        record.contractId === contractId && record.status === "active",
    );
  if (matches.length > 1)
    throw new Error("Multiple active release records match this contract");
  return matches[0] ?? null;
}

function start(name, args, env) {
  const child = spawn(npm, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`${name} failed to start: ${error.message}`);
    exitCode = 1;
    stop();
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${name} stopped (${signal ?? code ?? "unknown"})`);
      exitCode = code && code !== 0 ? code : 1;
      stop();
    }
    if (children.every((entry) => entry.exitCode !== null || entry.signalCode))
      process.exit(exitCode);
  });
}

function buildShared() {
  const result = spawnSync(npm, ["run", "build", "-w", "@estate/shared"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Shared game data failed to build");
}

function indexerStartHeight(contractId) {
  const explicit = process.env.INDEXER_START_HEIGHT;
  let configured = explicit;
  if (configured === undefined) {
    const record = JSON.parse(
      readFileSync(
        resolve(root, "deployments/testnet-indexer-backfill.json"),
        "utf8",
      ),
    );
    configured = record.contractId === contractId ? record.startHeight : NaN;
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(
      "Set INDEXER_START_HEIGHT to the contract creation height, or DEV_INDEXER=0 for offline city work",
    );
  return value;
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

if (mode === "--guest") {
  buildShared();
  start("shared", ["run", "dev", "-w", "@estate/shared"], {});
  console.log(`Guest preview: http://localhost:${webPort}`);
  start(
    "web",
    [
      "run",
      "dev",
      "-w",
      "@estate/web",
      "--",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      VITE_ESTATE_CONTRACT_ID: "",
      VITE_ESTATE_SOURCE_REVISION: "local",
    },
  );
} else {
  const devIndexer = process.env.DEV_INDEXER ?? "1";
  if (devIndexer !== "0" && devIndexer !== "1")
    throw new Error("DEV_INDEXER must be 0 or 1");
  const deployment = JSON.parse(
    readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
  );
  const contractId =
    process.env.ESTATE_CONTRACT_ID?.trim() || deployment.contractId;
  if (!/^[a-z0-9._-]+\.testnet$/.test(contractId))
    throw new Error("The city needs a deployed .testnet contract ID");
  const withApi = Boolean(process.env.API_DATA_DIR);
  const startHeight =
    withApi && devIndexer === "1" ? indexerStartHeight(contractId) : null;
  const dataDir = withApi ? resolve(process.env.API_DATA_DIR) : null;
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const release = withApi ? activeCityRelease(contractId) : null;
  const needsCutover = Boolean(
    release ||
      (contractId === deployment.contractId &&
        deployment.citySeedVersion === 2) ||
      process.env.CITY_DEED_CUTOVER_AT_MS,
  );
  if (
    dataDir &&
    needsCutover &&
    !release &&
    (!process.env.CITY_DEED_CUTOVER_AT_MS ||
      !process.env.IMPRESSION_ACCEPT_AFTER_MS)
  )
    throw new Error(
      "Version-2 API needs an active release record or explicit cutover and impression timestamps",
    );
  if (
    release &&
    (!Number.isSafeInteger(release.cutoverAtMs) ||
      !Number.isSafeInteger(release.reopenedAtMs) ||
      release.reopenedAtMs < release.cutoverAtMs)
  )
    throw new Error("Active city release has invalid cutover timestamps");
  if (dataDir && needsCutover) {
    const sqlitePath = resolve(dataDir, "estate.sqlite");
    if (!existsSync(sqlitePath))
      throw new Error(
        "Version-2 dev API needs API_DATA_DIR with the migrated estate.sqlite database",
      );
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      const table = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deed_history_links'",
        )
        .get();
      const link = table
        ? db
            .prepare("SELECT cutover_at_ms FROM deed_history_links LIMIT 1")
            .get()
        : null;
      if (
        !link ||
        String(link.cutover_at_ms) !==
          String(process.env.CITY_DEED_CUTOVER_AT_MS ?? release?.cutoverAtMs)
      )
        throw new Error(
          "API_DATA_DIR needs the applied version-2 deed move at the active release cutover",
        );
    } finally {
      db.close();
    }
  }
  buildShared();
  start("shared", ["run", "dev", "-w", "@estate/shared"], {});
  console.log(`Live city: http://localhost:${webPort}`);
  console.log(`Contract: ${contractId}`);
  if (dataDir) {
    console.log(`Local API data: ${dataDir}`);
    start("api", ["run", "dev", "-w", "@estate/api"], {
      APP_ORIGIN: `http://localhost:${webPort}`,
      ESTATE_CONTRACT_ID: contractId,
      API_DATA_DIR: dataDir,
      PORT: String(apiPort),
      CITY_DEED_CUTOVER_AT_MS: String(
        process.env.CITY_DEED_CUTOVER_AT_MS ?? release?.cutoverAtMs ?? 0,
      ),
      IMPRESSION_ACCEPT_AFTER_MS: String(
        process.env.IMPRESSION_ACCEPT_AFTER_MS ?? release?.reopenedAtMs ?? 0,
      ),
    });
    if (startHeight !== null) {
      console.log(`Event indexer: from block ${startHeight}`);
      start("indexer", ["run", "dev", "-w", "@estate/worker"], {
        ESTATE_CONTRACT_ID: contractId,
        INDEXER_START_HEIGHT: String(startHeight),
        API_DATA_DIR: dataDir,
      });
    }
  } else {
    console.log(
      "Web-only city preview: live chain and wallet are available; approved media and stats need API_DATA_DIR with the migrated service data.",
    );
    unavailableApi = createServer((_request, response) => {
      response.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          code: "LOCAL_API_UNAVAILABLE",
          message: "Start dev:city with API_DATA_DIR for media and stats",
        }),
      );
    });
    unavailableApi.listen(apiPort, "127.0.0.1");
  }
  start(
    "web",
    [
      "run",
      "dev",
      "-w",
      "@estate/web",
      "--",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      VITE_ESTATE_CONTRACT_ID: contractId,
      VITE_ESTATE_SOURCE_REVISION: "local",
      ESTATE_LOCAL_API_URL: `http://127.0.0.1:${apiPort}`,
    },
  );
}
