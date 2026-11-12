import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseDecode } from "@near-js/utils";
import { validateCitySeed } from "@estate/shared";
import { verifyVariableCityBackup } from "./variable-city-backup.mjs";
import { validateVariableCityPreflight } from "./variable-city-preflight.mjs";

const root = resolve(import.meta.dirname, "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (left, right) =>
  assert.deepEqual(left, right, "release report differs from current inputs");

export function verifyReleasePacket({
  report,
  inventory,
  source,
  target,
  moves,
  releaseEvidence,
  backupEvidence,
  bytes,
  wasmBytes,
  liveEvidence = null,
}) {
  assert.equal(report.inventorySha256, hash(bytes.inventory));
  assert.equal(report.sourceSeedSha256, hash(bytes.source));
  assert.equal(report.targetSeedSha256, hash(bytes.target));
  assert.equal(report.movePlanSha256, hash(bytes.moves));
  assert.equal(report.contractId, inventory.contractId);
  assert.equal(report.finalBlock.hash, inventory.finalBlock.hash);
  assert.equal(report.finalBlock.height, inventory.finalBlock.height);
  assert.equal(
    report.releaseEvidenceSha256,
    bytes.releaseEvidence ? hash(bytes.releaseEvidence) : null,
  );
  equal(report.backupEvidence, backupEvidence);

  const result = validateVariableCityPreflight(
    validateCitySeed(source),
    validateCitySeed(target),
    inventory,
    moves,
    releaseEvidence ? { ...releaseEvidence, backup: backupEvidence } : null,
  );
  for (const field of [
    "sourcePlots",
    "targetPlots",
    "targetCurbSpaces",
    "civicSites",
    "moves",
    "mediaCarryover",
    "paused",
    "migrationReady",
    "remainingGates",
  ])
    equal(report[field], result[field]);

  if (result.migrationReady) {
    assert.ok(releaseEvidence, "ready packet lacks release evidence");
    assert.ok(backupEvidence, "ready packet lacks a verified backup");
    assert.ok(wasmBytes, "ready packet lacks the release WASM");
    assert.ok(
      liveEvidence,
      "ready packet requires a finalized live-state read",
    );
    assert.ok(wasmBytes.subarray(0, 4).equals(Buffer.from("\0asm")));
    assert.equal(hash(wasmBytes), releaseEvidence.releaseWasmSha256);
    assert.equal(
      hash(wasmBytes),
      releaseEvidence.rehearsal.migrationWasmSha256,
    );
  }
  if (liveEvidence) {
    assert.equal(liveEvidence.contractId, inventory.contractId);
    assert.equal(liveEvidence.stateSha256, inventory.stateSha256);
    assert.equal(liveEvidence.codeSha256, inventory.codeSha256);
    assert.equal(liveEvidence.paused, inventory.paused);
    assert.ok(liveEvidence.blockHeight >= inventory.finalBlock.height);
  }
  return result;
}

async function readLiveEvidence(contractId) {
  const rpcUrl =
    process.env.ESTATE_TESTNET_RPC_URL ?? "https://test.rpc.fastnear.com";
  assert.match(rpcUrl, /^https:\/\//);
  const rpc = async (method, params) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "city-packet",
          method,
          params,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 3)
          throw new Error(`RPC ${method} failed: ${response.status}`);
        await new Promise((done) => setTimeout(done, 300 * 2 ** attempt));
        continue;
      }
      assert.equal(
        response.ok,
        true,
        `RPC ${method} failed: ${response.status}`,
      );
      const body = await response.json();
      if (body.error)
        throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
      return body.result;
    }
  };
  const block = await rpc("block", { finality: "final" });
  const blockHash = block.header.hash;
  assert.ok(Number.isSafeInteger(block.header.height));
  const query = async (requestType, rest = {}) => {
    const result = await rpc("query", {
      request_type: requestType,
      block_id: blockHash,
      account_id: contractId,
      ...rest,
    });
    assert.equal(result.block_hash, blockHash);
    return result;
  };
  const [account, state, pausedCall] = await Promise.all([
    query("view_account"),
    query("view_state", { prefix_base64: "" }),
    query("call_function", {
      method_name: "is_paused",
      args_base64: Buffer.from("{}").toString("base64"),
    }),
  ]);
  const entries = state.values
    .map((item) => [
      Buffer.from(item.key, "base64"),
      Buffer.from(item.value, "base64"),
    ])
    .sort((left, right) => Buffer.compare(left[0], right[0]));
  assert.ok(entries.length > 0, "Live contract state is empty");
  const digest = createHash("sha256");
  for (const [key, value] of entries) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(key.length));
    digest.update(length);
    digest.update(key);
    length.writeBigUInt64LE(BigInt(value.length));
    digest.update(length);
    digest.update(value);
  }
  const codeSha256 = Buffer.from(baseDecode(account.code_hash)).toString("hex");
  assert.match(codeSha256, /^[a-f0-9]{64}$/);
  const paused = JSON.parse(Buffer.from(pausedCall.result).toString("utf8"));
  assert.equal(typeof paused, "boolean");
  return {
    contractId,
    blockHeight: block.header.height,
    stateSha256: digest.digest("hex"),
    codeSha256,
    paused,
  };
}

async function run() {
  const live = process.argv.includes("--live");
  const [reportPath, backupDir, wasmPath] = process.argv
    .slice(2)
    .filter((arg) => arg !== "--live");
  if (!reportPath?.startsWith("deployments/"))
    throw new Error(
      "Usage: npm run city:migration:packet -- deployments/<preflight>.json [backup-dir release-wasm]",
    );
  if (Boolean(backupDir) !== Boolean(wasmPath))
    throw new Error("Pass both backup directory and release WASM, or neither");
  const reportBytes = await readFile(resolve(root, reportPath));
  const report = JSON.parse(reportBytes);
  assert.ok(report.inventoryFile?.startsWith("deployments/"));
  if (report.releaseEvidenceFile)
    assert.ok(report.releaseEvidenceFile.startsWith("deployments/"));
  const paths = {
    inventory: report.inventoryFile,
    source: "contracts/estate/seed.json",
    target: "contracts/estate/seed-v2.json",
    moves: "contracts/estate/migration-v1-to-v2-draft.json",
    releaseEvidence: report.releaseEvidenceFile,
  };
  const bytes = {};
  for (const [name, path] of Object.entries(paths))
    bytes[name] = path ? await readFile(resolve(root, path)) : null;
  const inventory = JSON.parse(bytes.inventory);
  const releaseEvidence = bytes.releaseEvidence
    ? JSON.parse(bytes.releaseEvidence)
    : null;
  const backupEvidence = backupDir
    ? await verifyVariableCityBackup(
        backupDir,
        inventory,
        JSON.parse(bytes.moves).moves,
      )
    : null;
  const liveEvidence = live
    ? await readLiveEvidence(inventory.contractId)
    : null;
  const result = verifyReleasePacket({
    report,
    inventory,
    source: JSON.parse(bytes.source),
    target: JSON.parse(bytes.target),
    moves: JSON.parse(bytes.moves),
    releaseEvidence,
    backupEvidence,
    bytes,
    wasmBytes: wasmPath ? await readFile(resolve(root, wasmPath)) : null,
    liveEvidence,
  });
  console.log(
    JSON.stringify(
      {
        contractId: report.contractId,
        reportSha256: hash(reportBytes),
        inventoryBlock: report.finalBlock.height,
        paused: result.paused,
        migrationReady: result.migrationReady,
        remainingGates: result.remainingGates,
        releaseWasmSha256: releaseEvidence?.releaseWasmSha256 ?? null,
        live: liveEvidence,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await run();
