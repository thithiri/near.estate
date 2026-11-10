import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateCitySeed } from "@estate/shared";
import { InspectorPatrol, NearInspectorGateway } from "./inspector-patrol.js";
import {
  InspectorStatusTracker,
  readInspectorStatus,
  writeInspectorStatus,
} from "./inspector-status.js";

const contractId = process.env.ESTATE_CONTRACT_ID?.trim();
const accountId = process.env.INSPECTOR_ACCOUNT_ID?.trim();
const keyFile = process.env.INSPECTOR_KEY_FILE?.trim();
if (!contractId || !accountId || !keyFile)
  throw new Error(
    "Set ESTATE_CONTRACT_ID, INSPECTOR_ACCOUNT_ID and INSPECTOR_KEY_FILE",
  );
const key = JSON.parse(readFileSync(keyFile, "utf8")) as {
  account_id?: string;
  private_key?: string;
  secret_key?: string;
};
if (key.account_id !== accountId)
  throw new Error("Inspector key account does not match INSPECTOR_ACCOUNT_ID");
const secret = key.private_key ?? key.secret_key;
if (!secret) throw new Error("Inspector key file lacks a private key");
const city = validateCitySeed(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../contracts/estate/seed.json", import.meta.url),
      ),
      "utf8",
    ),
  ),
);
const patrol = new InspectorPatrol(
  new NearInspectorGateway(
    contractId,
    accountId,
    secret,
    process.env.NEAR_RPC_URL,
  ),
  city.streets.map((street) => street.id),
);
const statusFile = process.env.INSPECTOR_STATUS_FILE?.trim();
const previousStatus = statusFile
  ? readInspectorStatus(statusFile, contractId)
  : null;
const statusTracker = new InspectorStatusTracker(
  contractId,
  previousStatus?.consecutiveFailures ?? 0,
);
const runPatrol = async () => {
  let result;
  try {
    result = await patrol.runOnce();
  } catch (error) {
    if (statusFile)
      await writeInspectorStatus(
        statusFile,
        statusTracker.failed(Math.floor(Date.now() / 1_000)),
      );
    throw error;
  }
  if (statusFile)
    await writeInspectorStatus(
      statusFile,
      statusTracker.completed(result, Math.floor(Date.now() / 1_000)),
    );
  return result;
};
const mode = process.argv[2] ?? "--run";
if (mode === "--once") {
  console.log(JSON.stringify(await runPatrol()));
} else if (mode === "--run") {
  let stopped = false;
  let wake: (() => void) | null = null;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopped) {
    try {
      console.log(JSON.stringify(await runPatrol()));
    } catch (error) {
      console.error("Inspector patrol retrying", error);
    }
    if (!stopped)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 300_000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    wake = null;
  }
} else {
  throw new Error("Unknown inspector mode");
}
