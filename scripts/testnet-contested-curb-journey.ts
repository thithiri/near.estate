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
const plotId = "plot-market-n-2";
const slot = 0;
const deployment = JSON.parse(
  readFileSync(resolve(root, "deployments/testnet.json"), "utf8"),
) as { network: string; contractId: string };
assert.equal(deployment.network, "testnet");

function credentialFrom(name: "OWNER" | "DRIVER") {
  const path = process.env[`ESTATE_${name}_KEY_FILE`];
  if (!path || !path.startsWith("/"))
    throw new Error(`Set ESTATE_${name}_KEY_FILE to a private absolute path`);
  if (realpathSync(path).startsWith(`${root}/`))
    throw new Error(`${name} credential must stay outside the repository`);
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error(`${name} credential must be private`);
  const value = JSON.parse(readFileSync(path, "utf8")) as {
    account_id: string;
    public_key: string;
    secret_key: `ed25519:${string}`;
  };
  assert.match(value.account_id, /^[a-z0-9._-]+\.testnet$/);
  assert.equal(
    KeyPair.fromString(value.secret_key).getPublicKey().toString(),
    value.public_key,
  );
  return { ...value, path };
}

const contenders = [credentialFrom("OWNER"), credentialFrom("DRIVER")];
assert.notEqual(contenders[0]!.account_id, contenders[1]!.account_id);
const reader = new ChainReader(deployment.contractId);
type SignedCall = {
  accountId: string;
  carId?: number;
  durabilityBefore?: number;
  method: "park" | "collect";
  hash: string;
  signedBase64: string;
  outcome: "unknown" | "pending" | "success" | "failure";
};
type Journal = {
  contractId: string;
  plotId: string;
  slot: number;
  contenderIds: string[];
  parks: SignedCall[];
  collect: SignedCall | null;
  sessionId: number | null;
  completed: boolean;
};
const journalPath = resolve(
  dirname(contenders[0]!.path),
  "contested-curb-journal.json",
);
const fresh: Journal = {
  contractId: deployment.contractId,
  plotId,
  slot,
  contenderIds: contenders.map((entry) => entry.account_id),
  parks: [],
  collect: null,
  sessionId: null,
  completed: false,
};
const journal: Journal = existsSync(journalPath)
  ? (JSON.parse(readFileSync(journalPath, "utf8")) as Journal)
  : fresh;
assert.equal(journal.contractId, fresh.contractId);
assert.equal(journal.plotId, fresh.plotId);
assert.equal(journal.slot, fresh.slot);
assert.deepEqual(journal.contenderIds, fresh.contenderIds);

function saveJournal() {
  const temporary = `${journalPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, journalPath);
}

async function signCall(
  credential: (typeof contenders)[number],
  method: SignedCall["method"],
  args: Record<string, unknown>,
): Promise<SignedCall> {
  const access = await reader.accessKey(
    credential.account_id,
    credential.public_key,
  );
  const transaction = createTransaction(
    credential.account_id,
    KeyPair.fromString(credential.secret_key).getPublicKey(),
    deployment.contractId,
    access.nonce + 1n,
    [actionCreators.functionCall(method, args, 60n * 10n ** 12n, 0n)],
    baseDecode(access.blockHash),
  );
  const [hashBytes, signed] = await KeyPairSigner.fromSecretKey(
    credential.secret_key,
  ).signTransaction(transaction);
  return {
    accountId: credential.account_id,
    method,
    hash: baseEncode(hashBytes),
    signedBase64: Buffer.from(encodeTransaction(signed)).toString("base64"),
    outcome: "unknown",
  };
}

async function finishCall(call: SignedCall): Promise<SignedCall["outcome"]> {
  let outcome = await reader.transactionStatus(call.hash, call.accountId);
  if (outcome === "unknown") {
    try {
      outcome = await reader.sendSignedTransaction(call.signedBase64);
    } catch {
      // Resolve the exact signed transaction on the next status read.
    }
  }
  for (
    let attempt = 0;
    (outcome === "unknown" || outcome === "pending") && attempt < 8;
    attempt++
  ) {
    await new Promise((done) => setTimeout(done, 1_000));
    outcome = await reader.transactionStatus(call.hash, call.accountId);
  }
  return outcome;
}

async function finalFailure(call: SignedCall): Promise<{
  reason: string;
  receiptId: string;
}> {
  const response = await fetch(reader.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "near-estate-contested-curb",
      method: "tx",
      params: {
        tx_hash: call.hash,
        sender_account_id: call.accountId,
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
  assert(envelope.result.status?.Failure, "Loser has no final failure");
  const receipt = envelope.result.receipts_outcome?.find(
    (entry) =>
      entry.outcome.executor_id === deployment.contractId &&
      entry.outcome.status.Failure,
  );
  assert(receipt?.id, "Contract failure receipt is missing");
  return {
    reason: JSON.stringify(envelope.result.status.Failure),
    receiptId: receipt.id,
  };
}

async function main() {
  const plot = await reader.plot(plotId);
  assert(plot, "Contest plot is missing");
  assert.equal(plot.plot.owner, null, "Contest plot is no longer unowned");
  assert.equal(plot.effective_rule.kind, "Free");
  const players = await Promise.all(
    contenders.map((entry) => reader.player(entry.account_id)),
  );
  if (mode === "--plan") {
    const street = await reader.streetSide("market", "North");
    const target = street.plots.find((entry) => entry.plot.plot.id === plotId);
    console.log(
      JSON.stringify(
        {
          contractId: deployment.contractId,
          plotId,
          slot,
          owner: plot.plot.owner,
          rule: plot.effective_rule,
          open: target?.slots[slot] === null,
          contenders: contenders.map((entry, index) => ({
            accountId: entry.account_id,
            activeSession: players[index]?.active_session?.id ?? null,
            parkableCar: players[index]?.cars.find((car) => car.durability >= 2)
              ?.id,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (journal.completed) {
    const losingCall = journal.parks.find(
      (entry) => entry.outcome === "failure",
    );
    assert(losingCall);
    const losing = await finalFailure(losingCall);
    const evidencePath = resolve(
      root,
      "deployments/testnet-contested-curb-journey.json",
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<
      string,
      unknown
    >;
    evidence.loserReceiptId = losing.receiptId;
    evidence.loserFailureReason = losing.reason;
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log("Contested-curb journey verified and already completed");
    return;
  }
  if (!journal.parks.length) {
    const street = await reader.streetSide("market", "North");
    const target = street.plots.find((entry) => entry.plot.plot.id === plotId);
    assert.equal(target?.slots[slot], null, "Contest curb is occupied");
    for (const player of players)
      assert.equal(player.active_session, null, "Contender is already parked");
    journal.parks = await Promise.all(
      contenders.map(async (entry, index) => {
        const car = players[index]!.cars.find((item) => item.durability >= 2);
        assert(car, "Contender needs a parkable car");
        return {
          ...(await signCall(entry, "park", {
            car_id: car.id,
            plot_id: plotId,
            slot,
          })),
          carId: car.id,
          durabilityBefore: car.durability,
        };
      }),
    );
    saveJournal(); // Both exact signed calls exist before either is broadcast.
  }
  const outcomes = await Promise.all(journal.parks.map(finishCall));
  journal.parks.forEach((call, index) => {
    call.outcome = outcomes[index]!;
  });
  saveJournal();
  if (
    outcomes.some((outcome) => outcome === "unknown" || outcome === "pending")
  )
    throw new Error("Contest transactions are not final; rerun apply");
  assert.equal(outcomes.filter((outcome) => outcome === "success").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome === "failure").length, 1);
  const winningCall = journal.parks.find(
    (entry) => entry.outcome === "success",
  )!;
  const losingCall = journal.parks.find(
    (entry) => entry.outcome === "failure",
  )!;
  const losing = await finalFailure(losingCall);
  const afterPark = await Promise.all(
    contenders.map((entry) => reader.player(entry.account_id)),
  );
  const winner =
    afterPark[journal.contenderIds.indexOf(winningCall.accountId)]!;
  const loser = afterPark[journal.contenderIds.indexOf(losingCall.accountId)]!;
  const occupiedStreet = await reader.streetSide("market", "North");
  const occupiedPlot = occupiedStreet.plots.find(
    (entry) => entry.plot.plot.id === plotId,
  );
  assert.equal(
    occupiedPlot?.slots[slot]?.id,
    winner.active_session?.id,
    "The winner does not occupy the contested curb",
  );
  if (!journal.collect) {
    assert(winner.active_session, "Winner has no parking session");
    assert.equal(winner.active_session.location_id, plotId);
    assert.equal(winner.active_session.slot, slot);
    assert.equal(loser.active_session, null);
    assert.equal(
      winner.cars.find((car) => car.id === winningCall.carId)?.durability,
      winningCall.durabilityBefore! - 2,
    );
    assert.equal(
      loser.cars.find((car) => car.id === losingCall.carId)?.durability,
      losingCall.durabilityBefore,
    );
    journal.sessionId = winner.active_session.id;
    const winnerCredential = contenders.find(
      (entry) => entry.account_id === winningCall.accountId,
    )!;
    journal.collect = await signCall(winnerCredential, "collect", {
      expected_session_id: journal.sessionId,
    });
    saveJournal();
  }
  assert(journal.collect);
  journal.collect.outcome = await finishCall(journal.collect);
  saveJournal();
  assert.equal(journal.collect.outcome, "success", "Collection is not final");
  const finalPlayers = await Promise.all(
    contenders.map((entry) => reader.player(entry.account_id)),
  );
  for (const player of finalPlayers) assert.equal(player.active_session, null);
  const finalStreet = await reader.streetSide("market", "North");
  const finalPlot = finalStreet.plots.find(
    (entry) => entry.plot.plot.id === plotId,
  );
  assert.equal(finalPlot?.slots[slot], null, "Contest curb was not freed");
  journal.completed = true;
  saveJournal();
  const evidence = {
    network: "testnet",
    contractId: deployment.contractId,
    plotId,
    slot,
    winnerId: winningCall.accountId,
    loserId: losingCall.accountId,
    loserFailureReason: losing.reason,
    loserReceiptId: losing.receiptId,
    sessionId: journal.sessionId,
    parks: journal.parks.map(({ signedBase64, ...publicCall }) => publicCall),
    collect: {
      accountId: journal.collect.accountId,
      hash: journal.collect.hash,
      outcome: journal.collect.outcome,
    },
    losingCarDurabilityUnchanged: true,
    finalSlotFree: true,
    finalSessions: finalPlayers.map((entry) => entry.active_session),
  };
  writeFileSync(
    resolve(root, "deployments/testnet-contested-curb-journey.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));
}

await main();
