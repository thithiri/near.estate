import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
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
let stopping = false;
let exitCode = 0;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
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
  const startHeight =
    devIndexer === "1" ? indexerStartHeight(contractId) : null;
  const dataDir = resolve(
    process.env.API_DATA_DIR ?? resolve(root, "data/local-dev"),
  );
  mkdirSync(dataDir, { recursive: true });
  buildShared();
  start("shared", ["run", "dev", "-w", "@estate/shared"], {});
  console.log(`Live city: http://localhost:${webPort}`);
  console.log(`Contract: ${contractId}`);
  console.log(`Local API data: ${dataDir}`);
  if (!process.env.API_DATA_DIR)
    console.log(
      "Set API_DATA_DIR to an existing private media volume to see approved uploads.",
    );
  start("api", ["run", "dev", "-w", "@estate/api"], {
    APP_ORIGIN: `http://localhost:${webPort}`,
    ESTATE_CONTRACT_ID: contractId,
    API_DATA_DIR: dataDir,
    PORT: String(apiPort),
  });
  if (startHeight !== null) {
    console.log(`Event indexer: from block ${startHeight}`);
    start("indexer", ["run", "dev", "-w", "@estate/worker"], {
      ESTATE_CONTRACT_ID: contractId,
      INDEXER_START_HEIGHT: String(startHeight),
      API_DATA_DIR: dataDir,
    });
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
      ESTATE_LOCAL_API_URL: `http://127.0.0.1:${apiPort}`,
    },
  );
}
