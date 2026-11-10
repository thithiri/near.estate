import assert from "node:assert/strict";
import test from "node:test";
import { validateAssetManifest } from "@estate/shared";
import rawCatalog from "./preset-catalog.json";
import { facadePreset, PRESET_PALETTES } from "./preset-catalog.js";

test("every building type, variant and level has a valid asset manifest", () => {
  assert.equal(rawCatalog.facades.length, 40);
  for (const buildingType of [
    "Retail",
    "Cafe",
    "Restaurant",
    "Office",
    "Homes",
  ]) {
    for (const variant of [1, 2]) {
      for (const level of [1, 2, 3, 4]) {
        const preset = facadePreset(buildingType, variant, level);
        const validated = validateAssetManifest({
          schemaVersion: 1,
          renderProfileVersion: 1,
          buildingType: preset.buildingType,
          level: preset.level,
          spriteHash: preset.spriteHash,
          thumbnailHash: preset.thumbnailHash,
          alphaBounds: preset.alphaBounds,
          logoRect: preset.logoRect,
          billboardRect: preset.billboardRect,
        });
        assert.equal(validated.buildingType, buildingType);
        assert.equal(validated.level, level);
      }
    }
  }
  assert.deepEqual(PRESET_PALETTES, [
    "#EF8270",
    "#69B9E9",
    "#73D9A6",
    "#F6C85F",
  ]);
});
