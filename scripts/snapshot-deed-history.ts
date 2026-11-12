import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as sqlite from "node:sqlite";
import { z } from "zod";
import {
  captureDeedHistory,
  verifyDeedHistoryCutover,
} from "../services/api/src/deed-history.js";

const { DatabaseSync } = sqlite;
const backup = (
  sqlite as typeof sqlite & {
    backup: (sourceDb: sqlite.DatabaseSync, path: string) => Promise<number>;
  }
).backup;

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const dbPath = option("--db");
const contractId = option("--contract");
const height = Number(option("--height"));
const atMs = Number(option("--at-ms"));
const mapPath =
  option("--map") ?? "contracts/estate/migration-v1-to-v2-draft.json";
const apply = args.includes("--apply");
const rehearse = args.includes("--rehearse");
const verify = args.includes("--verify");
const allowReusedSource = args.includes("--allow-reused-source");
if (Number(apply) + Number(rehearse) + Number(verify) > 1)
  throw new Error("Choose only one of --apply, --rehearse or --verify");
if (allowReusedSource && !verify)
  throw new Error("--allow-reused-source requires --verify");
if (
  !dbPath ||
  !contractId ||
  !Number.isSafeInteger(height) ||
  height < 1 ||
  !Number.isSafeInteger(atMs) ||
  atMs < 1
)
  throw new Error(
    "Usage: npm run city:deed-history -- --db <existing SQLite file> --contract <testnet ID> --height <frozen block> --at-ms <cutover UTC milliseconds> [--map <move map>] [--rehearse | --apply | --verify [--allow-reused-source]]",
  );
const stat = statSync(resolve(dbPath));
if (!stat.isFile()) throw new Error("Deed-history database is not a file");
const map = z
  .object({
    sourceCityVersion: z.literal(1),
    targetCityVersion: z.literal(2),
    status: z.string(),
    moves: z.array(z.object({ from: z.string(), to: z.string() })).min(1),
  })
  .parse(JSON.parse(readFileSync(resolve(mapPath), "utf8")));
if ((apply || verify) && map.status !== "reviewed")
  throw new Error(
    "Review and mark the deed move map reviewed before applying or verifying",
  );
const db = new DatabaseSync(resolve(dbPath), { readOnly: !apply });
try {
  if (verify) {
    const result = verifyDeedHistoryCutover(
      db,
      contractId,
      map.moves,
      height,
      atMs,
      { allowReusedSourceActivity: allowReusedSource },
    );
    console.log(
      JSON.stringify({
        applied: false,
        verified: true,
        sourceReadOnly: true,
        ...(allowReusedSource ? { allowReusedSourceActivity: true } : {}),
        contractId,
        cutoverHeight: height,
        cutoverAtMs: atMs,
        ...result,
        moves: map.moves,
      }),
    );
  } else if (apply) {
    const result = captureDeedHistory(db, contractId, map.moves, height, atMs);
    const verified = verifyDeedHistoryCutover(
      db,
      contractId,
      map.moves,
      height,
      atMs,
    );
    console.log(
      JSON.stringify({
        applied: true,
        verified: true,
        ...result,
        ...verified,
        moves: map.moves,
      }),
    );
  } else if (rehearse) {
    const dir = mkdtempSync(join(tmpdir(), "estate-deed-rehearsal-"));
    try {
      const copyPath = join(dir, "estate.sqlite");
      await backup(db, copyPath);
      const copy = new DatabaseSync(copyPath);
      try {
        const workflowTables = [
          "media_uploads",
          "media_upload_attempts",
          "media_proposals",
          "generation_jobs",
        ];
        if (
          copy
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'paid_generation_jobs'",
            )
            .get()
        )
          workflowTables.push("paid_generation_jobs");
        for (const table of workflowTables)
          if (
            !copy
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
              )
              .get(table)
          )
            throw new Error(
              `Deed rehearsal needs the current media API database; missing ${table}`,
            );
        const count = (table: string, plotId: string): number =>
          (
            copy
              .prepare(
                `SELECT COUNT(*) AS total FROM ${table} WHERE plot_id = ?`,
              )
              .get(plotId) as { total: number }
          ).total;
        const before = map.moves.map((move) => ({
          ...move,
          rows: workflowTables.map((table) => ({
            table,
            source: count(table, move.from),
            target: count(table, move.to),
          })),
        }));
        const result = captureDeedHistory(
          copy,
          contractId,
          map.moves,
          height,
          atMs,
        );
        const verified = verifyDeedHistoryCutover(
          copy,
          contractId,
          map.moves,
          height,
          atMs,
        );
        for (const move of before)
          for (const row of move.rows)
            if (
              count(row.table, move.from) !== 0 ||
              count(row.table, move.to) !== row.source + row.target
            )
              throw new Error(
                `Rehearsal did not move ${row.table} for ${move.from}`,
              );
        const integrity = copy.prepare("PRAGMA integrity_check").get() as {
          integrity_check: string;
        };
        if (integrity.integrity_check !== "ok")
          throw new Error("Rehearsal copy failed SQLite integrity check");
        console.log(
          JSON.stringify({
            applied: false,
            rehearsed: true,
            sourceReadOnly: true,
            mapStatus: map.status,
            contractId,
            cutoverHeight: height,
            cutoverAtMs: atMs,
            ...result,
            workflowRowsVerified: verified.workflowRowsVerified,
            workflowRowsMoved: before.reduce(
              (total, move) =>
                total + move.rows.reduce((sum, row) => sum + row.source, 0),
              0,
            ),
            moves: map.moves,
          }),
        );
      } finally {
        copy.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    const cursor = db
      .prepare(
        "SELECT contract_id, last_height FROM indexer_state WHERE id = 1",
      )
      .get();
    console.log(
      JSON.stringify({
        applied: false,
        mapStatus: map.status,
        contractId,
        cutoverHeight: height,
        cutoverAtMs: atMs,
        cursor,
        moves: map.moves,
      }),
    );
  }
} finally {
  db.close();
}
