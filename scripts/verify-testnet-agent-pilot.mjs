#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(
  import.meta.dirname,
  "../deployments/testnet-agent-pilot-2026-11-14.json",
);
const report = JSON.parse(readFileSync(path, "utf8"));
const manifest = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../deployments/testnet.json"),
    "utf8",
  ),
);
assert.equal(report.network, "testnet");
assert.equal(report.contractId, manifest.contractId);
assert.equal(report.codeSha256, manifest.wasmSha256);
assert.equal(report.keysRevoked, true);
const rpcUrl =
  process.env.ESTATE_TESTNET_RPC_URL ?? "https://test.rpc.fastnear.com";
assert(rpcUrl.startsWith("https://"));

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "estate-agent-pilot-verify",
      method,
      params,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  assert(response.ok, `RPC HTTP ${response.status}`);
  const result = await response.json();
  if (result.error)
    throw new Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.result;
}

async function view(method, args) {
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: report.contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  assert(Array.isArray(result.result));
  return JSON.parse(Buffer.from(result.result).toString("utf8"));
}

const roles = Object.fromEntries(
  report.agents.map((agent) => [agent.role, agent]),
);
const expected = [
  ["driver-agent-park", "driver-parking", "parked"],
  ["owner-car-agent-park", "owner-parking", "parked"],
  ["owner-building-agent-design", "owner-plot", "building_updated"],
  ["driver-parking-collect", "driver-parking", "collected"],
  ["owner-parking-collect", "owner-parking", "collected"],
];
const receipts = [];
for (const [label, role, eventName] of expected) {
  const item = report.transactions.find((entry) => entry.label === label);
  assert(item?.hash, `${label} transaction is missing`);
  const result = await rpc("tx", {
    tx_hash: item.hash,
    sender_account_id: roles[role].accountId,
    wait_until: "FINAL",
  });
  assert.equal(result.final_execution_status, "FINAL", `${label} not final`);
  assert(
    "SuccessValue" in result.status || "SuccessReceiptId" in result.status,
    `${label} failed`,
  );
  assert.equal(result.transaction.signer_id, roles[role].accountId);
  assert.equal(result.transaction.public_key, roles[role].publicKey);
  assert.equal(result.transaction.receiver_id, report.contractId);
  const events = result.receipts_outcome
    .flatMap((receipt) => receipt.outcome.logs)
    .filter((log) => log.startsWith("EVENT_JSON:"))
    .map((log) => JSON.parse(log.slice("EVENT_JSON:".length)));
  const event = events.find((value) => value.event === eventName);
  assert(event, `${label} missing ${eventName} event`);
  if (eventName === "parked") {
    assert.equal(event.data[0].driver, roles[role].accountId);
    assert.equal(event.data[0].legal, true);
  }
  if (eventName === "building_updated") {
    assert.equal(event.data[0].plot_id, report.before.plot.id);
    assert.equal(event.data[0].change, "design");
    assert.equal(event.data[0].design_choice, report.after.plot.designChoice);
  }
  if (eventName === "collected")
    assert(BigInt(event.data[0].driver_payout) > 0n);
  receipts.push({
    label,
    hash: item.hash,
    signerPublicKey: result.transaction.public_key,
    event: eventName,
    data: event.data[0],
  });
}

for (const role of report.agents) {
  const listed = await rpc("query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: role.accountId,
  });
  assert(
    !listed.keys.some((entry) => entry.public_key === role.publicKey),
    `${role.role} key remains active`,
  );
}
assert.equal(
  await view("get_plot_agent_status", { owner: roles["owner-plot"].accountId }),
  null,
);
const plot = await view("get_plot", { plot_id: report.before.plot.id });
assert.equal(plot.plot.design_choice, report.after.plot.designChoice);
for (const role of ["driver-parking", "owner-parking"]) {
  const accountId = roles[role].accountId;
  const account = await view("get_account", { account_id: accountId });
  assert.equal(account.active_session_id, null);
  const before =
    role === "driver-parking" ? report.before.driver : report.before.owner;
  const after =
    role === "driver-parking" ? report.after.driver : report.after.owner;
  assert.equal(account.balance, after.balance);
  assert(BigInt(after.balance) > BigInt(before.balance));
  assert(after.durability < before.durability);
}
report.receiptEvidence = receipts;
report.verifiedAt = new Date().toISOString();
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    verified: true,
    agentActions: receipts.length,
    keysRevoked: true,
    report: path,
  }),
);
