import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HARDENED_PAUSE_WASM_SHA256,
  validateVariableCityPreflight,
} from "./variable-city-preflight.mjs";

const read = (path) =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const source = read("contracts/estate/seed.json");
const target = read("contracts/estate/seed-v2.json");
const inventory = read(
  "deployments/variable-city-readiness-current-2026-11-12.json",
);
const plan = read("contracts/estate/migration-v1-to-v2-draft.json");
const rehearsal = read(
  "deployments/variable-city-sandbox-rehearsal-2026-11-12.json",
);
const copy = (value) => structuredClone(value);

test("draft deed moves preserve width and account ownership", () => {
  const result = validateVariableCityPreflight(source, target, inventory, plan);
  assert.equal(result.targetPlots, 100);
  assert.equal(result.targetCurbSpaces, 180);
  assert.equal(result.moves.length, 2);
  assert.equal(result.paused, false);
  assert.equal(result.migrationReady, false);
  assert.deepEqual(result.mediaCarryover, [
    {
      from: "plot-main-n-2",
      to: "plot-main-n-3",
      approvedFacadeHash:
        inventory.ownedPlots[0].building.approved_manifest_hash,
      pendingFacadeHash: null,
      activeLogoHash: inventory.ownedPlots[0].logo.active.content.asset_hash,
      pendingLogoHash: null,
      activeBillboardHash:
        inventory.ownedPlots[0].billboard.active.content.asset_hash,
      pendingBillboardHash: null,
    },
  ]);
  assert.ok(
    result.remainingGates.some((gate) => gate.includes("media visibility")),
  );
});

test("preflight rejects missing or changed source plot and civic geometry", () => {
  const changedPlot = copy(inventory);
  changedPlot.plotGeometry[0].index += 1;
  assert.throws(
    () => validateVariableCityPreflight(source, target, changedPlot, plan),
    /Frozen plot geometry differs/,
  );
  const changedSite = copy(inventory);
  changedSite.npcSiteGeometry[0].capacity += 1;
  assert.throws(
    () => validateVariableCityPreflight(source, target, changedSite, plan),
    /Frozen civic sites differ/,
  );
  const missingGeometry = copy(inventory);
  delete missingGeometry.plotGeometry;
  assert.throws(
    () => validateVariableCityPreflight(source, target, missingGeometry, plan),
    /Frozen plot geometry differs/,
  );
});

test("preflight removes the media gate only when no owned media carries over", () => {
  const changed = copy(inventory);
  for (const plot of changed.ownedPlots) {
    plot.building.approved_manifest_hash = null;
    plot.building.pending_appearance = null;
    plot.logo.active = null;
    plot.logo.pending = null;
    plot.billboard.active = null;
    plot.billboard.pending = null;
  }
  const result = validateVariableCityPreflight(source, target, changed, plan);
  assert.deepEqual(result.mediaCarryover, []);
  assert.equal(
    result.remainingGates.some((gate) => gate.includes("media visibility")),
    false,
  );
});

test("preflight includes pending logo and billboard files in media review", () => {
  const changed = copy(inventory);
  const plot = changed.ownedPlots[0];
  plot.logo.pending = {
    content: { asset_hash: "a".repeat(64) },
  };
  plot.billboard.pending = {
    content: { asset_hash: "b".repeat(64) },
  };
  const result = validateVariableCityPreflight(source, target, changed, plan);
  assert.equal(result.mediaCarryover[0].pendingLogoHash, "a".repeat(64));
  assert.equal(result.mediaCarryover[0].pendingBillboardHash, "b".repeat(64));
  assert.ok(
    result.remainingGates.some((gate) => gate.includes("media visibility")),
  );
});

test("preflight stops when a deed was bought after the move plan", () => {
  const changed = copy(inventory);
  changed.ownedPlots.push({
    ...changed.ownedPlots[0],
    id: "plot-main-n-3",
    index: 3,
  });
  assert.throws(
    () => validateVariableCityPreflight(source, target, changed, plan),
    /Owned deed count changed/,
  );
});

test("preflight stops when parking remains occupied", () => {
  const changed = copy(inventory);
  changed.towerSessions.push({ id: 99 });
  assert.throws(
    () => validateVariableCityPreflight(source, target, changed, plan),
    /Tower parking is occupied/,
  );
});

test("preflight refuses a smaller destination deed", () => {
  const changed = copy(target);
  changed.plots.find((plot) => plot.id === "plot-main-n-3").frontageUnits = 1;
  changed.plots.find((plot) => plot.id === "plot-main-n-2").frontageUnits = 2;
  assert.throws(
    () => validateVariableCityPreflight(source, changed, inventory, plan),
    /Destination changes purchased width/,
  );
});

test("preflight stops when an owner has an active car", () => {
  const changed = copy(inventory);
  changed.ownerAccounts[0].account.active_session_id = 88;
  assert.throws(
    () => validateVariableCityPreflight(source, target, changed, plan),
    /Owner has an active session/,
  );
});

test("release readiness requires reviews and backup tied to the frozen state", () => {
  const frozen = copy(inventory);
  frozen.paused = true;
  frozen.stateSha256 = rehearsal.liveStateSha256;
  frozen.codeSha256 = HARDENED_PAUSE_WASM_SHA256;
  const reviewed = copy(plan);
  reviewed.status = "reviewed";
  reviewed.review = {
    reviewedAt: "2026-11-12T00:00:00Z",
    stateSha256: frozen.stateSha256,
    ownerAccountIds: [...new Set(frozen.ownedPlots.map((plot) => plot.owner))],
    moves: reviewed.moves.map((move) => ({
      ...move,
      owner: frozen.ownedPlots.find((plot) => plot.id === move.from).owner,
    })),
  };
  reviewed.mediaReview = {
    reviewedAt: "2026-11-12T00:00:00Z",
    stateSha256: frozen.stateSha256,
    acceptedVisibility: true,
    carryover: validateVariableCityPreflight(source, target, frozen, plan)
      .mediaCarryover,
  };
  const frozenRehearsal = copy(rehearsal);
  frozenRehearsal.liveCodeSha256 = HARDENED_PAUSE_WASM_SHA256;
  frozenRehearsal.pausedSandboxStateSha256 = frozen.stateSha256;
  frozenRehearsal.reversedSandboxStateSha256 = frozen.stateSha256;
  frozenRehearsal.runtimeCarriedLogosEligibleVerified = true;
  frozenRehearsal.runtimeCarriedLogoCount =
    reviewed.mediaReview.carryover.filter((item) => item.activeLogoHash).length;
  const evidence = {
    releaseWasmSha256: rehearsal.migrationWasmSha256,
    backup: {
      finalBlockHash: frozen.finalBlock.hash,
      indexerCursorHeight: frozen.finalBlock.height,
      sqliteSha256: "a".repeat(64),
      assetsSha256: "b".repeat(64),
      backupManifestSha256: "e".repeat(64),
      verifiedRestore: true,
      chainMediaAssetsVerified: true,
      deedWorkflowsVerified: true,
      deedWorkflowMoveCount: reviewed.moves.length,
      deedWorkflowSourceRows: 20,
      carriedLogoAndBillboardCount: 2,
      carriedFacadeCount: 1,
    },
    rehearsal: frozenRehearsal,
  };
  const ready = validateVariableCityPreflight(
    source,
    target,
    frozen,
    reviewed,
    evidence,
  );
  assert.equal(ready.migrationReady, true);
  assert.deepEqual(ready.remainingGates, []);
  const missingChainMedia = copy(evidence);
  missingChainMedia.backup.chainMediaAssetsVerified = false;
  assert.equal(
    validateVariableCityPreflight(
      source,
      target,
      frozen,
      reviewed,
      missingChainMedia,
    ).migrationReady,
    false,
  );
  const conflictingWorkflow = copy(evidence);
  conflictingWorkflow.backup.deedWorkflowsVerified = false;
  assert.equal(
    validateVariableCityPreflight(
      source,
      target,
      frozen,
      reviewed,
      conflictingWorkflow,
    ).migrationReady,
    false,
  );

  const olderPauseCode = copy(frozen);
  olderPauseCode.codeSha256 = rehearsal.liveCodeSha256;
  const olderPauseEvidence = copy(evidence);
  olderPauseEvidence.rehearsal.liveCodeSha256 = olderPauseCode.codeSha256;
  const oldCodeResult = validateVariableCityPreflight(
    source,
    target,
    olderPauseCode,
    reviewed,
    olderPauseEvidence,
  );
  assert.equal(oldCodeResult.migrationReady, false);
  assert.deepEqual(oldCodeResult.remainingGates, [
    "install the tested pause-guard contract code",
  ]);

  for (const field of [
    "runtimeGameplayKeyMethodsVerified",
    "runtimeRestrictedParkingVerified",
    "runtimeForbiddenPurchaseDenied",
    "runtimeGameplayKeyRevoked",
    "runtimeCarriedLogosEligibleVerified",
  ]) {
    const missingKeyCheck = copy(evidence);
    missingKeyCheck.rehearsal[field] = false;
    const rejected = validateVariableCityPreflight(
      source,
      target,
      frozen,
      reviewed,
      missingKeyCheck,
    );
    assert.equal(rejected.migrationReady, false, field);
  }
  const wrongCarriedLogoCount = copy(evidence);
  wrongCarriedLogoCount.rehearsal.runtimeCarriedLogoCount = 0;
  assert.equal(
    validateVariableCityPreflight(
      source,
      target,
      frozen,
      reviewed,
      wrongCarriedLogoCount,
    ).migrationReady,
    false,
  );
  for (const field of [
    "pausedSandboxStateSha256",
    "reversedSandboxStateSha256",
    "convertedSandboxStateSha256",
    "reverseWasmSha256",
  ]) {
    const wrongRecovery = copy(evidence);
    wrongRecovery.rehearsal[field] = "0";
    assert.equal(
      validateVariableCityPreflight(
        source,
        target,
        frozen,
        reviewed,
        wrongRecovery,
      ).migrationReady,
      false,
      field,
    );
  }

  frozen.stateSha256 = "c".repeat(64);
  const changed = validateVariableCityPreflight(
    source,
    target,
    frozen,
    reviewed,
    evidence,
  );
  assert.equal(changed.migrationReady, false);
  assert.ok(changed.remainingGates.some((gate) => gate.includes("deed moves")));
  assert.ok(
    changed.remainingGates.some((gate) => gate.includes("media visibility")),
  );
  assert.ok(changed.remainingGates.some((gate) => gate.includes("rehearse")));

  frozen.stateSha256 = rehearsal.liveStateSha256;
  evidence.releaseWasmSha256 = "d".repeat(64);
  const wrongBuild = validateVariableCityPreflight(
    source,
    target,
    frozen,
    reviewed,
    evidence,
  );
  assert.equal(wrongBuild.migrationReady, false);
  assert.deepEqual(wrongBuild.remainingGates, [
    "rehearse version-2 conversion and rollback from the final frozen state",
  ]);
});
