import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  validateAssetManifest,
  validateAssetManifestV2,
} from "@estate/shared";

const run = promisify(execFile);
const command = resolve(import.meta.dirname, "state-backup.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const WORKFLOW_TABLES = [
  "media_uploads",
  "media_upload_attempts",
  "media_proposals",
  "generation_jobs",
];

export function verifyDeedWorkflows(backupDir, moves) {
  assert.ok(Array.isArray(moves), "Reviewed deed moves are missing");
  const sources = new Set();
  const targets = new Set();
  for (const move of moves) {
    assert.match(move.from, /^plot-[a-z]+-[ns]-[0-9]$/);
    assert.match(move.to, /^plot-[a-z]+-[ns]-[0-9]$/);
    assert.notEqual(move.from, move.to);
    assert.ok(!sources.has(move.from), "Duplicate source deed move");
    assert.ok(!targets.has(move.to), "Duplicate destination deed move");
    sources.add(move.from);
    targets.add(move.to);
  }
  assert.ok(
    [...sources].every((source) => !targets.has(source)),
    "Deed move sources and targets overlap",
  );
  const db = new DatabaseSync(join(backupDir, "estate.sqlite"), {
    readOnly: true,
  });
  try {
    const tables = [...WORKFLOW_TABLES];
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'paid_generation_jobs'",
        )
        .get()
    )
      tables.push("paid_generation_jobs");
    let sourceRows = 0;
    for (const table of tables) {
      assert.ok(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table),
        `Deed workflow table is missing: ${table}`,
      );
      for (const move of moves) {
        const destination = db
          .prepare(`SELECT 1 FROM ${table} WHERE plot_id = ? LIMIT 1`)
          .get(move.to);
        assert.ok(
          !destination,
          `Destination ${move.to} already has ${table} records`,
        );
        const count = db
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE plot_id = ?`)
          .get(move.from);
        sourceRows += count.count;
      }
    }
    return {
      deedWorkflowsVerified: true,
      deedWorkflowMoveCount: moves.length,
      deedWorkflowSourceRows: sourceRows,
    };
  } finally {
    db.close();
  }
}

export function verifyCarriedMedia(backupDir, inventory, archivedAssets) {
  assert.ok(
    Array.isArray(inventory.ownedPlots),
    "Owned deed inventory is missing",
  );
  const db = new DatabaseSync(join(backupDir, "estate.sqlite"), {
    readOnly: true,
  });
  let mediaCount = 0;
  let facadeCount = 0;
  try {
    const jobs = db
      .prepare(
        "SELECT id, plot_id, account_id, status, selected_candidate_id, candidates_json FROM generation_jobs",
      )
      .all();
    const candidates = jobs.flatMap((job) =>
      (JSON.parse(job.candidates_json) ?? []).map((candidate) => ({
        ...candidate,
        jobId: job.id,
        plotId: job.plot_id,
        accountId: job.account_id,
        jobStatus: job.status,
        selected: candidate.id === job.selected_candidate_id,
      })),
    );
    for (const plot of inventory.ownedPlots) {
      assert.ok(plot.id && plot.owner, "Owned deed identity is missing");
      for (const [kind, slot] of [
        ["Logo", plot.logo],
        ["Billboard", plot.billboard],
      ]) {
        for (const [state, reference] of [
          ["active", slot?.active],
          ["pending", slot?.pending],
        ]) {
          const assetHash = reference?.content?.asset_hash;
          if (!assetHash) continue;
          const label = `${state === "pending" ? "pending " : ""}${kind.toLowerCase()}`;
          assert.ok(
            archivedAssets.has(assetHash),
            `Carried ${label} asset is missing: ${assetHash}`,
          );
          assert.ok(
            db
              .prepare(
                state === "active"
                  ? "SELECT 1 FROM media_uploads WHERE hash = ? AND plot_id = ? AND account_id = ? AND kind = ? AND status = 'approved' LIMIT 1"
                  : "SELECT 1 FROM media_uploads WHERE hash = ? AND plot_id = ? AND account_id = ? AND kind = ? AND status != 'expired' LIMIT 1",
              )
              .get(assetHash, plot.id, plot.owner, kind),
            state === "active"
              ? `Carried ${label} is not public in the backup: ${assetHash}`
              : `Carried ${label} has no usable upload in the backup: ${assetHash}`,
          );
          const proposal = db
            .prepare(
              `SELECT 1 FROM media_proposals AS proposal
               JOIN media_uploads AS upload ON upload.id = proposal.upload_id
               WHERE proposal.plot_id = ? AND proposal.account_id = ? AND proposal.kind = ?
                 AND proposal.asset_hash = ? AND proposal.link IS ?
                 AND proposal.layout_revision = ?
                 AND upload.plot_id = proposal.plot_id
                 AND upload.account_id = proposal.account_id
                 AND upload.kind = proposal.kind
                 AND upload.hash = proposal.asset_hash
                 AND proposal.status ${state === "active" ? "= 'approved'" : "IN ('selected', 'submitted')"}
                 AND ${
                   state === "active"
                     ? "upload.status = 'approved'"
                     : "proposal.expected_media_revision = ? AND (proposal.proposal_revision IS NULL OR proposal.proposal_revision = ?) AND proposal.building_type = ? AND proposal.level = ?"
                 }
               LIMIT 1`,
            )
            .get(
              plot.id,
              plot.owner,
              kind,
              assetHash,
              reference.content.link ?? null,
              state === "active"
                ? reference.approved_layout_revision
                : reference.layout_revision,
              ...(state === "active"
                ? []
                : [
                    reference.revision - 1,
                    reference.revision,
                    reference.building_type,
                    reference.level,
                  ]),
            );
          assert.ok(
            proposal,
            `Carried ${label} moderation proposal is missing: ${assetHash}`,
          );
          mediaCount++;
        }
      }
      for (const [kind, manifestHash] of [
        ["approved", plot.building?.approved_manifest_hash],
        ["pending", plot.building?.pending_appearance?.manifest_hash],
      ]) {
        if (!manifestHash) continue;
        const candidate = candidates.find(
          (item) =>
            item.manifestHash === manifestHash &&
            item.plotId === plot.id &&
            item.accountId === plot.owner &&
            item.selected &&
            (kind === "pending"
              ? ["selected", "submitted"].includes(item.jobStatus)
              : item.jobStatus === "approved"),
        );
        assert.ok(
          candidate,
          `Carried ${kind} facade manifest is missing: ${manifestHash}`,
        );
        const validated =
          candidate.manifest?.schemaVersion === 2
            ? validateAssetManifestV2(candidate.manifest)
            : validateAssetManifest(candidate.manifest);
        assert.equal(
          hash(canonicalJson(validated)),
          manifestHash,
          `Carried ${kind} facade manifest hash differs`,
        );
        for (const assetHash of [
          validated.spriteHash,
          validated.thumbnailHash,
        ]) {
          assert.ok(
            archivedAssets.has(assetHash),
            `Carried facade asset is missing: ${assetHash}`,
          );
          assert.ok(
            db
              .prepare(
                kind === "approved"
                  ? "SELECT 1 FROM generation_assets WHERE job_id = ? AND hash = ? AND is_public = 1 LIMIT 1"
                  : "SELECT 1 FROM generation_assets WHERE job_id = ? AND hash = ? LIMIT 1",
              )
              .get(candidate.jobId, assetHash),
            kind === "approved"
              ? `Carried approved facade asset is not public: ${assetHash}`
              : `Carried pending facade asset is not registered: ${assetHash}`,
          );
        }
        facadeCount++;
      }
    }
  } finally {
    db.close();
  }
  return { mediaCount, facadeCount };
}

export async function verifyVariableCityBackup(backupDir, inventory, moves) {
  assert.equal(
    inventory.paused,
    true,
    "Freeze the city before checking its backup",
  );
  assert.ok(inventory.finalBlock?.hash, "Frozen block hash is missing");
  assert.ok(Number.isSafeInteger(inventory.finalBlock.height));
  const { stdout } = await run(process.execPath, [
    command,
    "verify",
    backupDir,
  ]);
  const verified = JSON.parse(stdout);
  assert.equal(verified.operation, "verify");
  assert.equal(verified.contractId, inventory.contractId);
  const manifestBytes = await readFile(join(backupDir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const cursor = manifest.cursor;
  assert.equal(cursor?.contract_id, inventory.contractId);
  assert.ok(
    Number.isSafeInteger(cursor.last_height) &&
      cursor.last_height >= inventory.finalBlock.height,
    "Backup indexer cursor is behind the frozen block",
  );
  if (cursor.last_height === inventory.finalBlock.height)
    assert.equal(
      cursor.last_hash,
      inventory.finalBlock.hash,
      "Backup indexer cursor differs from the frozen block",
    );

  const restoreRoot = await mkdtemp(join(tmpdir(), "estate-city-restore-"));
  try {
    const restored = await run(process.execPath, [
      command,
      "restore",
      backupDir,
      join(restoreRoot, "data"),
      join(restoreRoot, "deployments"),
    ]);
    const result = JSON.parse(restored.stdout);
    assert.equal(result.operation, "restore");
    assert.deepEqual(result.cursor, cursor);
    assert.equal(result.contractId, inventory.contractId);
  } finally {
    await rm(restoreRoot, { recursive: true, force: true });
  }

  const sqlite = manifest.files.find((file) => file.path === "estate.sqlite");
  assert.ok(sqlite, "Backup SQLite entry is missing");
  const assets = manifest.files
    .filter((file) => file.path.startsWith("assets/"))
    .map((file) => ({ path: file.path, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const carried = verifyCarriedMedia(
    backupDir,
    inventory,
    new Set(assets.map((file) => file.sha256)),
  );
  const workflows = verifyDeedWorkflows(backupDir, moves);
  return {
    finalBlockHash: inventory.finalBlock.hash,
    indexerCursorHeight: cursor.last_height,
    sqliteSha256: sqlite.sha256,
    assetsSha256: hash(JSON.stringify(assets)),
    backupManifestSha256: hash(manifestBytes),
    verifiedRestore: true,
    chainMediaAssetsVerified: true,
    carriedLogoAndBillboardCount: carried.mediaCount,
    carriedFacadeCount: carried.facadeCount,
    ...workflows,
  };
}
