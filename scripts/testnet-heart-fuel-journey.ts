import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { KeyPair } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
} from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import { z } from "zod";
import { ChainReader } from "../apps/web/src/chain-reader.js";

if (process.argv.slice(2).join(" ") !== "--apply")
  throw new Error("Pass --apply for the signed testnet heart and fuel journey");
const root = resolve(import.meta.dirname, "..");
const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
) as {
  contractId: string;
  wasmSha256: string;
};
const reader = new ChainReader(deployment.contractId);
const gas = 80n * 10n ** 12n;
const privateDir = `${process.env.HOME}/.config/near-estate/testnet-2026-11-10`;
const reportPath = resolve(
  root,
  "deployments/testnet-heart-fuel-journey-2026-11-14.json",
);
type Credential = {
  account_id: string;
  public_key: string;
  secret_key: `ed25519:${string}`;
};
function credential(envName: string): Credential {
  const path = process.env[envName];
  if (
    !path?.startsWith("/") ||
    realpathSync(path).startsWith(`${root}/`) ||
    statSync(path).mode & 0o077
  )
    throw new Error(
      `${envName} must point to a protected file outside the repository`,
    );
  const value = JSON.parse(readFileSync(path, "utf8")) as Credential;
  assert.equal(
    KeyPair.fromString(value.secret_key).getPublicKey().toString(),
    value.public_key,
  );
  assert.equal(dirname(realpathSync(path)), privateDir);
  return value;
}
const admin = credential("ESTATE_DEPLOY_KEY_FILE");
const driver = credential("ESTATE_DRIVER_KEY_FILE");
assert.equal(admin.account_id, deployment.contractId);

type Signed = { hash: string; bytes: string };
const transactions: Array<{ label: string; hash: string }> = [];
async function call(
  signer: Credential,
  label: string,
  method: string,
  args: object,
): Promise<string> {
  const journal = resolve(privateDir, `heart-fuel-${label}.pending.json`);
  let signed: Signed;
  if (existsSync(journal))
    signed = JSON.parse(readFileSync(journal, "utf8")) as Signed;
  else {
    const pair = KeyPair.fromString(signer.secret_key);
    const access = await reader.accessKey(signer.account_id, signer.public_key);
    const tx = createTransaction(
      signer.account_id,
      pair.getPublicKey(),
      deployment.contractId,
      access.nonce + 1n,
      [actionCreators.functionCall(method, args, gas, 0n)],
      baseDecode(access.blockHash),
    );
    const [hashBytes, encoded] = await KeyPairSigner.fromSecretKey(
      signer.secret_key,
    ).signTransaction(tx);
    signed = {
      hash: baseEncode(hashBytes),
      bytes: Buffer.from(encodeTransaction(encoded)).toString("base64"),
    };
    writeFileSync(journal, JSON.stringify(signed), { mode: 0o600, flag: "wx" });
  }
  let outcome: "success" | "failure" | "pending" | "unknown" =
    await reader.transactionStatus(signed.hash, signer.account_id);
  if (outcome === "pending" || outcome === "unknown") {
    try {
      outcome = await reader.sendSignedTransaction(signed.bytes);
    } catch {
      /* Query exact signed hash below. */
    }
  }
  for (
    let attempt = 0;
    outcome === "pending" || outcome === "unknown";
    attempt++
  ) {
    if (attempt === 30)
      throw new Error(
        `${label} remains uncertain; inspect protected journal ${journal}`,
      );
    await new Promise((done) => setTimeout(done, 1_000));
    outcome = await reader.transactionStatus(signed.hash, signer.account_id);
  }
  if (outcome !== "success")
    throw new Error(
      `${label} failed: ${await reader.transactionFailureMessage(signed.hash, signer.account_id)}`,
    );
  unlinkSync(journal);
  transactions.push({ label, hash: signed.hash });
  return signed.hash;
}

async function bonusEvent(hash: string): Promise<{
  owner: string;
  car_id: number;
  session_id: number;
  amount: string;
}> {
  const response = await fetch(
    process.env.ESTATE_TESTNET_RPC_URL ?? "https://test.rpc.fastnear.com",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "heart-bonus-receipt",
        method: "EXPERIMENTAL_tx_status",
        params: [hash, driver.account_id],
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  assert(response.ok);
  const envelope = (await response.json()) as {
    result?: {
      final_execution_status?: string;
      receipts_outcome?: Array<{ outcome?: { logs?: string[] } }>;
    };
  };
  assert.equal(envelope.result?.final_execution_status, "FINAL");
  const records = (envelope.result.receipts_outcome ?? [])
    .flatMap((entry) => entry.outcome?.logs ?? [])
    .filter((log) => log.startsWith("EVENT_JSON:"))
    .map(
      (log) =>
        JSON.parse(log.slice("EVENT_JSON:".length)) as {
          event?: string;
          data?: Array<{
            owner: string;
            car_id: number;
            session_id: number;
            amount: string;
          }>;
        },
    )
    .filter((event) => event.event === "visit_bonus_paid")
    .flatMap((event) => event.data ?? []);
  assert.equal(records.length, 1);
  return records[0]!;
}

const configSchema = z.record(z.string(), z.unknown());
const policySchema = z.object({
  max_hearts_per_car: z.number(),
  claims_per_day: z.number(),
  bonuses_per_day: z.number(),
  bonus_coins: z.string(),
  min_park_seconds: z.number(),
  nearby_plots: z.number(),
});
const initialConfig = await reader.view("get_config", {}, configSchema);
const initialPolicy = await reader.view("get_heart_policy", {}, policySchema);
assert.equal(initialConfig.park_durability_cost, 2);
assert.equal(initialConfig.repair_cost_per_point, "1000000");
assert.equal(initialPolicy.min_park_seconds, 600);
const fuelConfig = {
  ...initialConfig,
  version: Number(initialConfig.version) + 1,
  park_durability_cost: 10,
  repair_cost_per_point: "200000",
};
await call(admin, "fuel-config", "update_config", { config: fuelConfig });
const liveConfig = await reader.view("get_config", {}, configSchema);
assert.equal(liveConfig.park_durability_cost, 10);
assert.equal(liveConfig.repair_cost_per_point, "200000");
assert.equal(liveConfig.version, fuelConfig.version);

const acceleratedPolicy = { ...initialPolicy, min_park_seconds: 60 };
let policyAccelerated = false;
let report: Record<string, unknown> | null = null;
try {
  await call(admin, "heart-policy-60s", "set_heart_policy", {
    policy: acceleratedPolicy,
  });
  policyAccelerated = true;
  const before = await reader.player(driver.account_id);
  assert(
    before.account && before.active_session === null && before.cars.length > 0,
  );
  const car = before.cars[0]!;
  assert(car.durability >= 10);
  const plotId = "plot-market-n-9";
  const siteId = "npc-market-burgers";
  const plot = await reader.plot(plotId);
  assert(plot && plot.effective_rule.kind === "Free");
  assert.equal(plot.plot.index, 9);
  assert("frontage_units" in plot.plot);
  const site = await reader.view(
    "get_npc_site",
    { site_id: siteId },
    z
      .object({
        road_id: z.string(),
        side: z.string(),
        frontage_index: z.number(),
        role: z.string(),
      })
      .passthrough(),
  );
  assert.equal(site.road_id, plot.plot.road_id);
  assert.equal(site.side, plot.plot.side);
  assert(
    Math.abs(site.frontage_index - plot.plot.index) <=
      acceleratedPolicy.nearby_plots,
  );
  let slot = -1;
  for (let index = 0; index < plot.plot.frontage_units; index++) {
    const session = await reader.view(
      "get_space_session",
      { plot_id: plotId, slot: index },
      z.object({ expires_at: z.number() }).passthrough().nullable(),
    );
    if (!session || session.expires_at <= (await reader.chainTimeSeconds())) {
      slot = index;
      break;
    }
  }
  assert(slot >= 0, "The test plot has no free space");
  await call(driver, "park", "park", { car_id: car.id, plot_id: plotId, slot });
  const parked = await reader.player(driver.account_id);
  assert(
    parked.active_session?.legal &&
      parked.active_session.location_id === plotId,
  );
  assert.equal(
    parked.cars.find((entry) => entry.id === car.id)?.durability,
    car.durability - 10,
  );
  const sessionId = parked.active_session.id;
  await call(driver, "check-in", "check_in_destination", {
    site_id: siteId,
    expected_session_id: sessionId,
  });
  const claimed = await reader.heartStatus(driver.account_id);
  assert(claimed?.claimed_sites.includes(siteId));
  assert.equal(
    claimed?.car_hearts.find((entry) => entry.car_id === car.id)?.hearts,
    1,
  );
  const earliestCollect = parked.active_session.started_at + 61;
  while ((await reader.chainTimeSeconds()) < earliestCollect)
    await new Promise((done) => setTimeout(done, 5_000));
  const beforeCollect = await reader.player(driver.account_id);
  assert(beforeCollect.account);
  const collectHash = await call(driver, "collect", "collect", {
    expected_session_id: sessionId,
  });
  const afterCollect = await reader.player(driver.account_id);
  assert(afterCollect.account && afterCollect.active_session === null);
  const statusAfter = await reader.heartStatus(driver.account_id);
  assert.equal(
    statusAfter?.car_hearts.find((entry) => entry.car_id === car.id)?.hearts,
    0,
  );
  assert.equal(statusAfter?.bonuses_remaining, claimed!.bonuses_remaining - 1);
  const collectionGain =
    BigInt(afterCollect.account.balance) -
    BigInt(beforeCollect.account.balance);
  assert(collectionGain >= BigInt(initialPolicy.bonus_coins));
  const paidEvent = await bonusEvent(collectHash);
  assert.deepEqual(paidEvent, {
    owner: driver.account_id,
    car_id: car.id,
    session_id: sessionId,
    amount: initialPolicy.bonus_coins,
  });
  const points = 10;
  const balanceBeforeFuel = BigInt(afterCollect.account.balance);
  await call(driver, "refill", "repair", { car_id: car.id, points });
  const afterFuel = await reader.player(driver.account_id);
  assert(afterFuel.account);
  assert.equal(
    afterFuel.cars.find((entry) => entry.id === car.id)?.durability,
    car.durability,
  );
  assert.equal(
    balanceBeforeFuel - BigInt(afterFuel.account.balance),
    2_000_000n,
  );
  report = {
    contractId: deployment.contractId,
    codeSha256: deployment.wasmSha256,
    fuelConfigVersion: fuelConfig.version,
    fuelPerPark: 10,
    refillCostPerPoint: "200000",
    temporaryHeartSeconds: 60,
    restoredHeartSeconds: 600,
    driverId: driver.account_id,
    carId: car.id,
    plotId,
    siteId,
    slot,
    sessionId,
    collectionGain: collectionGain.toString(),
    heartBonus: initialPolicy.bonus_coins,
    bonusEvent: paidEvent,
    refillCost: "2000000",
    collectHash,
  };
} finally {
  if (policyAccelerated) {
    await call(admin, "heart-policy-restore", "set_heart_policy", {
      policy: initialPolicy,
    });
    assert.deepEqual(
      await reader.view("get_heart_policy", {}, policySchema),
      initialPolicy,
    );
  }
}
if (!report) throw new Error("Journey did not complete");
report.transactions = transactions;
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Verified heart and fuel journey: ${reportPath}`);
