import { readFileSync } from "node:fs";
import {
  InspectorPatrol,
  NearInspectorGateway,
} from "../services/api/dist/inspector-patrol.js";

const contractId = process.env.ESTATE_CONTRACT_ID;
const accountId = process.env.INSPECTOR_ACCOUNT_ID;
const keyFile = process.env.INSPECTOR_KEY_FILE;
if (!contractId || !accountId || !keyFile)
  throw new Error("Set the inspector journey contract, account and key file");

const credential = JSON.parse(readFileSync(keyFile, "utf8"));
if (credential.account_id !== accountId || !credential.private_key)
  throw new Error("Inspector journey key does not match the account");

const patrol = new InspectorPatrol(
  new NearInspectorGateway(
    contractId,
    accountId,
    credential.private_key,
    process.env.ESTATE_TESTNET_RPC_URL,
  ),
  ["main"],
  () => 0,
);
let result;
for (let tries = 0; tries < 12; tries++) {
  result = await patrol.runOnce();
  if (result.attempted > 0 || result.eligible > 0) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (
  result.roadId !== "main" ||
  result.side !== "North" ||
  result.eligible !== 1 ||
  result.attempted !== 1 ||
  result.failed !== 0
)
  throw new Error(
    `Inspector patrol did not complete one attempt: ${JSON.stringify(result)}`,
  );
console.log(`PATROL_RESULT:${JSON.stringify(result)}`);
