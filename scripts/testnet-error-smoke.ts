import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
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
import { ChainReader } from "../apps/web/src/chain-reader.js";

const mode = process.argv[2];
if (mode !== "--plan" && mode !== "--apply")
  throw new Error("Pass --plan or --apply");
const root = resolve(import.meta.dirname, "..");
const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
) as { network: string; contractId: string; wasmSha256: string };
assert.equal(deployment.network, "testnet");
const keyFile = process.env.ESTATE_DRIVER_KEY_FILE;
if (!keyFile || !keyFile.startsWith("/"))
  throw new Error("Set ESTATE_DRIVER_KEY_FILE to a private absolute path");
if (realpathSync(keyFile).startsWith(`${root}/`))
  throw new Error("Driver key must stay outside the repository");
if ((statSync(keyFile).mode & 0o077) !== 0)
  throw new Error("Driver key must be private");
const driver = JSON.parse(readFileSync(keyFile, "utf8")) as {
  account_id: string;
  public_key: string;
  secret_key: `ed25519:${string}`;
};
assert.match(driver.account_id, /^[a-z0-9._-]+\.testnet$/);
assert.equal(
  KeyPair.fromString(driver.secret_key).getPublicKey().toString(),
  driver.public_key,
);
const reader = new ChainReader(deployment.contractId);
type SignedCall = { hash: string; signedBase64: string };
type Journal = {
  contractId: string;
  codeSha256: string;
  accountId: string;
  call: SignedCall | null;
  completed: boolean;
};
const journalPath = resolve(dirname(keyFile), "readable-error-journal.json");
const journal: Journal = existsSync(journalPath)
  ? (JSON.parse(readFileSync(journalPath, "utf8")) as Journal)
  : {
      contractId: deployment.contractId,
      codeSha256: deployment.wasmSha256,
      accountId: driver.account_id,
      call: null,
      completed: false,
    };
assert.equal(journal.contractId, deployment.contractId);
assert.equal(journal.codeSha256, deployment.wasmSha256);
assert.equal(journal.accountId, driver.account_id);

function saveJournal() {
  const temporary = `${journalPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, journalPath);
}

async function signCall(): Promise<SignedCall> {
  const access = await reader.accessKey(driver.account_id, driver.public_key);
  const transaction = createTransaction(
    driver.account_id,
    KeyPair.fromString(driver.secret_key).getPublicKey(),
    deployment.contractId,
    access.nonce + 1n,
    [
      actionCreators.functionCall(
        "settle_expired",
        { expected_session_id: 0 },
        60n * 10n ** 12n,
        0n,
      ),
    ],
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    driver.secret_key,
  ).signTransaction(transaction);
  return {
    hash: baseEncode(hashBytes),
    signedBase64: Buffer.from(encodeTransaction(signed)).toString("base64"),
  };
}

async function finalFailure(hash: string) {
  const response = await fetch(reader.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "near-estate-readable-error",
      method: "tx",
      params: {
        tx_hash: hash,
        sender_account_id: driver.account_id,
        wait_until: "FINAL",
      },
    }),
  });
  assert.equal(response.status, 200);
  const envelope = (await response.json()) as {
    result?: {
      final_execution_status?: string;
      status?: { Failure?: unknown };
      receipts_outcome?: Array<{
        id: string;
        outcome: { executor_id: string; status: { Failure?: unknown } };
      }>;
    };
  };
  assert.equal(envelope.result?.final_execution_status, "FINAL");
  const failureStatus = envelope.result.status?.Failure;
  assert(failureStatus, "Transaction has no final failure");
  const reason = JSON.stringify(failureStatus);
  assert(reason.includes("unknown parking session"), reason);
  const receipt = envelope.result.receipts_outcome?.find(
    (entry) =>
      entry.outcome.executor_id === deployment.contractId &&
      entry.outcome.status.Failure,
  );
  assert(receipt, "Contract failure receipt is missing");
  return { reason, receiptId: receipt.id };
}

async function main() {
  if (mode === "--plan") {
    console.log(
      JSON.stringify({
        contractId: deployment.contractId,
        codeSha256: deployment.wasmSha256,
        accountId: driver.account_id,
        completed: journal.completed,
      }),
    );
    return;
  }
  if (!journal.call) {
    journal.call = await signCall();
    saveJournal();
  }
  let outcome = await reader.transactionStatus(
    journal.call.hash,
    driver.account_id,
  );
  if (outcome === "unknown") {
    try {
      outcome = await reader.sendSignedTransaction(journal.call.signedBase64);
    } catch {
      // Resolve a lost reply using the exact saved transaction hash.
    }
  }
  for (
    let attempt = 0;
    (outcome === "unknown" || outcome === "pending") && attempt < 8;
    attempt++
  ) {
    await new Promise((done) => setTimeout(done, 1_000));
    outcome = await reader.transactionStatus(
      journal.call.hash,
      driver.account_id,
    );
  }
  assert.equal(outcome, "failure", `Probe transaction is ${outcome}`);
  const failure = await finalFailure(journal.call.hash);
  const evidence = {
    network: "testnet",
    contractId: deployment.contractId,
    codeSha256: deployment.wasmSha256,
    accountId: driver.account_id,
    transactionHash: journal.call.hash,
    receiptId: failure.receiptId,
    failureReason: failure.reason,
  };
  writeFileSync(
    resolve(root, "deployments/testnet-readable-error-smoke.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  journal.completed = true;
  saveJournal();
  console.log(JSON.stringify(evidence, null, 2));
}

await main();
