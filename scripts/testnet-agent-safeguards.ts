import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { KeyPair, PublicKey } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
} from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import { ChainReader } from "../apps/web/src/chain-reader.js";
import {
  PLOT_AGENT_KEY_ALLOWANCE,
  PLOT_AGENT_METHODS,
} from "../apps/web/src/wallet-client.js";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "deployments/testnet.json"), "utf8"),
);
const reader = new ChainReader(manifest.contractId);
const ownerId = "dev-20261110121829-19069405494728.testnet";
const plotId = "plot-main-n-1";
const otherPlotId = "plot-main-n-7";
const directory = process.env.ESTATE_AGENT_SAFEGUARD_DIR;
const reportPath = join(
  root,
  "deployments/testnet-agent-safeguards-2026-11-14.json",
);
const gas = 30n * 10n ** 12n;
type Credential = {
  account_id: string;
  public_key: string;
  secret_key: `ed25519:${string}`;
};
type AgentKey = {
  accountId: string;
  role: string;
  publicKey: string;
  secretKey: `ed25519:${string}`;
};
type Outcome = "success" | "failure" | "pending" | "unknown";

function privateJson(path: string): unknown {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    realpathSync(path).startsWith(`${root}/`)
  )
    throw new Error(
      "Credentials and journals must be private regular files outside the repository",
    );
  return JSON.parse(readFileSync(path, "utf8"));
}

function ownerCredential(): Credential {
  const path = process.env.ESTATE_OWNER_KEY_FILE;
  if (!path?.startsWith("/"))
    throw new Error("Set ESTATE_OWNER_KEY_FILE to a protected absolute path");
  const credential = privateJson(path) as Credential;
  assert.equal(credential.account_id, ownerId);
  assert.equal(
    KeyPair.fromString(credential.secret_key).getPublicKey().toString(),
    credential.public_key,
  );
  return credential;
}

function agentKey(): AgentKey {
  assert(directory?.startsWith("/") && !directory.startsWith(`${root}/`));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.equal(lstatSync(directory).mode & 0o077, 0);
  const path = join(directory, "owner-plot-safeguards.key.json");
  if (!existsSync(path)) {
    const pair = KeyPair.fromRandom("ed25519");
    writeFileSync(
      path,
      JSON.stringify({
        accountId: ownerId,
        role: "plot",
        publicKey: pair.getPublicKey().toString(),
        secretKey: pair.toString(),
      }),
      { mode: 0o600, flag: "wx" },
    );
  }
  const key = privateJson(path) as AgentKey;
  assert.equal(key.accountId, ownerId);
  assert.equal(key.role, "plot");
  assert.equal(
    KeyPair.fromString(key.secretKey).getPublicKey().toString(),
    key.publicKey,
  );
  return key;
}

async function submit(
  label: string,
  secret: `ed25519:${string}`,
  receiver: string,
  actions: Parameters<typeof createTransaction>[4],
  simulateLostReply = false,
) {
  assert(directory);
  const journal = join(directory, `${label}.pending.json`);
  let signed: { hash: string; bytes: string };
  if (existsSync(journal)) signed = privateJson(journal) as typeof signed;
  else {
    const pair = KeyPair.fromString(secret);
    const access = await reader.accessKey(
      ownerId,
      pair.getPublicKey().toString(),
    );
    const transaction = createTransaction(
      ownerId,
      pair.getPublicKey(),
      receiver,
      access.nonce + 1n,
      actions,
      baseDecode(access.blockHash),
    );
    const [hashBytes, encoded] =
      await KeyPairSigner.fromSecretKey(secret).signTransaction(transaction);
    signed = {
      hash: baseEncode(hashBytes),
      bytes: Buffer.from(encodeTransaction(encoded)).toString("base64"),
    };
    writeFileSync(journal, JSON.stringify(signed), { mode: 0o600, flag: "wx" });
  }
  let outcome: Outcome = await reader.transactionStatus(signed.hash, ownerId);
  if (outcome === "unknown" || outcome === "pending") {
    try {
      if (simulateLostReply) {
        // Broadcast the exact signed bytes, then deliberately discard the RPC reply.
        await fetch(
          process.env.ESTATE_TESTNET_RPC_URL ?? "https://test.rpc.fastnear.com",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: label,
              method: "send_tx",
              params: { signed_tx_base64: signed.bytes, wait_until: "NONE" },
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
      } else outcome = await reader.sendSignedTransaction(signed.bytes);
    } catch {
      // An uncertain RPC reply is resolved by the signed transaction hash.
    }
  }
  for (
    let attempt = 0;
    outcome === "unknown" || outcome === "pending";
    attempt++
  ) {
    if (attempt >= 30)
      throw new Error(
        `Transaction ${signed.hash} did not finalize; inspect the protected journal`,
      );
    if (attempt > 0 && attempt % 5 === 0) {
      try {
        outcome = await reader.sendSignedTransaction(signed.bytes);
      } catch {
        // Rebroadcasting identical signed bytes cannot create a second action.
      }
    }
    if (outcome === "unknown" || outcome === "pending") {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      outcome = await reader.transactionStatus(signed.hash, ownerId);
    }
  }
  const failure =
    outcome === "failure"
      ? await reader.transactionFailureMessage(signed.hash, ownerId)
      : null;
  unlinkSync(journal);
  return { label, hash: signed.hash, outcome, failure };
}

async function verify() {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.contractId, manifest.contractId);
  assert.equal(report.codeSha256, manifest.wasmSha256);
  assert.equal(report.keysRevoked, true);
  for (const transaction of report.transactions) {
    assert.equal(
      await reader.transactionStatus(transaction.hash, ownerId),
      transaction.outcome,
      transaction.label,
    );
  }
  const [grant, history, keys, plot] = await Promise.all([
    reader.plotAgentStatus(ownerId),
    reader.plotAgentHistory(ownerId),
    reader.accessKeyList(ownerId),
    reader.plot(plotId),
  ]);
  assert.equal(grant, null);
  assert(
    !keys.keys.some((entry) => entry.public_key === report.agentPublicKey),
  );
  assert(
    history.some(
      (action) =>
        action.kind === "Design" && action.public_key === report.agentPublicKey,
    ),
  );
  assert(plot && "design_choice" in plot.plot);
  assert.equal(plot.plot.design_choice, report.originalDesignChoice);
  console.log(
    JSON.stringify({
      report: reportPath,
      transactions: report.transactions.length,
      keysRevoked: true,
      historyEntries: history.length,
    }),
  );
}

async function apply() {
  const owner = ownerCredential();
  const key = agentKey();
  const [target, other, priorHistory, priorGrant] = await Promise.all([
    reader.plot(plotId),
    reader.plot(otherPlotId),
    reader.plotAgentHistory(ownerId),
    reader.plotAgentStatus(ownerId),
  ]);
  assert(target && "design_choice" in target.plot);
  assert(other && "design_choice" in other.plot);
  assert.equal(target.plot.owner, ownerId);
  assert.equal(other.plot.owner, ownerId);
  assert.equal(target.plot.building.approved_manifest_hash, null);
  assert.equal(target.plot.logo.active, null);
  assert.equal(target.plot.billboard.active, null);
  assert.equal(
    priorGrant,
    null,
    "Revoke the previous grant before the safeguards journey",
  );
  const report: Record<string, unknown> = {
    network: "testnet",
    contractId: manifest.contractId,
    codeSha256: manifest.wasmSha256,
    ownerId,
    plotId,
    otherPlotId,
    agentPublicKey: key.publicKey,
    originalDesignChoice: target.plot.design_choice,
    priorHistoryCount: priorHistory.length,
    transactions: [] as unknown[],
  };
  const transactions = report.transactions as Awaited<
    ReturnType<typeof submit>
  >[];
  const send = async (
    label: string,
    secret: `ed25519:${string}`,
    receiver: string,
    actions: Parameters<typeof createTransaction>[4],
    expected: "success" | "failure",
    lost = false,
  ) => {
    const result = await submit(label, secret, receiver, actions, lost);
    transactions.push(result);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    assert.equal(
      result.outcome,
      expected,
      `${label}: ${result.failure ?? "unexpected outcome"}`,
    );
    return result;
  };
  const call = (method: string, args: object, deposit = 0n) => [
    actionCreators.functionCall(method, args, gas, deposit),
  ];
  const listed = await reader.accessKeyList(ownerId);
  assert(!listed.keys.some((entry) => entry.public_key === key.publicKey));
  await send(
    "safeguard-add-key",
    owner.secret_key,
    ownerId,
    [
      actionCreators.addKey(
        PublicKey.fromString(key.publicKey),
        actionCreators.functionCallAccessKey(
          manifest.contractId,
          [...PLOT_AGENT_METHODS],
          PLOT_AGENT_KEY_ALLOWANCE,
        ),
      ),
    ],
    "success",
  );
  const quote = await reader.plotAgentStorageQuote();
  const expires = (await reader.chainTimeSeconds()) + 3_600;
  await send(
    "safeguard-authorize",
    owner.secret_key,
    manifest.contractId,
    call(
      "authorize_plot_agent",
      {
        public_key: key.publicKey,
        plot_ids: [plotId],
        expires_at: expires,
        daily_coin_limit: "0",
        daily_action_limit: 5,
        allow_design_changes: true,
      },
      BigInt(quote),
    ),
    "success",
  );
  const beforeStatus = await reader.plotAgentStatus(ownerId);
  assert(beforeStatus);
  const wrongPlot = await send(
    "safeguard-wrong-plot",
    key.secretKey,
    manifest.contractId,
    call("agent_choose_design", {
      plot_id: otherPlotId,
      choice: other.plot.design_choice,
      expected_layout_revision: other.plot.building.layout_revision,
    }),
    "failure",
  );
  assert.match(wrongPlot.failure ?? "", /plot|scope|grant|authorized/i);
  assert.equal(
    (await reader.plotAgentStatus(ownerId))?.grant.actions_today,
    beforeStatus.grant.actions_today,
  );
  const overBudget = await send(
    "safeguard-over-budget",
    key.secretKey,
    manifest.contractId,
    call("agent_upgrade_building", {
      plot_id: plotId,
      expected_layout_revision: target.plot.building.layout_revision,
    }),
    "failure",
  );
  assert.match(overBudget.failure ?? "", /coin|limit|budget/i);
  const competingChoice = target.plot.design_choice === 4 ? 3 : 4;
  await send(
    "safeguard-owner-edit",
    owner.secret_key,
    manifest.contractId,
    call("choose_design", { plot_id: plotId, choice: competingChoice }),
    "success",
  );
  const edited = await reader.plot(plotId);
  assert(edited && "design_choice" in edited.plot);
  assert.equal(edited.plot.design_choice, competingChoice);
  const stale = await send(
    "safeguard-stale-preview",
    key.secretKey,
    manifest.contractId,
    call("agent_choose_design", {
      plot_id: plotId,
      choice: target.plot.design_choice,
      expected_layout_revision: target.plot.building.layout_revision,
    }),
    "failure",
  );
  assert.match(stale.failure ?? "", /changed since agent preview/i);
  assert.equal(
    (await reader.plotAgentStatus(ownerId))?.grant.actions_today,
    beforeStatus.grant.actions_today,
  );
  const recovered = await send(
    "safeguard-lost-reply",
    key.secretKey,
    manifest.contractId,
    call("agent_choose_design", {
      plot_id: plotId,
      choice: target.plot.design_choice,
      expected_layout_revision: edited.plot.building.layout_revision,
    }),
    "success",
    true,
  );
  const history = await reader.plotAgentHistory(ownerId);
  assert.equal(history.at(-1)?.kind, "Design");
  assert.equal(history.at(-1)?.public_key, key.publicKey);
  assert.equal(history.at(-1)?.plot_id, plotId);
  assert.equal(history.at(-1)?.coin_cost, "0");
  assert.equal(
    (await reader.plotAgentStatus(ownerId))?.grant.actions_today,
    beforeStatus.grant.actions_today + 1,
  );
  report.interruptedTransactionHash = recovered.hash;
  report.historyAfterAction = history.length;
  await send(
    "safeguard-revoke",
    owner.secret_key,
    manifest.contractId,
    call("revoke_plot_agent", {}),
    "success",
  );
  assert.equal(await reader.plotAgentStatus(ownerId), null);
  assert(
    (await reader.plotAgentHistory(ownerId)).some(
      (action) => action.public_key === key.publicKey,
    ),
  );
  const shortExpiry = (await reader.chainTimeSeconds()) + 5;
  await send(
    "safeguard-short-grant",
    owner.secret_key,
    manifest.contractId,
    call(
      "authorize_plot_agent",
      {
        public_key: key.publicKey,
        plot_ids: [plotId],
        expires_at: shortExpiry,
        daily_coin_limit: "0",
        daily_action_limit: 5,
        allow_design_changes: true,
      },
      BigInt(quote),
    ),
    "success",
  );
  for (
    let attempt = 0;
    (await reader.chainTimeSeconds()) < shortExpiry;
    attempt++
  ) {
    if (attempt > 20) throw new Error("Short grant did not reach expiry");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const current = await reader.plot(plotId);
  assert(current && "design_choice" in current.plot);
  const expired = await send(
    "safeguard-expired",
    key.secretKey,
    manifest.contractId,
    call("agent_choose_design", {
      plot_id: plotId,
      choice: current.plot.design_choice,
      expected_layout_revision: current.plot.building.layout_revision,
    }),
    "failure",
  );
  assert.match(expired.failure ?? "", /expired/i);
  await send(
    "safeguard-revoke-expired",
    owner.secret_key,
    manifest.contractId,
    call("revoke_plot_agent", {}),
    "success",
  );
  await send(
    "safeguard-delete-key",
    owner.secret_key,
    ownerId,
    [actionCreators.deleteKey(PublicKey.fromString(key.publicKey))],
    "success",
  );
  report.keysRevoked = true;
  report.completedAt = new Date().toISOString();
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await verify();
}

async function cleanup() {
  const owner = ownerCredential();
  const key = agentKey();
  if (await reader.plotAgentStatus(ownerId)) {
    const revoked = await submit(
      "safeguard-cleanup-revoke",
      owner.secret_key,
      manifest.contractId,
      [actionCreators.functionCall("revoke_plot_agent", {}, gas, 0n)],
    );
    assert.equal(revoked.outcome, "success", revoked.failure ?? undefined);
  }
  const keys = await reader.accessKeyList(ownerId);
  if (keys.keys.some((entry) => entry.public_key === key.publicKey)) {
    const deleted = await submit(
      "safeguard-cleanup-delete",
      owner.secret_key,
      ownerId,
      [actionCreators.deleteKey(PublicKey.fromString(key.publicKey))],
    );
    assert.equal(deleted.outcome, "success", deleted.failure ?? undefined);
  }
  assert.equal(await reader.plotAgentStatus(ownerId), null);
  assert(
    !(await reader.accessKeyList(ownerId)).keys.some(
      (entry) => entry.public_key === key.publicKey,
    ),
  );
  console.log(
    JSON.stringify({ plotGrantRevoked: true, agentKeyDeleted: true }),
  );
}

if (process.argv[2] === "--apply")
  apply().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
else if (process.argv[2] === "--verify")
  verify().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
else if (process.argv[2] === "--cleanup")
  cleanup().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
else throw new Error("Use --apply, --verify or --cleanup");
