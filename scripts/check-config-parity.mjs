import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../packages/shared/dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = execFileSync(
  "cargo",
  [
    "run",
    "--quiet",
    "-p",
    "near-estate-contract",
    "--example",
    "default_config_json",
  ],
  { cwd: root, encoding: "utf8" },
);
const rustDefaults = JSON.parse(output);
const camel = (key) =>
  key.replaceAll(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const contractDefaults = Object.fromEntries(
  Object.entries(rustDefaults).map(([key, value]) => [camel(key), value]),
);
const { maxEarningCars, ...clientDefaults } = DEFAULT_CONFIG;
assert.equal(maxEarningCars, 1, "the fixed one-session limit changed");
assert.deepStrictEqual(
  clientDefaults,
  contractDefaults,
  "client defaults differ from the Rust contract defaults",
);
console.log(
  `Config parity verified: ${Object.keys(contractDefaults).length} contract defaults match the client`,
);
