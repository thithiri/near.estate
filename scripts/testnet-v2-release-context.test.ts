import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { readActiveVersion2Release } from "./testnet-v2-release-context.js";

function hash(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("active release keeps the final deed destinations bound to reviewed bytes", () => {
  const root = mkdtempSync(resolve(tmpdir(), "estate-v2-release-"));
  try {
    mkdirSync(resolve(root, "deployments"), { recursive: true });
    mkdirSync(resolve(root, "contracts/estate"), { recursive: true });
    const seed = resolve(root, "contracts/estate/seed-v2.json");
    const map = resolve(root, "contracts/estate/migration-v1-to-v2-draft.json");
    const preflight = resolve(root, "deployments/preflight.json");
    const release = resolve(root, "deployments/release.json");
    writeFileSync(seed, '{"version":2,"plots":[]}\n');
    writeFileSync(
      map,
      JSON.stringify({
        status: "reviewed",
        moves: [
          { from: "plot-main-n-2", to: "plot-main-s-4" },
          { from: "plot-market-n-1", to: "plot-market-s-5" },
        ],
      }),
    );
    writeFileSync(
      preflight,
      JSON.stringify({
        contractId: "city.testnet",
        migrationReady: true,
        movePlanSha256: hash(map),
        targetSeedSha256: hash(seed),
      }),
    );
    writeFileSync(
      release,
      JSON.stringify({
        contractId: "city.testnet",
        status: "active",
        reopenedAtMs: 1_000,
        preflightFile: "deployments/preflight.json",
        preflightSha256: hash(preflight),
        afterWasmSha256: "a".repeat(64),
      }),
    );
    const deployment = {
      contractId: "city.testnet",
      wasmSha256: "a".repeat(64),
      citySeedVersion: 2,
    };
    const valid = readActiveVersion2Release(root, release, deployment);
    assert.deepEqual(
      valid.moves.map((move) => move.to),
      ["plot-main-s-4", "plot-market-s-5"],
    );

    writeFileSync(
      map,
      JSON.stringify({
        status: "reviewed",
        moves: [{ from: "plot-main-n-2", to: "plot-main-n-3" }],
      }),
    );
    assert.throws(
      () => readActiveVersion2Release(root, release, deployment),
      /deed map changed/,
    );

    writeFileSync(
      map,
      JSON.stringify({
        status: "reviewed",
        moves: [
          { from: "plot-main-n-2", to: "plot-main-s-4" },
          { from: "plot-market-n-1", to: "plot-market-s-5" },
        ],
      }),
    );
    writeFileSync(seed, '{"version":2,"plots":[1]}\n');
    assert.throws(
      () => readActiveVersion2Release(root, release, deployment),
      /seed changed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
