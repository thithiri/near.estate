import assert from "node:assert/strict";
import test from "node:test";
import { Assets, Texture } from "pixi.js";
import type { AssetManifest, PlayerPlot } from "@estate/shared";
import { createPresetFacade, PresetTextureCache } from "./preset-renderer.js";

test("facade and approved logo recover after a temporary image failure", async () => {
  const originalLoad = Assets.load;
  const originalWarn = console.warn;
  const attempts = new Map<string, number>();
  Assets.load = (async (request: unknown) => {
    const url =
      typeof request === "string"
        ? request
        : (request as { alias: string; src: string; parser: string }).alias;
    if (url.startsWith("/api/assets/"))
      assert.deepEqual(request, {
        alias: url,
        src: url,
        parser: "texture",
      });
    const count = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, count);
    if (count === 1) throw new Error("temporary image outage");
    return Texture.EMPTY;
  }) as typeof Assets.load;
  console.warn = () => undefined;
  try {
    const hash = "a".repeat(64);
    const plot: PlayerPlot = {
      id: "plot-main-n-0",
      roadId: "main",
      side: "North",
      index: 0,
      corner: true,
      initialType: "Retail",
      initialVariant: 1,
    };
    const manifest: AssetManifest = {
      schemaVersion: 1,
      renderProfileVersion: 1,
      buildingType: "Retail",
      level: 1,
      spriteHash: hash,
      thumbnailHash: hash,
      alphaBounds: { x: 0, y: 90, width: 140, height: 70 },
      logoRect: { x: 20, y: 110, width: 20, height: 20 },
      billboardRect: null,
    };
    const view = createPresetFacade(plot, 0, {
      level: 1,
      palette: "#F6C85F",
      approvedManifest: manifest,
      logoAssetHash: hash,
    });
    const cache = new PresetTextureCache();
    cache.setViews([view]);
    cache.updateVisible(0, 300);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(view.failed, true);
    assert.equal(view.media[0]?.failed, true);
    cache.updateVisible(0, 300);
    assert.equal(attempts.get(view.spriteUrl), 1);
    assert.equal(attempts.get(view.media[0]!.url), 1);
    view.retryAt = 0;
    view.media[0]!.retryAt = 0;
    cache.updateVisible(0, 300);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(view.loaded, true);
    assert.equal(view.media[0]?.loaded, true);
    assert.equal(view.failed, false);
    assert.equal(view.media[0]?.failed, false);
    assert.equal(attempts.get(view.spriteUrl), 2);
    assert.equal(attempts.get(view.media[0]!.url), 2);
  } finally {
    Assets.load = originalLoad;
    console.warn = originalWarn;
  }
});
