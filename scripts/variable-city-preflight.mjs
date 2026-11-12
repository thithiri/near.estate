import assert from "node:assert/strict";

// The code-only candidate passed the imported-state pause and rollback rehearsal.
// Rehearse and update this hash if the legacy freeze build changes.
export const HARDENED_PAUSE_WASM_SHA256 =
  "8132e2ab092bdfa0ddb368f894edb5782b95a049cad094d4b2410d007b4fab0c";

export function validateVariableCityPreflight(
  source,
  target,
  inventory,
  plan,
  releaseEvidence = null,
) {
  assert.equal(source.version, plan.sourceCityVersion);
  assert.equal(target.version, plan.targetCityVersion);
  assert.equal(source.plots.length, 80);
  assert.equal(target.plots.length, 100);
  assert.equal(inventory.plotCount, source.plots.length);
  assert.equal(inventory.npcSiteCount, source.npcSites.length);
  assert.deepEqual(
    inventory.plotGeometry,
    source.plots
      .map(({ id, roadId, side, index, corner }) => ({
        id,
        roadId,
        side,
        index,
        corner,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    "Frozen plot geometry differs from the source city seed",
  );
  assert.deepEqual(
    inventory.npcSiteGeometry,
    source.npcSites
      .map(({ id, roadId, side, frontageIndex, role, name, capacity }) => ({
        id,
        roadId,
        side,
        frontageIndex,
        role,
        name,
        capacity,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    "Frozen civic sites differ from the source city seed",
  );
  assert.equal(inventory.codeHash?.length > 0, true);
  assert.equal(inventory.finalBlock?.hash?.length > 0, true);
  assert.equal(inventory.curbSessions.length, 0, "Curb parking is occupied");
  assert.equal(inventory.towerSessions.length, 0, "Tower parking is occupied");

  const sourcePlots = new Map(source.plots.map((plot) => [plot.id, plot]));
  const targetPlots = new Map(target.plots.map((plot) => [plot.id, plot]));
  const ownedPlots = new Map(
    inventory.ownedPlots.map((plot) => [plot.id, plot]),
  );
  assert.equal(ownedPlots.size, inventory.ownedPlots.length);
  assert.equal(plan.moves.length, ownedPlots.size, "Owned deed count changed");
  assert.equal(
    new Set(plan.moves.map((move) => move.from)).size,
    plan.moves.length,
  );
  assert.equal(
    new Set(plan.moves.map((move) => move.to)).size,
    plan.moves.length,
  );

  const sourceSites = new Map(source.npcSites.map((site) => [site.id, site]));
  assert.equal(target.npcSites.length, sourceSites.size);
  for (const site of target.npcSites) {
    const previous = sourceSites.get(site.id);
    assert.ok(previous, `New or renamed civic site: ${site.id}`);
    assert.equal(site.role, previous.role);
    assert.equal(site.capacity, previous.capacity);
  }
  for (const street of target.streets) {
    for (const side of ["North", "South"]) {
      const plots = target.plots.filter(
        (plot) => plot.roadId === street.id && plot.side === side,
      );
      assert.equal(plots.length, 10, `${street.id} ${side} plot count`);
      assert.deepEqual(
        [1, 2, 3].map(
          (units) =>
            plots.filter((plot) => plot.frontageUnits === units).length,
        ),
        [3, 6, 1],
        `${street.id} ${side} frontage mix`,
      );
    }
  }

  const accountIds = new Set(
    inventory.ownerAccounts.map((record) => record.account_id),
  );
  assert.equal(accountIds.size, inventory.ownerAccounts.length);
  const moves = [];
  const mediaCarryover = [];
  for (const move of plan.moves) {
    const owned = ownedPlots.get(move.from);
    assert.ok(owned?.owner, `Source deed is not owned: ${move.from}`);
    assert.ok(
      accountIds.has(owned.owner),
      `Owner account missing: ${owned.owner}`,
    );
    const original = sourcePlots.get(move.from);
    const destination = targetPlots.get(move.to);
    assert.ok(original, `Source deed missing: ${move.from}`);
    assert.ok(destination, `Destination deed missing: ${move.to}`);
    assert.equal(owned.road_id, original.roadId);
    assert.equal(owned.side, original.side);
    assert.equal(owned.index, original.index);
    assert.equal(destination.roadId, original.roadId);
    assert.equal(destination.side, original.side);
    assert.equal(
      destination.frontageUnits,
      original.frontageUnits ?? 2,
      `Destination changes purchased width: ${move.to}`,
    );
    assert.ok(
      !ownedPlots.has(move.to),
      `Destination is already owned: ${move.to}`,
    );
    moves.push({ from: move.from, to: move.to, owner: owned.owner });
    const media = {
      from: move.from,
      to: move.to,
      approvedFacadeHash: owned.building?.approved_manifest_hash ?? null,
      pendingFacadeHash:
        owned.building?.pending_appearance?.manifest_hash ?? null,
      activeLogoHash: owned.logo?.active?.content?.asset_hash ?? null,
      pendingLogoHash: owned.logo?.pending?.content?.asset_hash ?? null,
      activeBillboardHash: owned.billboard?.active?.content?.asset_hash ?? null,
      pendingBillboardHash:
        owned.billboard?.pending?.content?.asset_hash ?? null,
    };
    if (
      media.approvedFacadeHash ||
      media.pendingFacadeHash ||
      media.activeLogoHash ||
      media.pendingLogoHash ||
      media.activeBillboardHash ||
      media.pendingBillboardHash
    )
      mediaCarryover.push(media);
  }
  for (const id of ownedPlots.keys())
    assert.ok(
      plan.moves.some((move) => move.from === id),
      `Unmapped deed: ${id}`,
    );
  for (const record of inventory.ownerAccounts)
    assert.equal(
      record.account.active_session_id,
      null,
      `Owner has an active session: ${record.account_id}`,
    );

  const matches = (left, right) =>
    JSON.stringify(left) === JSON.stringify(right);
  const reviewedMoves =
    plan.status === "reviewed" &&
    inventory.stateSha256 &&
    plan.review?.stateSha256 === inventory.stateSha256 &&
    Number.isFinite(Date.parse(plan.review?.reviewedAt ?? "")) &&
    matches(
      [...new Set(plan.review?.ownerAccountIds ?? [])].sort(),
      [...new Set(moves.map((move) => move.owner))].sort(),
    ) &&
    matches(plan.review.moves, moves);
  const reviewedMedia =
    mediaCarryover.length === 0 ||
    (inventory.stateSha256 &&
      plan.mediaReview?.stateSha256 === inventory.stateSha256 &&
      plan.mediaReview?.acceptedVisibility === true &&
      Number.isFinite(Date.parse(plan.mediaReview?.reviewedAt ?? "")) &&
      matches(plan.mediaReview.carryover, mediaCarryover));
  const backup = releaseEvidence?.backup;
  const carriedMediaAssetCount = mediaCarryover.reduce(
    (count, item) =>
      count +
      Number(Boolean(item.activeLogoHash)) +
      Number(Boolean(item.pendingLogoHash)) +
      Number(Boolean(item.activeBillboardHash)) +
      Number(Boolean(item.pendingBillboardHash)),
    0,
  );
  const carriedFacadeCount = mediaCarryover.reduce(
    (count, item) =>
      count +
      Number(Boolean(item.approvedFacadeHash)) +
      Number(Boolean(item.pendingFacadeHash)),
    0,
  );
  const verifiedBackup =
    backup?.finalBlockHash === inventory.finalBlock.hash &&
    Number.isSafeInteger(backup?.indexerCursorHeight) &&
    backup?.indexerCursorHeight >= inventory.finalBlock.height &&
    /^[a-f0-9]{64}$/.test(backup?.sqliteSha256 ?? "") &&
    /^[a-f0-9]{64}$/.test(backup?.assetsSha256 ?? "") &&
    /^[a-f0-9]{64}$/.test(backup?.backupManifestSha256 ?? "") &&
    backup?.verifiedRestore === true &&
    backup?.chainMediaAssetsVerified === true &&
    backup?.deedWorkflowsVerified === true &&
    backup?.deedWorkflowMoveCount === moves.length &&
    Number.isSafeInteger(backup?.deedWorkflowSourceRows) &&
    backup?.deedWorkflowSourceRows >= 0 &&
    backup?.carriedLogoAndBillboardCount === carriedMediaAssetCount &&
    backup?.carriedFacadeCount === carriedFacadeCount;
  const rehearsal = releaseEvidence?.rehearsal;
  const carriedLogoCount = mediaCarryover.filter(
    (item) => item.activeLogoHash,
  ).length;
  const verifiedRehearsal =
    inventory.stateSha256 &&
    inventory.codeSha256 &&
    rehearsal?.contractId === inventory.contractId &&
    rehearsal?.liveCodeSha256 === inventory.codeSha256 &&
    rehearsal?.liveStateSha256 === inventory.stateSha256 &&
    rehearsal?.pausedSandboxStateSha256 === inventory.stateSha256 &&
    rehearsal?.reversedSandboxStateSha256 === inventory.stateSha256 &&
    /^[a-f0-9]{64}$/.test(rehearsal?.convertedSandboxStateSha256 ?? "") &&
    /^[a-f0-9]{64}$/.test(rehearsal?.reverseWasmSha256 ?? "") &&
    /^[a-f0-9]{64}$/.test(rehearsal?.sourcePlotHash ?? "") &&
    /^[a-f0-9]{64}$/.test(rehearsal?.targetSeedHash ?? "") &&
    releaseEvidence?.releaseWasmSha256 === rehearsal?.migrationWasmSha256 &&
    rehearsal?.runtimeWasmSha256 === rehearsal?.migrationWasmSha256 &&
    rehearsal?.newPlots === target.plots.length &&
    rehearsal?.newCurbSpaces ===
      target.plots.reduce((total, plot) => total + plot.frontageUnits, 0) &&
    rehearsal?.ownedDeeds === moves.length &&
    matches(rehearsal?.moves, plan.moves) &&
    rehearsal?.exactStorageRollback === true &&
    rehearsal?.oldCodeRestored === true &&
    rehearsal?.outsiderRejected === true &&
    rehearsal?.wrongHashRejected === true &&
    rehearsal?.duplicateRejected === true &&
    rehearsal?.runtimeGameplayKeyMethodsVerified === true &&
    rehearsal?.runtimeRestrictedParkingVerified === true &&
    rehearsal?.runtimeForbiddenPurchaseDenied === true &&
    rehearsal?.runtimeGameplayKeyRevoked === true &&
    rehearsal?.runtimeCarriedLogosEligibleVerified === true &&
    rehearsal?.runtimeCarriedLogoCount === carriedLogoCount;
  const remainingGates = [
    ...(inventory.codeSha256 === HARDENED_PAUSE_WASM_SHA256
      ? []
      : ["install the tested pause-guard contract code"]),
    ...(inventory.paused
      ? []
      : ["freeze the live contract and repeat inventory"]),
    ...(reviewedMoves
      ? []
      : [
          "review deed moves with the current owner and at the street junctions",
        ]),
    ...(reviewedMedia
      ? []
      : [
          "review legacy facade and media visibility on the destination designs",
        ]),
    ...(verifiedBackup
      ? []
      : ["capture the API cursor and verified data backup"]),
    ...(verifiedRehearsal
      ? []
      : [
          "rehearse version-2 conversion and rollback from the final frozen state",
        ]),
  ];

  return {
    finalBlock: inventory.finalBlock,
    sourcePlots: source.plots.length,
    targetPlots: target.plots.length,
    targetCurbSpaces: target.plots.reduce(
      (total, plot) => total + plot.frontageUnits,
      0,
    ),
    civicSites: target.npcSites.length,
    moves,
    mediaCarryover,
    paused: inventory.paused,
    migrationReady: remainingGates.length === 0,
    remainingGates,
  };
}
