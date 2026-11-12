import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import prettier from "prettier";
import { validateCitySeed } from "@estate/shared";
import { createGuestCity } from "../apps/web/src/guest-city.js";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "contracts/estate/seed.json");
const targetPath = resolve(root, "contracts/estate/seed-v2.json");
const source = validateCitySeed(JSON.parse(await readFile(sourcePath, "utf8")));
assert.equal(source.version, 1);
const city = createGuestCity(source);
assert.equal(city.version, 2);
assert.equal(city.plots.length, 100);
const bytes = await prettier.format(JSON.stringify(city), { parser: "json" });
if (process.argv.includes("--check")) {
  assert.ok(
    (await readFile(targetPath, "utf8")) === bytes,
    "V2 city seed is stale",
  );
  console.log("Checked the version-2 city seed: 100 plots, 180 curb spaces.");
} else {
  await writeFile(targetPath, bytes);
  console.log("Prepared the version-2 city seed: 100 plots, 180 curb spaces.");
}
