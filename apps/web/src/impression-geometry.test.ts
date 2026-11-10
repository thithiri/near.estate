import assert from "node:assert/strict";
import test from "node:test";
import { createPresetFacade, PresetTextureCache } from "./preset-renderer.js";
import { facadePreset } from "./preset-catalog.js";

test("only fully visible loaded approved media qualifies for exposure", () => {
  const preset = facadePreset("Retail", 1, 1);
  const view = createPresetFacade(
    {
      id: "plot-main-n-0",
      roadId: "main",
      side: "North",
      index: 0,
      corner: true,
      initialType: "Retail",
      initialVariant: 1,
    },
    100,
    {
      level: 1,
      palette: "#F6C85F",
      approvedManifest: {
        schemaVersion: 1,
        renderProfileVersion: 1,
        buildingType: "Retail",
        level: 1,
        spriteHash: preset.spriteHash,
        thumbnailHash: preset.thumbnailHash,
        alphaBounds: preset.alphaBounds,
        logoRect: preset.logoRect,
        billboardRect: preset.billboardRect,
      },
      logoAssetHash: "approved-logo",
      billboardAssetHash: "approved-billboard",
    },
  );
  const cache = new PresetTextureCache();
  cache.setViews([view]);
  view.wanted = true;
  assert.deepEqual(cache.visibleAdSurfaces(0, 500, 300), []);
  const logo = view.media.find((entry) => entry.kind === "Logo");
  const billboard = view.media.find((entry) => entry.kind === "Billboard");
  assert.ok(logo && billboard);
  logo.loaded = true;
  assert.deepEqual(cache.visibleAdSurfaces(0, 500, 300), [
    { plotId: "plot-main-n-0", surface: "Logo" },
  ]);
  const left = view.x + 15 + logo.rect.x;
  assert.deepEqual(cache.visibleAdSurfaces(left + 1, 500, 300), []);
  assert.deepEqual(
    cache.visibleAdSurfaces(0, 500, 30 + logo.rect.y + logo.rect.height - 1),
    [],
  );
  billboard.loaded = true;
  assert.deepEqual(cache.visibleAdSurfaces(0, 500, 300), [
    { plotId: "plot-main-n-0", surface: "Billboard" },
  ]);
});
