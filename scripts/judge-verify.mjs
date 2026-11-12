#!/usr/bin/env node
// Read-only verification of the public near.estate testnet claims.
// Needs Node 22 and network access to NEAR testnet RPC. Uses no keys and sends no transactions.
//
//   npm run judge:verify            human-readable report
//   npm run judge:verify -- --json  machine-readable report on stdout
//
// Exit code 0 means every check matched; 1 means at least one mismatch.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const asJson = process.argv.includes("--json");
const RPC = process.env.NEAR_TESTNET_RPC ?? "https://test.rpc.fastnear.com";
// Transactions older than a few epochs need an archival node; try each in turn.
const ARCHIVAL_RPCS = (
  process.env.NEAR_TESTNET_ARCHIVAL_RPC ??
  "https://archival-rpc.testnet.fastnear.com,https://archival-rpc.testnet.near.org"
).split(",");
const EXPLORER = "https://testnet.nearblocks.io/txns/";

// Evidence files whose transactions are re-checked on chain, with the claim each one supports.
export const EVIDENCE = [
  [
    "deployments/variable-city-release-db33845c80179c1a.json",
    "Version-2 city code deployed, state migrated and gameplay reopened",
  ],
  [
    "deployments/testnet-variable-width-journey.json",
    "Park and collect on 1-, 2- and 3-unit curb plots",
  ],
  [
    "deployments/testnet-variable-ownership-journey.json",
    "Buy plots in the version-2 city",
  ],
  [
    "deployments/testnet-two-account-ticket-v2-journey.json",
    "Owner schedules NoParking, another account parks illegally, owner tickets",
  ],
  [
    "deployments/testnet-variable-expiry-journey.json",
    "Capped session expires, another driver settles it and reuses the space",
  ],
  [
    "deployments/testnet-v2-three-unit-logo-journey.json",
    "Owner proposes a logo on a 3-unit building (moderator approval checked in its record)",
  ],
  [
    "deployments/testnet-contested-curb-journey-post-upgrade.json",
    "Two accounts race for one space: exactly one park succeeds",
  ],
];

const ACCOUNT_RE = /^[a-z0-9._-]+\.testnet$/;
const HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const results = [];
let failures = 0;

function record(group, name, ok, detail) {
  if (!ok) failures += 1;
  results.push({ group, name, ok, ...detail });
  if (!asJson)
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}${detail.note ? ` — ${detail.note}` : ""}${detail.link ? `\n      ${detail.link}` : ""}`,
    );
}

async function rpc(method, params, url = RPC) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "judge", method, params }),
    });
    if (response.status === 429 || response.status >= 500) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    const body = await response.json();
    return body;
  }
  throw new Error(`${method}: RPC kept returning 429/5xx at ${url}`);
}

async function view(contractId, methodName, args = {}) {
  const body = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (body.error || body.result?.error)
    throw new Error(
      `${methodName}: ${JSON.stringify(body.error ?? body.result.error)}`,
    );
  return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
}

function base58ToHex(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  return n.toString(16).padStart(64, "0");
}

function collectTransactions(node, fileAccounts, out = [], parentKey = "") {
  if (Array.isArray(node)) {
    for (const item of node)
      collectTransactions(item, fileAccounts, out, parentKey);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      // Objects with a block height describe blocks, not transactions.
      const isTxKey =
        (key === "hash" && !("height" in node)) ||
        key === "transactionHash" ||
        /TransactionHash$/.test(key);
      if (isTxKey && typeof value === "string" && HASH_RE.test(value)) {
        const own = [node.accountId, node.actor, node.signerId].filter(
          (v) => typeof v === "string" && ACCOUNT_RE.test(v),
        );
        out.push({
          hash: value,
          label:
            node.label ??
            node.method ??
            node.action ??
            (key === "hash" ? parentKey : key),
          expect: node.outcome === "failure" ? "failure" : "success",
          senders: [...new Set([...own, ...fileAccounts])],
        });
      } else if (typeof value === "object") {
        collectTransactions(value, fileAccounts, out, key);
      }
    }
  }
  return out;
}

async function txStatus(hash, senders) {
  for (const url of ARCHIVAL_RPCS) {
    try {
      for (const sender of senders) {
        const body = await rpc(
          "tx",
          { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" },
          url,
        );
        if (body.result) return body.result;
      }
    } catch {
      // Rate-limited or unavailable: fall through to the next archival endpoint.
    }
  }
  return null;
}

const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
);
const { contractId } = deployment;
if (!asJson)
  console.log(`near.estate testnet verification — contract ${contractId}\n`);

// 1. Live code identity.
const account = await rpc("query", {
  request_type: "view_account",
  finality: "final",
  account_id: contractId,
});
const liveHex = base58ToHex(account.result.code_hash);
record(
  "identity",
  "Live contract code matches deployments/testnet.json",
  liveHex === deployment.wasmSha256,
  {
    note: `on-chain sha256 ${liveHex.slice(0, 16)}… at block ${account.result.block_height}`,
  },
);

// 2. City shape from contract views.
const plots = [];
for (let from = 0; ; from += 50) {
  const page = await view(contractId, "get_plots", {
    from_index: from,
    limit: 50,
  });
  plots.push(...page);
  if (page.length < 50) break;
}
const units = plots.map((p) => p.plot?.frontage_units ?? p.frontage_units);
const widthCounts = [1, 2, 3].map((w) => units.filter((u) => u === w).length);
const curbSpaces = units.reduce((a, b) => a + b, 0);
record(
  "city",
  `${plots.length} player plots (expected ${deployment.plotCount})`,
  plots.length === deployment.plotCount,
  {
    note: `1/2/3-unit plots: ${widthCounts.join("/")}; curb spaces ${curbSpaces}`,
  },
);
const sites = await view(contractId, "get_npc_sites", {
  from_index: 0,
  limit: 20,
});
const towers = sites.filter((s) => s.role === "ParkingTower");
record(
  "city",
  `${sites.length} game-owned sites (expected ${deployment.npcSiteCount})`,
  sites.length === deployment.npcSiteCount,
  {
    note: `${towers.length} parking towers, ${towers.reduce((a, t) => a + t.capacity, 0)} tower spaces; ${sites
      .filter((s) => s.role !== "ParkingTower")
      .map((s) => s.name)
      .join(", ")}`,
  },
);
const roles = await view(contractId, "get_roles");
record(
  "city",
  "Separate admin, moderator and inspector accounts",
  new Set(roles).size === 3,
  {
    note: roles.join(" | "),
  },
);
const config = await view(contractId, "get_config");
record(
  "city",
  "Economy config is live (60 coins/h base, 30-min earn cap)",
  config.base_rate_per_hour === "60000000" && config.earn_cap_seconds === 1800,
  {
    note: `config version ${config.version}`,
  },
);

// 3. Recorded evidence transactions.
for (const [file, claim] of EVIDENCE) {
  const data = JSON.parse(readFileSync(resolve(root, file), "utf8"));
  const fileAccounts = Object.entries(data)
    .filter(
      ([k, v]) => /Id$/.test(k) && typeof v === "string" && ACCOUNT_RE.test(v),
    )
    .map(([, v]) => v);
  const txs = collectTransactions(data, [...fileAccounts, contractId]);
  if (!asJson) console.log(`\n${claim}\n  ${file}`);
  for (const tx of txs) {
    const result = await txStatus(tx.hash, tx.senders);
    if (!result) {
      record(file, `${tx.label} ${tx.hash}`, false, {
        note: "transaction not found",
      });
      continue;
    }
    const failed = "Failure" in (result.status ?? {});
    const events = result.receipts_outcome
      .flatMap((o) => o.outcome.logs)
      .filter((l) => l.startsWith("EVENT_JSON:") && l.includes('"near_estate"'))
      .map((l) => JSON.parse(l.slice(11)).event);
    record(
      file,
      `${tx.label} by ${result.transaction.signer_id}`,
      (tx.expect === "failure") === failed,
      {
        note: `${failed ? "failed" : "succeeded"} (expected ${tx.expect})${events.length ? `; events: ${events.join(", ")}` : ""}`,
        link: `${EXPLORER}${tx.hash}`,
        hash: tx.hash,
      },
    );
  }
}

if (asJson)
  console.log(JSON.stringify({ contractId, failures, results }, null, 2));
else
  console.log(
    `\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`,
  );
process.exit(failures === 0 ? 0 : 1);
