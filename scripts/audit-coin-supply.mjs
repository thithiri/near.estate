import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_ARCHIVE = "https://archival-rpc.testnet.fastnear.com";

function amount(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`Invalid ${label} amount`);
  return BigInt(value);
}

function viewResult(result) {
  if (!Array.isArray(result?.result))
    throw new Error("Invalid RPC view result");
  return JSON.parse(Buffer.from(result.result).toString("utf8"));
}

export async function auditCoinSupply(db, rpc, contractId) {
  const cursor = db
    .prepare(
      "SELECT contract_id, start_height, last_height, last_hash FROM indexer_state WHERE id = 1",
    )
    .get();
  if (!cursor || cursor.contract_id !== contractId || !cursor.last_hash)
    throw new Error("Indexer cursor does not identify the requested contract");
  const block = await rpc("block", { block_id: cursor.last_height });
  if (block?.header?.hash !== cursor.last_hash)
    throw new Error("Indexer cursor differs from the archive block hash");
  const beforeStart =
    cursor.start_height > 1
      ? await rpc("query", {
          request_type: "view_code",
          block_id: cursor.start_height - 1,
          account_id: contractId,
        })
      : null;
  const historyCoverage =
    beforeStart?.rpcError?.cause?.name === "UNKNOWN_ACCOUNT"
      ? "starts_before_contract"
      : "not_proven_by_this_audit";

  const rows = db
    .prepare(
      `SELECT receipt_id, block_height, event_name, payload_json
       FROM chain_events
       ORDER BY block_height, receipt_id, log_index, data_index`,
    )
    .all();
  const configBlocks = new Set(
    rows
      .filter((row) => row.event_name === "config_updated")
      .map((row) => row.block_height),
  );
  const registrations = new Map();
  const mintedCarIds = new Set();
  for (const row of rows) {
    if (row.event_name !== "player_registered") continue;
    const payload = JSON.parse(row.payload_json);
    if (registrations.has(payload.account_id))
      throw new Error("Duplicate player registration event");
    registrations.set(payload.account_id, {
      carId: payload.starter_car_id,
      receiptId: row.receipt_id,
    });
  }
  const configCache = new Map();
  async function configAt(height) {
    if (configBlocks.has(height))
      throw new Error(`Config changed in amount-backfill block ${height}`);
    if (!configCache.has(height))
      configCache.set(
        height,
        viewResult(
          await rpc("query", {
            request_type: "call_function",
            block_id: height,
            account_id: contractId,
            method_name: "get_config",
            args_base64: "e30=",
          }),
        ),
      );
    return configCache.get(height);
  }

  let grants = 0n;
  let settlementPayouts = 0n;
  let heartBonuses = 0n;
  let spending = 0n;
  let forfeited = 0n;
  let backfilledAmounts = 0;
  let settlements = 0;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json);
    const name = row.event_name;
    if (name === "player_registered") {
      const grant =
        payload.grant === undefined
          ? (await configAt(row.block_height)).starter_coins
          : payload.grant;
      grants += amount(grant, "starter grant");
      if (payload.grant === undefined) backfilledAmounts++;
    } else if (name === "car_minted") {
      if (mintedCarIds.has(payload.car_id))
        throw new Error("Duplicate car mint event");
      mintedCarIds.add(payload.car_id);
      if (!registrations.has(payload.owner))
        throw new Error(`Car owner ${payload.owner} has no registration event`);
      let cost = payload.cost;
      if (cost === undefined) {
        const starter = registrations.get(payload.owner);
        cost =
          starter.carId === payload.car_id &&
          starter.receiptId === row.receipt_id
            ? "0"
            : (await configAt(row.block_height)).buy_car_cost;
        backfilledAmounts++;
      }
      spending += amount(cost, "car purchase");
    } else if (name === "cosmetic_bought") {
      const cost =
        payload.cost === undefined
          ? (await configAt(row.block_height)).burger_decal_cost
          : payload.cost;
      spending += amount(cost, "cosmetic purchase");
      if (payload.cost === undefined) backfilledAmounts++;
    } else if (
      name === "car_repaired" ||
      name === "car_upgraded" ||
      name === "building_updated"
    ) {
      if (payload.cost !== undefined) spending += amount(payload.cost, name);
      else if (
        name === "car_upgraded" ||
        (name === "car_repaired" && !payload.emergency) ||
        (name === "building_updated" &&
          ["type", "level"].includes(payload.change))
      )
        throw new Error(`Missing cost in ${name} event`);
    } else if (["collected", "expired", "ticketed"].includes(name)) {
      const gross = amount(payload.gross, "gross settlement");
      const driver = amount(payload.driver_payout, "driver payout");
      const recipient = amount(payload.recipient_payout, "recipient payout");
      const lost = amount(payload.forfeited, "forfeiture");
      if (gross !== driver + recipient + lost)
        throw new Error("Settlement payout does not conserve gross");
      settlementPayouts += driver + recipient;
      forfeited += lost;
      settlements++;
    } else if (name === "visit_bonus_paid") {
      heartBonuses += amount(payload.amount, "visit heart bonus");
    }
  }

  const balances = [];
  let observedCars = 0;
  for (let carId = 1; carId <= 10_000; carId++) {
    const car = viewResult(
      await rpc("query", {
        request_type: "call_function",
        block_id: cursor.last_height,
        account_id: contractId,
        method_name: "get_car",
        args_base64: Buffer.from(JSON.stringify({ car_id: carId })).toString(
          "base64",
        ),
      }),
    );
    if (car === null) break;
    if (car.id !== carId || !registrations.has(car.owner))
      throw new Error("On-chain car has no matching registered owner");
    observedCars++;
    if (carId === 10_000) throw new Error("Car scan limit reached");
  }
  if (observedCars !== mintedCarIds.size)
    throw new Error("Car mint events do not cover on-chain cars");
  for (const accountId of [...registrations.keys()].sort()) {
    const account = viewResult(
      await rpc("query", {
        request_type: "call_function",
        block_id: cursor.last_height,
        account_id: contractId,
        method_name: "get_account",
        args_base64: Buffer.from(
          JSON.stringify({ account_id: accountId }),
        ).toString("base64"),
      }),
    );
    if (!account) throw new Error(`Registered account ${accountId} is missing`);
    balances.push(amount(account.balance, "account balance"));
  }
  const treasury = amount(
    viewResult(
      await rpc("query", {
        request_type: "call_function",
        block_id: cursor.last_height,
        account_id: contractId,
        method_name: "get_treasury_coins",
        args_base64: "e30=",
      }),
    ),
    "treasury balance",
  );
  const expectedOutstanding =
    grants + settlementPayouts + heartBonuses - spending;
  const observedOutstanding =
    balances.reduce((sum, balance) => sum + balance, 0n) + treasury;
  return {
    contractId,
    indexedFromHeight: cursor.start_height,
    reconciledHeight: cursor.last_height,
    reconciledBlockHash: cursor.last_hash,
    registeredAccounts: registrations.size,
    observedCars,
    settlements,
    archivedAmountBackfills: backfilledAmounts,
    grants: grants.toString(),
    settlementPayouts: settlementPayouts.toString(),
    heartBonuses: heartBonuses.toString(),
    spending: spending.toString(),
    forfeited: forfeited.toString(),
    expectedOutstanding: expectedOutstanding.toString(),
    observedOutstanding: observedOutstanding.toString(),
    balancesMatch: expectedOutstanding === observedOutstanding,
    historyCoverage,
    currentSupplyVerified:
      historyCoverage === "starts_before_contract" &&
      expectedOutstanding === observedOutstanding,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1)
    throw new Error(
      "Usage: node scripts/audit-coin-supply.mjs /path/to/estate.sqlite",
    );
  const deployment = JSON.parse(
    readFileSync(
      new URL("../deployments/testnet.json", import.meta.url),
      "utf8",
    ),
  );
  const archive = process.env.NEAR_TESTNET_ARCHIVAL_RPC ?? DEFAULT_ARCHIVE;
  const rpc = async (method, params) => {
    const response = await fetch(archive, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "coin-audit",
        method,
        params,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Archive RPC returned HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) return { rpcError: body.error };
    return body.result;
  };
  const db = new DatabaseSync(resolve(args[0]), { readOnly: true });
  try {
    process.stdout.write(
      `${JSON.stringify(await auditCoinSupply(db, rpc, deployment.contractId), null, 2)}\n`,
    );
  } finally {
    db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
