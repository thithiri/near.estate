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
import { planPlotAgentTurn } from "./plot-agent-policy.mjs";
import {
  assertPlotAgentPermission,
  PLOT_AGENT_METHODS,
} from "./plot-agent-permission.mjs";

const CALL_GAS = 60n * 10n ** 12n;
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? null : args[at + 1];
};

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "near-estate-plot-agent",
      method,
      params,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const value = await response.json();
  if (value.error)
    throw new Error(`RPC ${method}: ${JSON.stringify(value.error)}`);
  return value.result;
}

async function view(url, contractId, method, args) {
  const response = await rpc(url, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (!Array.isArray(response?.result))
    throw new Error(`Invalid ${method} response`);
  return JSON.parse(Buffer.from(response.result).toString("utf8"));
}

async function privateKey(path, accountId) {
  const meta = await lstat(path);
  if (!meta.isFile() || meta.isSymbolicLink() || meta.mode & 0o077)
    throw new Error("Plot-agent key file must be a regular 0600 file");
  const record = JSON.parse(await readFile(path, "utf8"));
  if (record.accountId !== accountId || record.role !== "plot")
    throw new Error("Use a plot-role key for the selected account");
  const pair = KeyPair.fromString(record.secretKey);
  if (record.publicKey !== pair.getPublicKey().toString())
    throw new Error("Plot-agent key file has a mismatched public key");
  return pair;
}

async function accessKey(url, accountId, publicKey, contractId, method) {
  const key = await rpc(url, "query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: accountId,
    public_key: publicKey,
  });
  assertPlotAgentPermission(key, contractId, method);
  return key;
}

async function outcome(url, hash, accountId) {
  try {
    const status = await rpc(url, "tx", {
      tx_hash: hash,
      sender_account_id: accountId,
      wait_until: "NONE",
    });
    if (status?.final_execution_status !== "FINAL") return "pending";
    return status?.status?.Failure ? "failed" : "success";
  } catch (error) {
    if (/UNKNOWN_TRANSACTION|UnknownTransaction/.test(String(error)))
      return "unknown";
    throw error;
  }
}

async function resume(url, accountId, path) {
  let pending;
  try {
    const meta = await lstat(path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.mode & 0o077)
      throw new Error("Plot-agent journal must be a regular 0600 file");
    pending = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (
    pending.accountId !== accountId ||
    !PLOT_AGENT_METHODS.includes(pending.method)
  )
    throw new Error("Invalid pending plot-agent transaction");
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

function requestedAction(grantStatus) {
  const plotId = option("--plot-id");
  const design = option("--choose-design");
  const rule = option("--set-rule");
  const upgrade = args.includes("--upgrade-building");
  const requested =
    Number(design !== null) + Number(rule !== null) + Number(upgrade);
  if (!requested) return null;
  if (
    requested !== 1 ||
    !plotId ||
    !grantStatus.grant.plot_ids.includes(plotId)
  )
    throw new Error("Choose one action and an authorized --plot-id");
  if (Number(grantStatus.actions_remaining_today) <= 0)
    throw new Error("Plot agent has no actions left today");
  if (design !== null) {
    const choice = Number(design);
    if (!Number.isInteger(choice) || choice < 0 || choice > 4)
      throw new Error("--choose-design must be 0 through 4");
    if (!grantStatus.grant.allow_design_changes)
      throw new Error("Building changes are not authorized");
    return {
      kind: "call",
      method: "agent_choose_design",
      args: { plot_id: plotId, choice },
      reason: "requested curated design",
    };
  }
  if (rule !== null) {
    if (rule !== "Free" && rule !== "NoParking")
      throw new Error("--set-rule must be Free or NoParking");
    return {
      kind: "call",
      method: "agent_set_rule",
      args: { plot_id: plotId, rule: { kind: rule } },
      reason: "requested parking rule",
    };
  }
  if (!grantStatus.grant.allow_design_changes)
    throw new Error("Building changes are not authorized");
  if (BigInt(grantStatus.coins_remaining_today) <= 0n)
    throw new Error("Plot agent has no coin budget left today");
  return {
    kind: "call",
    method: "agent_upgrade_building",
    args: { plot_id: plotId },
    reason: "requested building upgrade",
  };
}

async function main() {
  const accountId = option("--account");
  const execute = args.includes("--execute");
  const keyFile = option("--key-file");
  if (!accountId || !/^[a-z0-9._-]+\.testnet$/.test(accountId))
    throw new Error("Pass --account <owner.testnet>");
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
  const journalDirectory = join(homedir(), ".near-estate-agent");
  const journal = join(journalDirectory, `${accountId}.plot.pending.json`);
  if (execute && (await resume(url, accountId, journal))) return;
  const [grantStatus, nowSeconds] = await Promise.all([
    view(url, contractId, "get_plot_agent_status", { owner: accountId }),
    view(url, contractId, "chain_time_seconds", {}),
  ]);
  if (!grantStatus) throw new Error("No plot-agent grant for this account");
  if (nowSeconds >= grantStatus.grant.expires_at)
    throw new Error("Plot-agent grant expired");
  let plan = requestedAction(grantStatus);
  if (!plan) {
    const plotViews = await Promise.all(
      grantStatus.grant.plot_ids.map((plotId) =>
        view(url, contractId, "get_plot", { plot_id: plotId }),
      ),
    );
    const sides = new Map();
    for (const viewPlot of plotViews) {
      if (!viewPlot) continue;
      const { road_id, side } = viewPlot.plot;
      sides.set(`${road_id}:${side}`, { road_id, side });
    }
    const streets = await Promise.all(
      [...sides.values()].map((side) =>
        view(url, contractId, "get_street_side", side),
      ),
    );
    plan = planPlotAgentTurn({
      grantStatus,
      frontages: streets.flatMap((street) => street.plots),
      nowSeconds,
    });
  }
  console.log(JSON.stringify({ accountId, contractId, plan }));
  if (!execute) return;
  const pair = await privateKey(keyFile, accountId);
  const publicKey = pair.getPublicKey().toString();
  if (grantStatus.grant.public_key !== publicKey)
    throw new Error("This key is not the authorized plot agent");
  const key = await accessKey(
    url,
    accountId,
    publicKey,
    contractId,
    plan.kind === "call" ? plan.method : "agent_ticket",
  );
  if (plan.kind !== "call") return;
  const transaction = createTransaction(
    accountId,
    pair.getPublicKey(),
    contractId,
    BigInt(key.nonce) + 1n,
    [actionCreators.functionCall(plan.method, plan.args, CALL_GAS, 0n)],
    baseDecode(key.block_hash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    pair.toString(),
  ).signTransaction(transaction);
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(journalDirectory);
  if (!directory.isDirectory() || directory.mode & 0o077)
    throw new Error("Plot-agent journal directory must be 0700");
  await writeFile(
    journal,
    JSON.stringify({
      accountId,
      method: plan.method,
      hash: baseEncode(hashBytes),
      signedTxBase64: Buffer.from(encodeTransaction(signed)).toString("base64"),
    }),
    { mode: 0o600, flag: "wx" },
  );
  await resume(url, accountId, journal);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
