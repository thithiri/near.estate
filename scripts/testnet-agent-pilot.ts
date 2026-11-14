import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
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
  PARKING_AGENT_METHODS,
  PARKING_AGENT_KEY_ALLOWANCE,
  PLOT_AGENT_METHODS,
  PLOT_AGENT_KEY_ALLOWANCE,
} from "../apps/web/src/wallet-client.js";

const mode = process.argv[2];
if (mode !== "--apply" && mode !== "--cleanup")
  throw new Error("Use --apply or --cleanup");
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "deployments/testnet.json"), "utf8"),
);
assert.equal(manifest.network, "testnet");
const ownerId = "dev-20261110121829-19069405494728.testnet";
const driverId = "dev-20261110121826-61851458515092.testnet";
const plotId = "plot-main-n-1";
const reader = new ChainReader(manifest.contractId);
const directory = process.env.ESTATE_AGENT_PILOT_DIR;
if (
  !directory ||
  !directory.startsWith("/") ||
  directory.startsWith(`${root}/`)
)
  throw new Error(
    "Set ESTATE_AGENT_PILOT_DIR to a private absolute directory outside the repository",
  );
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (!lstatSync(directory).isDirectory() || lstatSync(directory).mode & 0o077)
  throw new Error("Pilot directory must be 0700");

function protectedJson(path: string) {
  const real = realpathSync(path);
  const stat = lstatSync(path);
  if (
    real.startsWith(`${root}/`) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077
  )
    throw new Error(
      "Credential must be a private regular file outside the repository",
    );
  return JSON.parse(readFileSync(path, "utf8"));
}

function fullCredential(envName: string, accountId: string) {
  const path = process.env[envName];
  if (!path || !path.startsWith("/"))
    throw new Error(`Set ${envName} to a protected credential path`);
  const record = protectedJson(path);
  assert.equal(record.account_id, accountId);
  assert.equal(
    KeyPair.fromString(record.secret_key).getPublicKey().toString(),
    record.public_key,
  );
  return record as {
    account_id: string;
    public_key: string;
    secret_key: `ed25519:${string}`;
  };
}
const owner = fullCredential("ESTATE_OWNER_KEY_FILE", ownerId);
const driver = fullCredential("ESTATE_DRIVER_KEY_FILE", driverId);
const roles = [
  {
    name: "driver-parking",
    owner: driver,
    methods: PARKING_AGENT_METHODS,
    allowance: PARKING_AGENT_KEY_ALLOWANCE,
  },
  {
    name: "owner-parking",
    owner,
    methods: PARKING_AGENT_METHODS,
    allowance: PARKING_AGENT_KEY_ALLOWANCE,
  },
  {
    name: "owner-plot",
    owner,
    methods: PLOT_AGENT_METHODS,
    allowance: PLOT_AGENT_KEY_ALLOWANCE,
  },
] as const;
type Role = (typeof roles)[number];
type AgentKey = {
  accountId: string;
  role: string;
  publicKey: string;
  secretKey: `ed25519:${string}`;
};
const reportPath = join(
  root,
  "deployments",
  "testnet-agent-pilot-2026-11-14.json",
);
const report: Record<string, unknown> = existsSync(reportPath)
  ? JSON.parse(readFileSync(reportPath, "utf8"))
  : {
      network: "testnet",
      contractId: manifest.contractId,
      codeSha256: manifest.wasmSha256,
      agents: [],
      transactions: [],
    };
function saveReport() {
  const temporary = `${reportPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, reportPath);
}
function record(label: string, hash: string) {
  const transactions = report.transactions as Array<{
    label: string;
    hash: string;
  }>;
  if (!transactions.some((entry) => entry.hash === hash))
    transactions.push({ label, hash });
  saveReport();
}

function agentKey(role: Role, create: boolean): AgentKey {
  const path = join(directory, `${role.name}.key.json`);
  if (!existsSync(path)) {
    if (!create) throw new Error(`Missing protected ${role.name} key`);
    const pair = KeyPair.fromRandom("ed25519");
    writeFileSync(
      path,
      JSON.stringify({
        accountId: role.owner.account_id,
        role: role.name === "owner-plot" ? "plot" : "parking",
        publicKey: pair.getPublicKey().toString(),
        secretKey: pair.toString(),
      }),
      { mode: 0o600, flag: "wx" },
    );
  }
  const value = protectedJson(path) as AgentKey;
  assert.equal(value.accountId, role.owner.account_id);
  assert.equal(value.role, role.name === "owner-plot" ? "plot" : "parking");
  assert.equal(
    KeyPair.fromString(value.secretKey).getPublicKey().toString(),
    value.publicKey,
  );
  return value;
}

async function send(
  label: string,
  accountId: string,
  secret: `ed25519:${string}`,
  receiver: string,
  actions: Parameters<typeof createTransaction>[4],
) {
  const journal = join(directory, `${label}.pending.json`);
  let signed: { hash: string; bytes: string };
  if (existsSync(journal)) {
    signed = protectedJson(journal);
  } else {
    const pair = KeyPair.fromString(secret);
    const access = await reader.accessKey(
      accountId,
      pair.getPublicKey().toString(),
    );
    const tx = createTransaction(
      accountId,
      pair.getPublicKey(),
      receiver,
      access.nonce + 1n,
      actions,
      baseDecode(access.blockHash),
    );
    const [hashBytes, transaction] =
      await KeyPairSigner.fromSecretKey(secret).signTransaction(tx);
    signed = {
      hash: baseEncode(hashBytes),
      bytes: Buffer.from(encodeTransaction(transaction)).toString("base64"),
    };
    writeFileSync(journal, JSON.stringify(signed), { mode: 0o600, flag: "wx" });
  }
  let outcome = await reader.transactionStatus(signed.hash, accountId);
  if (outcome === "unknown" || outcome === "pending") {
    try {
      outcome = await reader.sendSignedTransaction(signed.bytes);
    } catch {
      /* query the exact signed hash */
    }
  }
  for (
    let attempt = 0;
    outcome === "unknown" || outcome === "pending";
    attempt++
  ) {
    if (attempt >= 12)
      throw new Error(
        `${label} ${signed.hash} is unresolved; retry this pilot`,
      );
    await new Promise((done) => setTimeout(done, 1_000));
    outcome = await reader.transactionStatus(signed.hash, accountId);
  }
  if (outcome !== "success")
    throw new Error(
      `${label} ${signed.hash} failed; inspect the chain before retry`,
    );
  record(label, signed.hash);
  unlinkSync(journal);
  return signed.hash;
}

async function hasKey(role: Role, key: AgentKey) {
  const listed = await reader.accessKeyList(role.owner.account_id);
  const entry = listed.keys.find((item) => item.public_key === key.publicKey);
  if (!entry) return false;
  const permission = entry.access_key.permission;
  if (permission === "FullAccess" || !permission?.FunctionCall)
    throw new Error(`${role.name} has a broad key`);
  const call = permission.FunctionCall;
  if (
    call.receiver_id !== reader.contractId ||
    call.method_names.length !== role.methods.length ||
    !role.methods.every((method) => call.method_names.includes(method)) ||
    !call.allowance ||
    BigInt(call.allowance) <= 0n ||
    BigInt(call.allowance) > role.allowance
  )
    throw new Error(`${role.name} has unexpected key permissions`);
  return true;
}

function runAgent(label: string, script: string, args: string[]) {
  const child = spawnSync(
    process.execPath,
    [join(root, "scripts", script), "--execute", ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 1_000_000,
    },
  );
  if (child.status !== 0)
    throw new Error(`${label}: ${child.stderr.trim() || child.stdout.trim()}`);
  const lines = child.stdout
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const result = lines.find((line) => line.hash && line.state);
  if (!result || result.state !== "success")
    throw new Error(`${label} did not finalize: ${child.stdout}`);
  record(label, result.hash);
  return { hash: result.hash, plan: lines.find((line) => line.plan)?.plan };
}

async function cleanup() {
  const grant = await reader.plotAgentStatus(ownerId);
  if (grant)
    await send(
      "revoke-plot-grant",
      ownerId,
      owner.secret_key,
      reader.contractId,
      [
        actionCreators.functionCall(
          "revoke_plot_agent",
          {},
          60n * 10n ** 12n,
          0n,
        ),
      ],
    );
  for (const role of roles) {
    const key = agentKey(role, false);
    if (await hasKey(role, key))
      await send(
        `delete-${role.name}-key`,
        role.owner.account_id,
        role.owner.secret_key,
        role.owner.account_id,
        [actionCreators.deleteKey(PublicKey.fromString(key.publicKey))],
      );
    assert.equal(await hasKey(role, key), false);
  }
  assert.equal(await reader.plotAgentStatus(ownerId), null);
  report.keysRevoked = true;
  report.completedAt = new Date().toISOString();
  saveReport();
}

async function main() {
  if (mode === "--cleanup") {
    await cleanup();
    return;
  }
  const ownerBefore = await reader.plot(plotId);
  assert.equal(ownerBefore?.plot.owner, ownerId);
  assert(ownerBefore && "design_choice" in ownerBefore.plot);
  assert.equal(ownerBefore.plot.building.approved_manifest_hash, null);
  assert.equal(ownerBefore.plot.logo.active, null);
  assert.equal(ownerBefore.plot.billboard.active, null);
  const drivers = await Promise.all([
    reader.player(driverId),
    reader.player(ownerId),
  ]);
  for (const player of drivers) {
    assert(
      player.account && player.cars.length === 1 && !player.active_session,
    );
    assert(player.cars[0].durability > 0);
  }
  report.before = {
    driver: {
      balance: drivers[0].account?.balance,
      durability: drivers[0].cars[0].durability,
    },
    owner: {
      balance: drivers[1].account?.balance,
      durability: drivers[1].cars[0].durability,
    },
    plot: { id: plotId, designChoice: ownerBefore.plot.design_choice },
  };
  const keys = roles.map((role) => agentKey(role, true));
  report.agents = roles.map((role, index) => ({
    role: role.name,
    accountId: role.owner.account_id,
    publicKey: keys[index].publicKey,
    methods: role.methods,
    gasAllowanceYocto: role.allowance.toString(),
  }));
  saveReport();
  for (let index = 0; index < roles.length; index++) {
    const role = roles[index];
    const key = keys[index];
    if (!(await hasKey(role, key))) {
      await send(
        `add-${role.name}-key`,
        role.owner.account_id,
        role.owner.secret_key,
        role.owner.account_id,
        [
          actionCreators.addKey(
            PublicKey.fromString(key.publicKey),
            actionCreators.functionCallAccessKey(
              reader.contractId,
              [...role.methods],
              role.allowance,
            ),
          ),
        ],
      );
    }
    assert(await hasKey(role, key));
  }
  if (!(await reader.plotAgentStatus(ownerId))) {
    const [quote, now] = await Promise.all([
      reader.plotAgentStorageQuote(),
      reader.chainTimeSeconds(),
    ]);
    await send(
      "authorize-plot-agent",
      ownerId,
      owner.secret_key,
      reader.contractId,
      [
        actionCreators.functionCall(
          "authorize_plot_agent",
          {
            public_key: keys[2].publicKey,
            plot_ids: [plotId],
            expires_at: now + 7 * 86_400,
            daily_coin_limit: "0",
            daily_action_limit: 5,
            allow_design_changes: true,
          },
          60n * 10n ** 12n,
          BigInt(quote),
        ),
      ],
    );
  }
  assert.equal(
    (await reader.plotAgentStatus(ownerId))?.grant.public_key,
    keys[2].publicKey,
  );
  const driverPark = runAgent("driver-agent-park", "agent-play.mjs", [
    "--account",
    driverId,
    "--car-id",
    "1",
    "--key-file",
    join(directory, "driver-parking.key.json"),
  ]);
  const ownerPark = runAgent("owner-car-agent-park", "agent-play.mjs", [
    "--account",
    ownerId,
    "--car-id",
    "3",
    "--key-file",
    join(directory, "owner-parking.key.json"),
  ]);
  report.parkingPlans = [driverPark.plan, ownerPark.plan];
  const targetChoice = ownerBefore.plot.design_choice === 4 ? 3 : 4;
  const design = runAgent(
    "owner-building-agent-design",
    "plot-agent-play.mjs",
    [
      "--account",
      ownerId,
      "--key-file",
      join(directory, "owner-plot.key.json"),
      "--plot-id",
      plotId,
      "--choose-design",
      String(targetChoice),
    ],
  );
  report.buildingPlan = design.plan;
  saveReport();
  await new Promise((done) => setTimeout(done, 35_000));
  for (const [index, role] of roles.slice(0, 2).entries()) {
    const player = await reader.player(role.owner.account_id);
    assert(player.active_session);
    await send(
      `${role.name}-collect`,
      role.owner.account_id,
      keys[index].secretKey,
      reader.contractId,
      [
        actionCreators.functionCall(
          "collect",
          { expected_session_id: player.active_session.id },
          30n * 10n ** 12n,
          0n,
        ),
      ],
    );
  }
  const [driverAfter, ownerAfter, plotAfter, grantAfter] = await Promise.all([
    reader.player(driverId),
    reader.player(ownerId),
    reader.plot(plotId),
    reader.plotAgentStatus(ownerId),
  ]);
  assert(plotAfter && "design_choice" in plotAfter.plot);
  assert.equal(driverAfter.active_session, null);
  assert.equal(ownerAfter.active_session, null);
  assert.equal(plotAfter?.plot.design_choice, targetChoice);
  assert(
    BigInt(driverAfter.account!.balance) > BigInt(drivers[0].account!.balance),
  );
  assert(
    BigInt(ownerAfter.account!.balance) > BigInt(drivers[1].account!.balance),
  );
  report.after = {
    driver: {
      balance: driverAfter.account?.balance,
      durability: driverAfter.cars[0].durability,
      activeSession: driverAfter.active_session,
    },
    owner: {
      balance: ownerAfter.account?.balance,
      durability: ownerAfter.cars[0].durability,
      activeSession: ownerAfter.active_session,
    },
    plot: { id: plotId, designChoice: plotAfter?.plot.design_choice },
    grantActionsRemainingToday: grantAfter?.actions_remaining_today,
  };
  saveReport();
  await cleanup();
  console.log(
    JSON.stringify({
      report: reportPath,
      transactions: (report.transactions as unknown[]).length,
      keysRevoked: report.keysRevoked,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    "Protected agent keys and any pending transaction journals remain for --cleanup or recovery.",
  );
  process.exitCode = 1;
});
