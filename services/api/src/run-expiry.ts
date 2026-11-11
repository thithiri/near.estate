import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateCitySeed } from "@estate/shared";
import { ExpirySweeper, NearExpiryGateway } from "./expiry-sweep.js";

const contractId = process.env.ESTATE_CONTRACT_ID?.trim();
const accountId = process.env.EXPIRY_ACCOUNT_ID?.trim();
const keyFile = process.env.EXPIRY_KEY_FILE?.trim();
if (!contractId || !accountId || !keyFile)
  throw new Error(
    "Set ESTATE_CONTRACT_ID, EXPIRY_ACCOUNT_ID and EXPIRY_KEY_FILE",
  );
const keyStat = lstatSync(keyFile);
if (
  !keyStat.isFile() ||
  keyStat.isSymbolicLink() ||
  (keyStat.mode & 0o077) !== 0
)
  throw new Error("Expiry key file must be a private regular file");
const key = JSON.parse(readFileSync(keyFile, "utf8")) as {
  account_id?: string;
  private_key?: string;
};
if (key.account_id !== accountId || !key.private_key)
  throw new Error("Expiry key file does not match EXPIRY_ACCOUNT_ID");
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
const towers = city.npcSites
  .filter((site) => site.role === "ParkingTower")
  .map((site) => ({ id: site.id, capacity: site.capacity }));
const intervalSeconds = Number(process.env.EXPIRY_SWEEP_INTERVAL_SECONDS ?? 60);
if (
  !Number.isSafeInteger(intervalSeconds) ||
  intervalSeconds < 60 ||
  intervalSeconds > 900
)
  throw new Error("Expiry sweep interval must be 60–900 seconds");
const sweeper = new ExpirySweeper(
  new NearExpiryGateway(
    contractId,
    accountId,
    key.private_key,
    process.env.NEAR_RPC_URL,
  ),
  city.streets.map((street) => street.id),
  towers,
  Number(process.env.EXPIRY_MAX_SETTLEMENTS_PER_PASS ?? 8),
);
const mode = process.argv[2] ?? "--run";
if (mode === "--once") {
  console.log(JSON.stringify(await sweeper.runOnce()));
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
      console.log(JSON.stringify(await sweeper.runOnce()));
    } catch (error) {
      console.error("Expiry sweep retrying", error);
    }
    if (!stopped)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalSeconds * 1_000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    wake = null;
  }
} else {
  throw new Error("Unknown expiry sweep mode");
}
