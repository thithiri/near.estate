#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const deployment = JSON.parse(
  readFileSync(join(root, "deployments/testnet.json"), "utf8"),
);
const directory = mkdtempSync(join(tmpdir(), "estate-monitor-delivery-"));
const certPath = join(directory, "receiver.crt");
const keyPath = join(directory, "receiver.key");
const tokenPath = join(directory, "webhook-token");
const token = randomBytes(32).toString("hex");
const received = [];
let child;
let server;
let childOutput = "";

try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  server = createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (request, response) => {
      if (request.method !== "POST" || request.url !== "/alerts") {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      const chunks = [];
      let bytes = 0;
      request.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 16_384) request.destroy();
        else chunks.push(chunk);
      });
      request.on("end", () => {
        try {
          const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (event.contractId !== deployment.contractId)
            throw new Error("Wrong contract in monitor event");
          received.push(event);
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
    },
  );
  await new Promise((done) => server.listen(0, "localhost", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Local HTTPS receiver did not bind a port");
  child = spawn(
    join(root, "node_modules/.bin/tsx"),
    [join(root, "services/worker/src/monitor.ts"), "--run"],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        NODE_EXTRA_CA_CERTS: certPath,
        API_DATA_DIR: join(directory, "missing-database"),
        ESTATE_CONTRACT_ID: deployment.contractId,
        ESTATE_MONITOR_DAILY_BUDGET_USD_MICROS: "0",
        ESTATE_MONITOR_INTERVAL_SECONDS: "1",
        ESTATE_MONITOR_HEARTBEAT_SECONDS: "1",
        ESTATE_MONITOR_API_HEALTH_URL: "http://127.0.0.1:1/health",
        ESTATE_MONITOR_WEBHOOK_URL: `https://localhost:${address.port}/alerts`,
        ESTATE_MONITOR_WEBHOOK_TOKEN_FILE: tokenPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    childOutput += chunk;
  });
  child.stderr.on("data", (chunk) => {
    childOutput += chunk;
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const codes = new Set(received.map((event) => event.code ?? event.kind));
    if (
      ["MONITOR_DATABASE_UNAVAILABLE", "API_UNAVAILABLE", "heartbeat"].every(
        (code) => codes.has(code),
      )
    )
      break;
    if (child.exitCode !== null)
      throw new Error(`Monitor exited early: ${childOutput.slice(-1200)}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  const codes = new Set(received.map((event) => event.code ?? event.kind));
  for (const code of [
    "MONITOR_DATABASE_UNAVAILABLE",
    "API_UNAVAILABLE",
    "heartbeat",
  ])
    if (!codes.has(code))
      throw new Error(
        `Monitor did not deliver ${code}: ${childOutput.slice(-1200)}`,
      );
  const result = {
    scope: "local loopback HTTPS receiver, real worker monitor process",
    contractId: deployment.contractId,
    tlsVerifiedByClient: true,
    privateTokenFile: true,
    delivered: [...codes],
    observedAt: new Date().toISOString(),
    hostedDeliveryVerified: false,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((done) => {
      child.once("exit", done);
      setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, 2_000).unref();
    });
  }
  if (server) await new Promise((done) => server.close(done));
  rmSync(directory, { recursive: true, force: true });
}
