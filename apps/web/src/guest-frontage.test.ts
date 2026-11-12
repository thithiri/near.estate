import assert from "node:assert/strict";
import test from "node:test";
import { Assets, Container, Sprite, Texture, TextureSource } from "pixi.js";
import {
  GuestFrontageTextureCache,
  type GuestFrontage,
} from "./guest-frontage.js";

function frontage(id: number): GuestFrontage {
  const group = new Container() as GuestFrontage;
  group.illustrationUrl = `/guest-buildings/test-${id}.png`;
  group.customFacadeUrl = null;
  group.illustrationState = {
    loading: false,
    loaded: false,
    failures: 0,
    retryAt: 0,
  };
  group.customFacadeState = {
    loading: false,
    loaded: false,
    failures: 0,
    retryAt: 0,
  };
  group.wanted = false;
  group.fallbackSprite = new Sprite(Texture.EMPTY);
  group.illustrationSprite = new Sprite(Texture.EMPTY);
  group.customFacadeSprite = new Sprite(Texture.EMPTY);
  group.customFacadeSprite.visible = false;
  group.overlaySprite = new Sprite(Texture.EMPTY);
  group.overlaySprite.visible = false;
  group.mediaViews = [];
  group.addChild(
    group.fallbackSprite,
    group.illustrationSprite,
    group.customFacadeSprite,
    group.overlaySprite,
  );
  return group;
}

async function flush(): Promise<void> {
  await new Promise((done) => setTimeout(done, 0));
}

test("guest facades load near the camera and release old street textures", async () => {
  const realLoad = Assets.load;
  const realUnload = Assets.unload;
  const loaded: string[] = [];
  const unloaded: string[] = [];
  Assets.load = (async (request: unknown) => {
    assert.equal(typeof request, "string");
    loaded.push(request as string);
    return new Texture({
      source: new TextureSource({ width: 340, height: 760 }),
    });
  }) as typeof Assets.load;
  Assets.unload = (async (url: string) => {
    unloaded.push(url);
  }) as typeof Assets.unload;
  try {
    const cache = new GuestFrontageTextureCache();
    const near = frontage(0);
    const far = frontage(1);
    cache.setViews([
      { x: 0, width: 85, group: near },
      { x: 1000, width: 85, group: far },
    ]);
    cache.updateVisible(0, 100);
    await flush();
    assert.deepEqual(loaded, [near.illustrationUrl]);
    assert.equal(near.fallbackSprite.visible, false);
    assert.equal(far.fallbackSprite.visible, true);

    const firstStreet = Array.from({ length: 32 }, (_, index) =>
      frontage(index + 2),
    );
    cache.setViews(firstStreet.map((group) => ({ x: 0, width: 85, group })));
    cache.updateVisible(0, 100);
    await flush();
    const secondStreet = Array.from({ length: 32 }, (_, index) =>
      frontage(index + 34),
    );
    cache.setViews(secondStreet.map((group) => ({ x: 0, width: 85, group })));
    cache.updateVisible(0, 100);
    await flush();
    cache.updateVisible(0, 100);
    await flush();
    assert.ok(unloaded.includes(near.illustrationUrl));
    assert.ok(
      firstStreet.every((group) => unloaded.includes(group.illustrationUrl)),
    );
    assert.ok(secondStreet.every((group) => group.illustrationState.loaded));
  } finally {
    Assets.load = realLoad;
    Assets.unload = realUnload;
  }
});

test("a failed approved facade keeps the illustrated building until retry", async () => {
  const realLoad = Assets.load;
  const realWarn = console.warn;
  let customAttempts = 0;
  const hash = "a".repeat(64);
  const customUrl = `/api/assets/${hash}`;
  Assets.load = (async (request: unknown) => {
    const url =
      typeof request === "string"
        ? request
        : (request as { alias: string }).alias;
    if (url === customUrl && ++customAttempts === 1)
      throw new Error("Temporary media outage");
    return new Texture({
      source: new TextureSource({ width: 340, height: 760 }),
    });
  }) as typeof Assets.load;
  console.warn = () => undefined;
  try {
    const group = frontage(99);
    group.customFacadeUrl = customUrl;
    const cache = new GuestFrontageTextureCache();
    cache.setViews([{ x: 0, width: 85, group }]);
    cache.updateVisible(0, 100);
    await flush();
    assert.equal(group.illustrationState.loaded, true);
    assert.equal(group.illustrationSprite.visible, true);
    assert.equal(group.customFacadeState.loaded, false);
    assert.equal(group.fallbackSprite.visible, false);
    group.customFacadeState.retryAt = 0;
    cache.updateVisible(0, 100);
    await flush();
    assert.equal(customAttempts, 2);
    assert.equal(group.customFacadeState.loaded, true);
    assert.equal(group.customFacadeSprite.visible, true);
    assert.equal(group.illustrationSprite.visible, false);
  } finally {
    Assets.load = realLoad;
    console.warn = realWarn;
  }
});
