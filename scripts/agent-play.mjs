#!/usr/bin/env node
import { readFile, mkdir, writeFile, lstat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
} from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import { planAgentTurn } from "./agent-policy.mjs";

const CALL_GAS = 60n * 10n ** 12n;
const METHODS = ["park", "collect", "settle_expired"];
const ROADS = ["main", "market", "river", "central", "harbor"];
const SIDES = ["North", "South"];
const args = process.argv.slice(2);
const option = (name) => {
  const position = args.indexOf(name);
  return position < 0 ? null : args[position + 1];
};

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "near-estate-agent",
      method,
      params,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope.error)
    throw new Error(`RPC ${method}: ${JSON.stringify(envelope.error)}`);
  return envelope.result;
}

function encodeArgs(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

async function view(url, contractId, method, value) {
  const result = await rpc(url, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: encodeArgs(value),
  });
  if (!Array.isArray(result?.result))
    throw new Error(`Invalid ${method} response`);
  return JSON.parse(Buffer.from(result.result).toString("utf8"));
}

async function privateKey(file, accountId) {
  const meta = await lstat(file);
  if (!meta.isFile() || meta.isSymbolicLink() || (meta.mode & 0o077) !== 0)
    throw new Error("Key file must be a regular file with permissions 0600");
  const record = JSON.parse(await readFile(file, "utf8"));
  if (
    record.accountId !== accountId ||
    !/^ed25519:[A-Za-z0-9]+$/.test(record.secretKey)
  )
    throw new Error(
      "Key file must contain this accountId and an ed25519 secretKey",
    );
  return record.secretKey;
}

async function permission(url, accountId, publicKey, contractId, method) {
  const key = await rpc(url, "query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: accountId,
    public_key: publicKey,
  });
  const call = key?.permission?.FunctionCall;
  if (
    !call ||
    call.receiver_id !== contractId ||
    !Array.isArray(call.method_names) ||
    !call.method_names.includes(method) ||
    call.allowance === null ||
    BigInt(call.allowance ?? "0") <= 0n
  )
    throw new Error(
      "Agent key must have a finite function-call allowance for this game method",
    );
  return key;
}

function journalPath(accountId) {
  return join(homedir(), ".near-estate-agent", `${accountId}.pending.json`);
}

async function outcome(url, hash, accountId) {
  try {
    const status = await rpc(url, "tx", {
      tx_hash: hash,
      sender_account_id: accountId,
      wait_until: "NONE",
    });
    if (status?.final_execution_status !== "FINAL") return "pending";
    if (status?.status?.Failure) return "failed";
    return "success";
  } catch (error) {
    if (/UNKNOWN_TRANSACTION|UnknownTransaction/.test(String(error)))
      return "unknown";
    throw error;
  }
}

async function resume(url, accountId, path) {
  let pending;
  try {
    pending = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (pending.accountId !== accountId || !METHODS.includes(pending.method))
    throw new Error("Invalid pending agent transaction");
  let state = await outcome(url, pending.hash, accountId);
  if (state === "unknown" || state === "pending") {
    try {
      const sent = await rpc(url, "send_tx", {
        signed_tx_base64: pending.signedTxBase64,
        wait_until: "FINAL",
      });
      state =
        sent?.final_execution_status === "FINAL"
          ? sent?.status?.Failure
            ? "failed"
            : "success"
          : "pending";
    } catch {
      state = await outcome(url, pending.hash, accountId).catch(
        () => "pending",
      );
    }
  }
  if (state === "success" || state === "failed") await unlink(path);
  console.log(
    JSON.stringify({ action: pending.method, hash: pending.hash, state }),
  );
  if (state === "failed") process.exitCode = 1;
  return true;
}

async function main() {
  const accountId = option("--account");
  const execute = args.includes("--execute");
  const keyFile = option("--key-file");
  if (!accountId || !/^[a-z0-9._-]+\.testnet$/.test(accountId))
    throw new Error("Pass --account <player.testnet>");
  if (execute && !keyFile) throw new Error("Execution requires --key-file");
  const deployment = JSON.parse(
    await readFile(new URL("../deployments/testnet.json", import.meta.url)),
  );
  const contractId = option("--contract") ?? deployment.contractId;
  const url = option("--rpc") ?? "https://test.rpc.fastnear.com";
  if (
    !/^[a-z0-9._-]+\.testnet$/.test(contractId) ||
    !url.startsWith("https://")
  )
    throw new Error("Testnet contract and HTTPS RPC required");
  const path = journalPath(accountId);
  if (execute && (await resume(url, accountId, path))) return;
  const [account, cars, nowSeconds] = await Promise.all([
    view(url, contractId, "get_account", { account_id: accountId }),
    view(url, contractId, "get_cars", { account_id: accountId }),
    view(url, contractId, "chain_time_seconds", {}),
  ]);
  const activeSession =
    account?.active_session_id == null
      ? null
      : await view(url, contractId, "get_session", {
          session_id: account.active_session_id,
        });
  let plots = [];
  if (account && !activeSession) {
    const sides = await Promise.all(
      ROADS.flatMap((road_id) =>
        SIDES.map((side) =>
          view(url, contractId, "get_street_side", { road_id, side }),
        ),
      ),
    );
    plots = sides.flatMap((side) => side.plots);
  }
  const plan = planAgentTurn({
    player: { account, cars, active_session: activeSession },
    plots,
    nowSeconds,
    accountId,
  });
  console.log(JSON.stringify({ accountId, contractId, plan }));
  if (!execute || plan.kind !== "call") return;
  if (!METHODS.includes(plan.method))
    throw new Error("Agent policy requested an unsupported method");
  const secretKey = await privateKey(keyFile, accountId);
  const keyPair = KeyPair.fromString(secretKey);
  const publicKey = keyPair.getPublicKey().toString();
  const key = await permission(
    url,
    accountId,
    publicKey,
    contractId,
    plan.method,
  );
  const transaction = createTransaction(
    accountId,
    keyPair.getPublicKey(),
    contractId,
    BigInt(key.nonce) + 1n,
    [actionCreators.functionCall(plan.method, plan.args, CALL_GAS, 0n)],
    baseDecode(key.block_hash),
  );
  const signer = KeyPairSigner.fromSecretKey(secretKey);
  const [hashBytes, signed] = await signer.signTransaction(transaction);
  const pending = {
    accountId,
    method: plan.method,
    hash: baseEncode(hashBytes),
    signedTxBase64: Buffer.from(encodeTransaction(signed)).toString("base64"),
  };
  await mkdir(join(homedir(), ".near-estate-agent"), {
    recursive: true,
    mode: 0o700,
  });
  const journalDirectory = await lstat(join(homedir(), ".near-estate-agent"));
  if (!journalDirectory.isDirectory() || (journalDirectory.mode & 0o077) !== 0)
    throw new Error("Agent journal directory must have permissions 0700");
  await writeFile(path, JSON.stringify(pending), { mode: 0o600, flag: "wx" });
  await resume(url, accountId, path);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
