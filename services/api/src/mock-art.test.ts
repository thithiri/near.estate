import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BuildingType,
  canonicalJson,
  validateAssetManifest,
} from "@estate/shared";
import { renderMockCandidate } from "./mock-art.js";

test("every player building type, shape and level makes a valid immutable bundle", async () => {
  const hashes = new Set<string>();
  for (const buildingType of BuildingType.options) {
    for (const variant of [1, 2] as const) {
      for (let level = 1; level <= 4; level++) {
        const art = await renderMockCandidate(
          buildingType,
          variant,
          level,
          "#73D9A6",
        );
        assert.deepEqual(validateAssetManifest(art.manifest), art.manifest);
        assert.equal(art.manifest.buildingType, buildingType);
        assert.equal(art.manifest.level, level);
        assert.equal(
          createHash("sha256").update(art.sprite).digest("hex"),
          art.spriteHash,
        );
        assert.equal(
          createHash("sha256").update(art.thumbnail).digest("hex"),
          art.thumbnailHash,
        );
        assert.equal(
          createHash("sha256")
            .update(canonicalJson(art.manifest))
            .digest("hex"),
          art.manifestHash,
        );
        assert.ok(!hashes.has(art.manifestHash));
        hashes.add(art.manifestHash);
      }
    }
  }
  assert.equal(hashes.size, 40);
});
