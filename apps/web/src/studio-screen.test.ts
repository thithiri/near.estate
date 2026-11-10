import assert from "node:assert/strict";
import test from "node:test";
import { PRESET_PALETTES } from "./preset-catalog.js";
import { presetCandidates } from "./studio-screen.js";

test("studio offers three distinct valid preset looks", () => {
  for (const variant of [1, 2] as const) {
    for (const palette of PRESET_PALETTES) {
      const candidates = presetCandidates(variant, palette);
      assert.equal(candidates.length, 3);
      assert.equal(
        new Set(candidates.map((entry) => `${entry.variant}:${entry.palette}`))
          .size,
        3,
      );
      assert.ok(
        candidates.every((entry) =>
          PRESET_PALETTES.includes(
            entry.palette as (typeof PRESET_PALETTES)[number],
          ),
        ),
      );
    }
  }
});
