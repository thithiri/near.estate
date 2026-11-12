import { Assets, Container, Rectangle, Sprite, Texture } from "pixi.js";
import { choices, paintBuilding, type Choice } from "./frontage-art.js";
import type { PlayerPlot } from "@estate/shared";
import type { BuildingLevel } from "./frontage-layout.js";
import { frontageMediaLayout, type ArtRect } from "./frontage-layout.js";
import { guestBuildingUrl, paintGuestMedia } from "./guest-illustration.js";
import { selectNearTextureViews } from "./texture-budget.js";

const MAX_LOADED_TEXTURES = 32;
const FIRST_RETRY_MS = 15_000;
const MAX_RETRY_MS = 300_000;

function textureRetryDelay(failures: number): number {
  return Math.min(
    FIRST_RETRY_MS * 2 ** Math.min(Math.max(0, failures - 1), 5),
    MAX_RETRY_MS,
  );
}

async function coveredAdTexture(
  url: string,
  width: number,
  height: number,
): Promise<Texture> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Approved ad unavailable (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width * 4;
    canvas.height = height * 4;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Ad canvas is unavailable");
    const sourceWidth = Math.min(
      bitmap.width,
      bitmap.height * (width / height),
    );
    const sourceHeight = Math.min(
      bitmap.height,
      bitmap.width * (height / width),
    );
    context.drawImage(
      bitmap,
      (bitmap.width - sourceWidth) / 2,
      (bitmap.height - sourceHeight) / 2,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return Texture.from(canvas);
  } finally {
    bitmap.close();
  }
}

type LoadState = {
  loading: boolean;
  loaded: boolean;
  failures: number;
  retryAt: number;
};

function loadState(): LoadState {
  return { loading: false, loaded: false, failures: 0, retryAt: 0 };
}

type CachedTexture = {
  promise: Promise<Texture>;
  loaded: boolean;
  texture: Texture | null;
  lastUsed: number;
  kind: "Image" | "CoveredAd";
  url: string;
};

export type GuestFrontage = Container & {
  fallbackSprite: Sprite;
  illustrationSprite: Sprite;
  customFacadeSprite: Sprite;
  overlaySprite: Sprite;
  illustrationUrl: string;
  customFacadeUrl: string | null;
  illustrationState: LoadState;
  customFacadeState: LoadState;
  wanted: boolean;
  mediaViews: Array<{
    kind: "Logo" | "Billboard";
    rect: ArtRect;
    sprite: Sprite;
    url: string;
    key: string;
    state: LoadState;
  }>;
};

export function choiceForGuestPlot(
  plot: PlayerPlot,
  selected?: string,
): Choice {
  const width = plot.frontageUnits ?? 2;
  const eligible = choices.filter((choice) => choice.units === width);
  const chosen = selected
    ? eligible.find((choice) => choice.id === selected)
    : null;
  if (selected && !chosen)
    throw new Error("Building design does not fit this plot");
  const roadOrder = ["main", "market", "river", "central", "harbor"].indexOf(
    plot.roadId,
  );
  const fallback =
    eligible[
      (plot.index * 2 + roadOrder + (plot.side === "South" ? 1 : 0)) %
        eligible.length
    ];
  if (!fallback) throw new Error("No building design fits this plot");
  return chosen ?? fallback;
}

export function createGuestFrontage(
  choice: Choice,
  x: number,
  level: BuildingLevel,
  logo: ImageBitmap | null = null,
  displayName?: string,
  approvedMedia?: { logoHash?: string; billboardHash?: string },
  customFacadeHash?: string,
  adPreview: ImageBitmap | null = null,
): GuestFrontage {
  const displayedChoice = displayName
    ? { ...choice, name: displayName }
    : choice;
  const canvas = document.createElement("canvas");
  canvas.width = choice.units * 85;
  canvas.height = 190;
  const fallbackContext = canvas.getContext("2d");
  if (!fallbackContext) throw new Error("Building canvas is unavailable");
  paintBuilding(fallbackContext, displayedChoice, 0, 190, logo, true, level);
  const group = new Container() as GuestFrontage;
  group.mediaViews = [];
  group.illustrationUrl = guestBuildingUrl(choice, level);
  group.customFacadeUrl = customFacadeHash
    ? `/api/assets/${customFacadeHash}`
    : null;
  group.illustrationState = loadState();
  group.customFacadeState = loadState();
  group.wanted = false;
  group.x = x;
  group.hitArea = new Rectangle(0, 0, choice.units * 85, 190);
  const fallback = new Sprite(Texture.from(canvas));
  group.fallbackSprite = fallback;
  const illustration = new Sprite(Texture.EMPTY);
  group.illustrationSprite = illustration;
  illustration.scale.set(0.25);
  const customFacade = new Sprite(Texture.EMPTY);
  customFacade.scale.set(0.25);
  customFacade.visible = false;
  group.customFacadeSprite = customFacade;
  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = choice.units * 85;
  overlayCanvas.height = 190;
  const context = overlayCanvas.getContext("2d");
  if (!context) throw new Error("Building overlay canvas is unavailable");
  paintGuestMedia(context, displayedChoice, level, logo, true, adPreview);
  const overlay = new Sprite(Texture.from(overlayCanvas));
  group.overlaySprite = overlay;
  overlay.visible = Boolean(adPreview);
  group.addChild(fallback, illustration, customFacade, overlay);
  const layout = frontageMediaLayout(choice, level);
  const approvedLogoRect = {
    x: layout.logo.x + 1,
    y: layout.logo.y + 1,
    width: layout.logo.width - 2,
    height: layout.logo.height - 2,
  };
  for (const [kind, hash, rect] of [
    ["Logo", approvedMedia?.logoHash, approvedLogoRect],
    ["Billboard", approvedMedia?.billboardHash, layout.billboard],
  ] as const) {
    if (!hash || !rect) continue;
    const media = new Sprite(Texture.EMPTY);
    media.position.set(rect.x, rect.y);
    media.width = rect.width;
    media.height = rect.height;
    media.visible = false;
    group.addChild(media);
    const url = `/api/assets/${hash}`;
    group.mediaViews.push({
      kind,
      rect,
      sprite: media,
      url,
      key: kind === "Billboard" ? `${url}:${rect.width}x${rect.height}` : url,
      state: loadState(),
    });
  }
  return group;
}

export type GuestFrontageView = {
  x: number;
  width: number;
  group: GuestFrontage;
};

function assetKeys(group: GuestFrontage): string[] {
  return [
    group.illustrationUrl,
    ...(group.customFacadeUrl ? [group.customFacadeUrl] : []),
    ...group.mediaViews.map((media) => media.key),
  ];
}

export class GuestFrontageTextureCache {
  private views: GuestFrontageView[] = [];
  private entries = new Map<string, CachedTexture>();
  private retiring = new Map<string, Promise<void>>();
  private pruning = false;

  stats(): {
    currentFacades: number;
    cachedImages: number;
    loadedImages: number;
    estimatedDecodedBytes: number;
  } {
    const loaded = [...this.entries.values()].filter(
      (entry): entry is CachedTexture & { texture: Texture } =>
        entry.loaded && entry.texture !== null,
    );
    return {
      currentFacades: this.views.length,
      cachedImages: this.entries.size,
      loadedImages: loaded.length,
      estimatedDecodedBytes: loaded.reduce(
        (total, entry) =>
          total + entry.texture.width * entry.texture.height * 4,
        0,
      ),
    };
  }

  setViews(views: GuestFrontageView[]): void {
    for (const view of this.views) {
      view.group.wanted = false;
      this.detach(view.group);
      for (const sprite of [
        view.group.fallbackSprite,
        view.group.overlaySprite,
      ]) {
        const texture = sprite.texture;
        sprite.texture = Texture.EMPTY;
        if (texture !== Texture.EMPTY) texture.destroy(true);
      }
    }
    this.views = views;
  }

  updateVisible(cameraLeft: number, visibleWidth: number): void {
    const selected = selectNearTextureViews(
      this.views.map((view) => ({
        x: view.x,
        width: view.width,
        urls: assetKeys(view.group),
      })),
      cameraLeft,
      visibleWidth,
      MAX_LOADED_TEXTURES,
    );
    for (const [index, view] of this.views.entries()) {
      const group = view.group;
      const wasWanted = group.wanted;
      group.wanted = selected.has(index);
      if (!group.wanted || group.destroyed) {
        if (wasWanted) this.detach(group);
        continue;
      }
      for (const key of assetKeys(group)) {
        const cached = this.entries.get(key);
        if (cached) cached.lastUsed = performance.now();
      }
      this.ensure(
        group,
        group.illustrationState,
        group.illustrationUrl,
        group.illustrationUrl,
        "Image",
        (texture) => {
          if (texture.width !== view.width * 4 || texture.height !== 190 * 4)
            throw new Error(
              "Guest building illustration has the wrong dimensions",
            );
          group.illustrationSprite.texture = texture;
          group.illustrationSprite.visible = !group.customFacadeSprite.visible;
          group.fallbackSprite.visible = false;
          group.overlaySprite.visible = true;
        },
      );
      if (group.customFacadeUrl)
        this.ensure(
          group,
          group.customFacadeState,
          group.customFacadeUrl,
          group.customFacadeUrl,
          "Image",
          (texture) => {
            if (texture.width !== view.width * 4 || texture.height !== 190 * 4)
              throw new Error("Approved facade image has the wrong dimensions");
            group.customFacadeSprite.texture = texture;
            group.customFacadeSprite.visible = true;
            group.illustrationSprite.visible = false;
            group.fallbackSprite.visible = false;
            group.overlaySprite.visible = true;
          },
        );
      for (const media of group.mediaViews)
        this.ensure(
          group,
          media.state,
          media.key,
          media.url,
          media.kind === "Billboard" ? "CoveredAd" : "Image",
          (texture) => {
            media.sprite.texture = texture;
            media.sprite.width = media.rect.width;
            media.sprite.height = media.rect.height;
            media.sprite.visible = true;
          },
          media.rect,
        );
    }
    if (this.entries.size > MAX_LOADED_TEXTURES) void this.prune();
  }

  private detach(group: GuestFrontage): void {
    group.illustrationSprite.texture = Texture.EMPTY;
    group.illustrationSprite.visible = true;
    group.customFacadeSprite.texture = Texture.EMPTY;
    group.customFacadeSprite.visible = false;
    group.fallbackSprite.visible = true;
    group.overlaySprite.visible = false;
    group.illustrationState.loaded = false;
    group.customFacadeState.loaded = false;
    for (const media of group.mediaViews) {
      media.sprite.texture = Texture.EMPTY;
      media.sprite.visible = false;
      media.state.loaded = false;
    }
  }

  private ensure(
    group: GuestFrontage,
    state: LoadState,
    key: string,
    url: string,
    kind: CachedTexture["kind"],
    apply: (texture: Texture) => void,
    rect?: ArtRect,
  ): void {
    if (
      state.loaded ||
      state.loading ||
      (state.failures > 0 && performance.now() < state.retryAt)
    )
      return;
    state.loading = true;
    void this.load(key, url, kind, rect)
      .then((texture) => {
        if (group.destroyed || !group.wanted) return;
        apply(texture);
        state.loaded = true;
        state.failures = 0;
        state.retryAt = 0;
      })
      .catch((error: unknown) => {
        state.failures++;
        state.retryAt = performance.now() + textureRetryDelay(state.failures);
        console.warn("Guest building asset unavailable", error);
      })
      .finally(() => {
        state.loading = false;
      });
  }

  private load(
    key: string,
    url: string,
    kind: CachedTexture["kind"],
    rect?: ArtRect,
  ): Promise<Texture> {
    const retiring = this.retiring.get(key);
    if (retiring)
      return retiring
        .catch(() => undefined)
        .then(() => this.load(key, url, kind, rect));
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsed = performance.now();
      return existing.promise;
    }
    const promise =
      kind === "CoveredAd"
        ? coveredAdTexture(url, rect!.width, rect!.height)
        : Assets.load<Texture>(
            url.startsWith("/api/assets/")
              ? { alias: url, src: url, parser: "texture" }
              : url,
          );
    const entry: CachedTexture = {
      promise,
      loaded: false,
      texture: null,
      lastUsed: performance.now(),
      kind,
      url,
    };
    this.entries.set(key, entry);
    entry.promise = promise
      .then((texture) => {
        entry.loaded = true;
        entry.texture = texture;
        return texture;
      })
      .catch((error: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    return entry.promise;
  }

  private async prune(): Promise<void> {
    if (this.pruning) return;
    this.pruning = true;
    try {
      const loaded = [...this.entries].filter(([, entry]) => entry.loaded);
      loaded.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      let loadedCount = loaded.length;
      for (const [key, entry] of loaded) {
        if (loadedCount <= MAX_LOADED_TEXTURES) break;
        if (this.entries.get(key) !== entry) continue;
        if (
          this.views.some(
            (view) => view.group.wanted && assetKeys(view.group).includes(key),
          )
        )
          continue;
        this.entries.delete(key);
        loadedCount--;
        const retiring =
          entry.kind === "CoveredAd"
            ? Promise.resolve().then(() => {
                if (entry.texture && entry.texture !== Texture.EMPTY)
                  entry.texture.destroy(true);
              })
            : Assets.unload(entry.url);
        this.retiring.set(key, retiring);
        try {
          await retiring;
        } catch (error) {
          console.warn("Could not release guest building texture", error);
        } finally {
          this.retiring.delete(key);
        }
      }
    } finally {
      this.pruning = false;
    }
  }
}
