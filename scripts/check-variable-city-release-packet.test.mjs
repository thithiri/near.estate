import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { verifyReleasePacket } from "./check-variable-city-release-packet.mjs";
import {
  HARDENED_PAUSE_WASM_SHA256,
  validateVariableCityPreflight,
} from "./variable-city-preflight.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = {
  inventory: read(
    "deployments/variable-city-readiness-current-2026-11-12.json",
  ),
  source: read("contracts/estate/seed.json"),
  target: read("contracts/estate/seed-v2.json"),
  moves: read("contracts/estate/migration-v1-to-v2-draft.json"),
  releaseEvidence: null,
};
const parsed = Object.fromEntries(
  Object.entries(bytes)
    .filter(([, value]) => value)
    .map(([key, value]) => [key, JSON.parse(value)]),
);
const report = JSON.parse(
  read("deployments/variable-city-preflight-current-2026-11-12.json"),
);

test("release packet checks the current draft without pretending it is ready", () => {
  const result = verifyReleasePacket({
    report,
    inventory: parsed.inventory,
    source: parsed.source,
    target: parsed.target,
    moves: parsed.moves,
    releaseEvidence: null,
    backupEvidence: null,
    bytes,
    wasmBytes: null,
  });
  assert.equal(result.migrationReady, false);
  assert.ok(result.remainingGates.length > 0);
});

test("release packet rejects changed inventory or report data", () => {
  assert.throws(
    () =>
      verifyReleasePacket({
        report,
        inventory: parsed.inventory,
        source: parsed.source,
        target: parsed.target,
        moves: parsed.moves,
        releaseEvidence: null,
        backupEvidence: null,
        bytes: { ...bytes, inventory: Buffer.from("changed") },
        wasmBytes: null,
      }),
    /Expected values to be strictly equal/,
  );
  assert.throws(
    () =>
      verifyReleasePacket({
        report: { ...report, moves: [] },
        inventory: parsed.inventory,
        source: parsed.source,
        target: parsed.target,
        moves: parsed.moves,
        releaseEvidence: null,
        backupEvidence: null,
        bytes,
        wasmBytes: null,
      }),
    /release report differs/,
  );
});

test("live check rejects state drift after the saved inventory", () => {
  const input = {
    report,
    inventory: parsed.inventory,
    source: parsed.source,
    target: parsed.target,
    moves: parsed.moves,
    releaseEvidence: null,
    backupEvidence: null,
    bytes,
    wasmBytes: null,
    liveEvidence: {
      contractId: parsed.inventory.contractId,
      blockHeight: parsed.inventory.finalBlock.height + 1,
      codeSha256: parsed.inventory.codeSha256,
      stateSha256: "0".repeat(64),
      paused: parsed.inventory.paused,
    },
  };
  assert.throws(
    () => verifyReleasePacket(input),
    /Expected values to be strictly equal/,
  );
  input.liveEvidence.stateSha256 = parsed.inventory.stateSha256;
  assert.equal(verifyReleasePacket(input).migrationReady, false);
});

test("ready packet requires the exact rehearsed release WASM", () => {
  const inventory = structuredClone(parsed.inventory);
  const moves = structuredClone(parsed.moves);
  const rehearsal = JSON.parse(
    read("deployments/variable-city-sandbox-rehearsal-2026-11-12.json"),
  );
  inventory.paused = true;
  inventory.stateSha256 = rehearsal.liveStateSha256;
  inventory.codeSha256 = HARDENED_PAUSE_WASM_SHA256;
  rehearsal.liveCodeSha256 = HARDENED_PAUSE_WASM_SHA256;
  rehearsal.pausedSandboxStateSha256 = inventory.stateSha256;
  rehearsal.reversedSandboxStateSha256 = inventory.stateSha256;
  rehearsal.runtimeCarriedLogosEligibleVerified = true;
  rehearsal.runtimeCarriedLogoCount = 1;
  moves.status = "reviewed";
  moves.review = {
    reviewedAt: "2026-11-12T00:00:00Z",
    stateSha256: inventory.stateSha256,
    ownerAccountIds: [
      ...new Set(inventory.ownedPlots.map((plot) => plot.owner)),
    ],
    moves: moves.moves.map((move) => ({
      ...move,
      owner: inventory.ownedPlots.find((plot) => plot.id === move.from).owner,
    })),
  };
  moves.mediaReview = {
    reviewedAt: "2026-11-12T00:00:00Z",
    stateSha256: inventory.stateSha256,
    acceptedVisibility: true,
    carryover: validateVariableCityPreflight(
      parsed.source,
      parsed.target,
      inventory,
      parsed.moves,
    ).mediaCarryover,
  };
  const wasmBytes = Buffer.from("\0asmrelease fixture");
  rehearsal.migrationWasmSha256 = hash(wasmBytes);
  rehearsal.runtimeWasmSha256 = hash(wasmBytes);
  const releaseEvidence = {
    releaseWasmSha256: hash(wasmBytes),
    rehearsal,
  };
  const backupEvidence = {
    finalBlockHash: inventory.finalBlock.hash,
    indexerCursorHeight: inventory.finalBlock.height,
    sqliteSha256: "a".repeat(64),
    assetsSha256: "b".repeat(64),
    backupManifestSha256: "e".repeat(64),
    verifiedRestore: true,
    chainMediaAssetsVerified: true,
    deedWorkflowsVerified: true,
    deedWorkflowMoveCount: moves.moves.length,
    deedWorkflowSourceRows: 20,
    carriedLogoAndBillboardCount: 2,
    carriedFacadeCount: 1,
  };
  const readyBytes = {
    source: bytes.source,
    target: bytes.target,
    inventory: Buffer.from(JSON.stringify(inventory)),
    moves: Buffer.from(JSON.stringify(moves)),
    releaseEvidence: Buffer.from(JSON.stringify(releaseEvidence)),
  };
  const checked = validateVariableCityPreflight(
    parsed.source,
    parsed.target,
    inventory,
    moves,
    { ...releaseEvidence, backup: backupEvidence },
  );
  assert.equal(checked.migrationReady, true);
  const readyReport = {
    ...checked,
    contractId: inventory.contractId,
    inventorySha256: hash(readyBytes.inventory),
    sourceSeedSha256: hash(readyBytes.source),
    targetSeedSha256: hash(readyBytes.target),
    movePlanSha256: hash(readyBytes.moves),
    releaseEvidenceSha256: hash(readyBytes.releaseEvidence),
    backupEvidence,
  };
  const input = {
    report: readyReport,
    inventory,
    source: parsed.source,
    target: parsed.target,
    moves,
    releaseEvidence,
    backupEvidence,
    bytes: readyBytes,
    wasmBytes,
    liveEvidence: {
      contractId: inventory.contractId,
      blockHeight: inventory.finalBlock.height,
      stateSha256: inventory.stateSha256,
      codeSha256: inventory.codeSha256,
      paused: true,
    },
  };
  assert.equal(verifyReleasePacket(input).migrationReady, true);
  assert.throws(
    () => verifyReleasePacket({ ...input, liveEvidence: null }),
    /ready packet requires a finalized live-state read/,
  );
  assert.throws(
    () => verifyReleasePacket({ ...input, wasmBytes: null }),
    /ready packet lacks the release WASM/,
  );
  assert.throws(
    () =>
      verifyReleasePacket({
        ...input,
        wasmBytes: Buffer.from("\0asmwrong build"),
      }),
    /Expected values to be strictly equal/,
  );
});
