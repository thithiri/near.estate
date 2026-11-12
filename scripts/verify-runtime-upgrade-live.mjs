#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { baseDecode } from "@near-js/utils";

const root = resolve(import.meta.dirname, "..");
const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
);
const prefix = deployment.wasmSha256.slice(0, 16);
const releaseRelative = `deployments/runtime-upgrade-live-${prefix}.json`;
const release = JSON.parse(
  readFileSync(resolve(root, releaseRelative), "utf8"),
);
const map = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet-variable-map-journey.json")),
);
assert.equal(deployment.network, "testnet");
assert.equal(deployment.citySeedVersion, 2);
assert.equal(release.network, "testnet");
assert.equal(release.contractId, deployment.contractId);
assert.equal(release.status, "verified");
assert.equal(release.afterWasmSha256, deployment.wasmSha256);
assert.equal(release.finalCodeSha256, deployment.wasmSha256);
assert.equal(release.beforeStateSha256, release.finalStateSha256);
for (const field of [
  "pauseTransactionHash",
  "deployTransactionHash",
  "reopenTransactionHash",
])
  assert.equal(typeof release[field], "string", `${field} is missing`);
assert.equal(map.contractId, deployment.contractId);
assert.equal(map.currentCodeSha256, deployment.wasmSha256);
assert(map.runtimeUpgradeRecords.includes(releaseRelative));
assert.equal(map.plots, 100);
assert.equal(map.curbSpaces, 180);
assert.equal(map.civicSites, 7);

const rpcUrl =
  process.env.ESTATE_TESTNET_RPC_URL ?? "https://test.rpc.fastnear.com";
assert(rpcUrl.startsWith("https://"), "Testnet RPC must use HTTPS");
async function query(params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "estate-runtime-postcheck",
      method: "query",
      params,
    }),
  });
  assert(response.ok, `Testnet RPC returned ${response.status}`);
  const envelope = await response.json();
  assert(
    !envelope.error,
    `Testnet RPC rejected query: ${JSON.stringify(envelope.error)}`,
  );
  assert(envelope.result, "Testnet RPC omitted result");
  return envelope.result;
}

const account = await query({
  request_type: "view_account",
  finality: "final",
  account_id: deployment.contractId,
});
const codeSha256 = Buffer.from(baseDecode(account.code_hash)).toString("hex");
assert.equal(
  codeSha256,
  deployment.wasmSha256,
  "Live code differs from manifest",
);
const blockHash = account.block_hash;
assert(typeof blockHash === "string" && blockHash.length > 0);

async function view(method) {
  const result = await query({
    request_type: "call_function",
    block_id: blockHash,
    account_id: deployment.contractId,
    method_name: method,
    args_base64: Buffer.from("{}").toString("base64"),
  });
  assert.equal(
    result.block_hash,
    blockHash,
    `${method} returned another block`,
  );
  assert(Array.isArray(result.result), `${method} omitted value`);
  return JSON.parse(Buffer.from(result.result).toString("utf8"));
}

const [cityVersion, plotCount, npcSiteCount, paused, roles] = await Promise.all(
  [
    view("city_version"),
    view("plot_count"),
    view("npc_site_count"),
    view("is_paused"),
    view("get_roles"),
  ],
);
assert.equal(cityVersion, 2);
assert.equal(plotCount, deployment.plotCount);
assert.equal(npcSiteCount, deployment.npcSiteCount);
assert.equal(paused, false);
assert.deepEqual(roles, [
  deployment.contractId,
  deployment.moderatorId,
  deployment.inspectorId,
]);

const evidence = {
  network: "testnet",
  contractId: deployment.contractId,
  releaseRecord: releaseRelative,
  mapAuditRecord: "deployments/testnet-variable-map-journey.json",
  finalizedBlockHeight: account.block_height,
  finalizedBlockHash: blockHash,
  codeSha256,
  cityVersion,
  plotCount,
  curbSpaces: map.curbSpaces,
  npcSiteCount,
  paused,
  roles,
  statePreservedAtRelease: true,
  checkedAt: new Date().toISOString(),
};
if (process.argv[2] === "--write")
  writeFileSync(
    resolve(root, `deployments/runtime-upgrade-postcheck-${prefix}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
else assert.equal(process.argv.length, 2, "Use --write to save the postcheck");
console.log(JSON.stringify(evidence, null, 2));
