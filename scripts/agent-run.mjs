#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? null : args[at + 1];
};
const accountId = option("--account");
const keyFile = option("--key-file");
const carId = Number(option("--car-id"));
const interval = Number(option("--interval-minutes") ?? "5");
if (!accountId || !/^[a-z0-9._-]+\.testnet$/.test(accountId))
  throw new Error("Pass --account <player.testnet>");
if (!keyFile || !isAbsolute(keyFile))
  throw new Error("Pass an absolute --key-file path");
if (!Number.isSafeInteger(carId) || carId < 1)
  throw new Error("Pass --car-id for the car this agent may use");
if (!Number.isInteger(interval) || interval < 2 || interval > 60)
  throw new Error("--interval-minutes must be from 2 to 60");

const runnerArgs = [
  fileURLToPath(new URL("./agent-play.mjs", import.meta.url)),
  "--execute",
  "--account",
  accountId,
  "--key-file",
  keyFile,
  "--car-id",
  String(carId),
];
for (const name of ["--contract", "--rpc"]) {
  const value = option(name);
  if (value) runnerArgs.push(name, value);
}

let stopped = false;
let child = null;
let wake = null;
function stop() {
  stopped = true;
  child?.kill("SIGTERM");
  wake?.();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function runOne() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, runnerArgs, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      child = null;
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

console.log(
  `Parking agent started for ${accountId}; checking every ${interval} minutes.`,
);
while (!stopped) {
  const code = await runOne();
  if (stopped) break;
  if (code !== 0) {
    console.error("Parking agent stopped after a failed action or key check.");
    process.exitCode = code;
    break;
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, interval * 60_000);
    wake = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  wake = null;
}
