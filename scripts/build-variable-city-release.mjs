import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rehearsalPath =
  process.argv[2] ??
  "deployments/variable-city-sandbox-rehearsal-2026-11-12.json";
assert.match(rehearsalPath, /^deployments\/[^/]+\.json$/);
const rehearsal = JSON.parse(await readFile(resolve(root, rehearsalPath)));
const expected = {
  runtime: rehearsal.runtimeWasmSha256,
  reverse: rehearsal.reverseWasmSha256,
};
for (const value of Object.values(expected))
  assert.match(value, /^[a-f0-9]{64}$/);
assert.equal(expected.runtime, rehearsal.migrationWasmSha256);

// Keep the migration workspace's build units separate from the game's root
// workspace; sharing a Cargo target directory can mix NEAR SDK crate metadata.
const targetDir = resolve(root, "contracts/city-migration/target");
const outputDir = join(
  resolve(root, "target"),
  "variable-city-release",
  expected.runtime.slice(0, 16),
);
await mkdir(outputDir, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cargo = process.env.CARGO ?? "cargo";
const source = join(
  targetDir,
  "wasm32-unknown-unknown",
  "release",
  "near_estate_city_migration.wasm",
);
const paths = {};
for (const feature of ["runtime", "reverse"]) {
  const built = spawnSync(
    cargo,
    [
      "build",
      "--manifest-path",
      "contracts/city-migration/Cargo.toml",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "--features",
      feature,
    ],
    {
      cwd: root,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      stdio: "inherit",
    },
  );
  assert.equal(built.status, 0, `${feature} city WASM build failed`);
  const bytes = await readFile(source);
  assert.ok(bytes.subarray(0, 4).equals(Buffer.from("\0asm")));
  assert.equal(
    hash(bytes),
    expected[feature],
    `${feature} differs from rehearsal`,
  );
  const output = join(outputDir, `${feature}.wasm`);
  await writeFile(output, bytes);
  paths[feature] = output;
}
console.log(
  JSON.stringify(
    {
      rehearsal: rehearsalPath,
      runtimeWasm: paths.runtime,
      reverseWasm: paths.reverse,
      runtimeSha256: expected.runtime,
      reverseSha256: expected.reverse,
    },
    null,
    2,
  ),
);
