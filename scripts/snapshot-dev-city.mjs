import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";

const sourceArg = process.argv[2];
if (!sourceArg || !isAbsolute(sourceArg) || process.argv.length !== 3)
  throw new Error("Pass one absolute migrated API_DATA_DIR path");
const sourceDir = await realpath(sourceArg);
const sourceDbPath = join(sourceDir, "estate.sqlite");
const sourceAssets = join(sourceDir, "assets");
if (
  !existsSync(sourceDbPath) ||
  !existsSync(sourceAssets) ||
  !(await stat(sourceAssets)).isDirectory()
)
  throw new Error("Source needs estate.sqlite and an assets directory");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const snapshotRoot = join(root, "data", "dev-city-snapshots");
await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
await chmod(snapshotRoot, 0o700);
const snapshotDir = await mkdtemp(join(snapshotRoot, "snapshot-"));
await chmod(snapshotDir, 0o700);

try {
  const sourceDb = new DatabaseSync(sourceDbPath, { readOnly: true });
  let pages;
  try {
    pages = await backup(sourceDb, join(snapshotDir, "estate.sqlite"));
  } finally {
    sourceDb.close();
  }
  await chmod(join(snapshotDir, "estate.sqlite"), 0o600);
  const snapshotDb = new DatabaseSync(join(snapshotDir, "estate.sqlite"), {
    readOnly: true,
  });
  try {
    const result = snapshotDb.prepare("PRAGMA integrity_check").get();
    if (result.integrity_check !== "ok")
      throw new Error("Snapshot SQLite integrity check failed");
  } finally {
    snapshotDb.close();
  }

  const targetAssets = join(snapshotDir, "assets");
  await mkdir(targetAssets, { mode: 0o700 });
  let assetCount = 0;
  for (const entry of await readdir(sourceAssets, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.png$/.test(entry.name))
      throw new Error(`Unexpected service asset: ${entry.name}`);
    const bytes = await readFile(join(sourceAssets, entry.name));
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (`${hash}.png` !== entry.name)
      throw new Error(`Service asset hash mismatch: ${entry.name}`);
    await writeFile(join(targetAssets, entry.name), bytes, { mode: 0o600 });
    assetCount++;
  }
  console.log(
    `Copied ${pages} SQLite pages and ${assetCount} verified images.`,
  );
  console.log(`API_DATA_DIR=${snapshotDir} DEV_INDEXER=0 npm run dev:city`);
} catch (error) {
  await rm(snapshotDir, { recursive: true, force: true });
  throw error;
}
