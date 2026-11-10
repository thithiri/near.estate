import {
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
import type { AssetManifest, PlayerPlot } from "@estate/shared";
import {
  facadeAssetUrl,
  facadePreset,
  PRESET_PALETTES,
} from "./preset-catalog.js";
import { selectNearTextureViews } from "./texture-budget.js";

type FacadeView = {
  plotId: string;
  group: Container;
  x: number;
  spriteUrl: string;
  maskUrl: string | null;
  sprite: Sprite;
  mask: Sprite;
  placeholder: Graphics;
  alive: boolean;
  wanted: boolean;
  loading: boolean;
  loaded: boolean;
  failed: boolean;
  failures: number;
  retryAt: number;
  media: MediaOverlay[];
};

type MediaOverlay = {
  kind: "Logo" | "Billboard";
  url: string;
  sprite: Sprite;
  fallback: Text | null;
  rect: { x: number; y: number; width: number; height: number };
  loading: boolean;
  loaded: boolean;
  failed: boolean;
  failures: number;
  retryAt: number;
};

type CacheEntry = {
  promise: Promise<Texture>;
  loaded: boolean;
  lastUsed: number;
};

const MAX_LOADED_TEXTURES = 32;
const FIRST_RETRY_MS = 15_000;
const MAX_RETRY_MS = 300_000;

function textureRetryDelay(failures: number): number {
  return Math.min(
    FIRST_RETRY_MS * 2 ** Math.min(Math.max(0, failures - 1), 5),
    MAX_RETRY_MS,
  );
}

function centeredText(value: string, x: number, y: number, size: number): Text {
  const text = new Text({
    text: value,
    style: {
      fontFamily: "Arial, sans-serif",
      fontWeight: "bold",
      fontSize: size,
      fill: "#1e2d49",
      align: "center",
    },
  });
  text.anchor.set(0.5);
  text.position.set(x, y);
  return text;
}

function buildingInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1)
    return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase();
  return (words[0] ?? "").slice(0, 2).toUpperCase();
}

export function createPresetFacade(
  plot: PlayerPlot,
  x: number,
  appearance?: {
    level: number;
    palette: string;
    name?: string;
    approvedManifest?: AssetManifest;
    logoAssetHash?: string;
    billboardAssetHash?: string;
  },
): FacadeView {
  // The guest preview shows the four upgrade envelopes. Chain-backed plots
  // supply their actual on-chain type, variant, level, colour and name.
  const level = appearance?.level ?? (plot.index % 4) + 1;
  const preset = facadePreset(plot.initialType, plot.initialVariant, level);
  const palette =
    appearance?.palette ??
    PRESET_PALETTES[plot.index % PRESET_PALETTES.length]!;
  const group = new Container();
  group.position.set(x + 15, 30);
  group.hitArea = new Rectangle(0, 0, 140, 160);
  const placeholder = new Graphics()
    .roundRect(
      7,
      160 - [70, 100, 130, 160][level - 1]!,
      126,
      [70, 100, 130, 160][level - 1]!,
      3,
    )
    .fill(0xe3e6e2)
    .stroke({ color: 0x7b91a2, width: 1 });
  const sprite = new Sprite(Texture.EMPTY);
  const mask = new Sprite(Texture.EMPTY);
  sprite.scale.set(0.25);
  mask.scale.set(0.25);
  mask.tint = Number.parseInt(palette.slice(1), 16);
  group.addChild(placeholder, sprite, mask);

  const logo = appearance?.approvedManifest
    ? appearance.approvedManifest.logoRect
    : preset.logoRect;
  const media: MediaOverlay[] = [];
  if (logo) {
    const initials = buildingInitials(appearance?.name || plot.initialType);
    const fallback = centeredText(
      initials,
      logo.x + logo.width / 2,
      logo.y + logo.height / 2,
      8,
    );
    group.addChild(fallback);
    if (appearance?.logoAssetHash) {
      const image = new Sprite(Texture.EMPTY);
      group.addChild(image);
      media.push({
        kind: "Logo",
        url: `/api/assets/${appearance.logoAssetHash}`,
        sprite: image,
        fallback,
        rect: logo,
        loading: false,
        loaded: false,
        failed: false,
        failures: 0,
        retryAt: 0,
      });
    }
  }
  const billboard = appearance?.approvedManifest
    ? appearance.approvedManifest.billboardRect
    : preset.billboardRect;
  if (billboard && appearance?.billboardAssetHash) {
    const image = new Sprite(Texture.EMPTY);
    group.addChild(image);
    media.push({
      kind: "Billboard",
      url: `/api/assets/${appearance.billboardAssetHash}`,
      sprite: image,
      fallback: null,
      rect: billboard,
      loading: false,
      loaded: false,
      failed: false,
      failures: 0,
      retryAt: 0,
    });
  }
  const name = (appearance?.name || plot.initialType).toUpperCase();
  const nameRect = preset.nameRect;
  const nameSize = Math.min(
    8,
    nameRect.height * 0.7,
    nameRect.width / (name.length * 0.62),
  );
  group.addChild(
    centeredText(
      name,
      nameRect.x + nameRect.width / 2,
      nameRect.y + nameRect.height / 2,
      nameSize,
    ),
  );
  return {
    plotId: plot.id,
    group,
    x,
    spriteUrl: appearance?.approvedManifest
      ? `/api/assets/${appearance.approvedManifest.spriteHash}`
      : facadeAssetUrl(preset.sprite),
    maskUrl: appearance?.approvedManifest
      ? null
      : facadeAssetUrl(preset.paletteMask),
    sprite,
    mask,
    placeholder,
    alive: true,
    wanted: false,
    loading: false,
    loaded: false,
    failed: false,
    failures: 0,
    retryAt: 0,
    media,
  };
}

export class PresetTextureCache {
  private views: FacadeView[] = [];
  private entries = new Map<string, CacheEntry>();
  private retiring = new Map<string, Promise<void>>();
  private pruning = false;

  setViews(views: FacadeView[]): void {
    for (const view of this.views) {
      view.alive = false;
      this.detach(view);
    }
    this.views = views;
  }

  visibleAdSurfaces(
    cameraLeft: number,
    visibleWidth: number,
    visibleHeight: number,
  ): Array<{ plotId: string; surface: "Logo" | "Billboard" }> {
    const right = cameraLeft + visibleWidth;
    const visible: Array<{ plotId: string; surface: "Logo" | "Billboard" }> =
      [];
    for (const view of this.views) {
      if (!view.alive || !view.wanted) continue;
      const overlay = [...view.media].reverse().find((item) => {
        if (!item.loaded || !item.sprite.visible) return false;
        const left = view.x + 15 + item.rect.x;
        const top = 30 + item.rect.y;
        return (
          left >= cameraLeft &&
          left + item.rect.width <= right &&
          top >= 0 &&
          top + item.rect.height <= visibleHeight
        );
      });
      if (overlay) visible.push({ plotId: view.plotId, surface: overlay.kind });
    }
    return visible;
  }

  updateVisible(cameraLeft: number, visibleWidth: number): void {
    const selected = selectNearTextureViews(
      this.views.map((view) => ({
        x: view.x,
        urls: [
          view.spriteUrl,
          ...(view.maskUrl ? [view.maskUrl] : []),
          ...view.media.map((overlay) => overlay.url),
        ],
      })),
      cameraLeft,
      visibleWidth,
      MAX_LOADED_TEXTURES,
    );
    for (const [index, view] of this.views.entries()) {
      const wanted = selected.has(index);
      view.wanted = wanted;
      if (!wanted) {
        this.detach(view);
        continue;
      }
      for (const overlay of view.media) {
        if (
          overlay.loaded ||
          overlay.loading ||
          (overlay.failed && performance.now() < overlay.retryAt)
        )
          continue;
        overlay.failed = false;
        overlay.loading = true;
        void this.load(overlay.url)
          .then((texture) => {
            if (!view.alive || !view.wanted) return;
            overlay.sprite.texture = texture;
            overlay.sprite.position.set(overlay.rect.x, overlay.rect.y);
            overlay.sprite.width = overlay.rect.width;
            overlay.sprite.height = overlay.rect.height;
            if (overlay.fallback) overlay.fallback.visible = false;
            overlay.loaded = true;
            overlay.failures = 0;
            overlay.retryAt = 0;
          })
          .catch((error: unknown) => {
            overlay.failed = true;
            overlay.failures++;
            overlay.retryAt =
              performance.now() + textureRetryDelay(overlay.failures);
            console.warn("Approved media texture unavailable", error);
          })
          .finally(() => {
            overlay.loading = false;
          });
      }
      if (
        view.loaded ||
        view.loading ||
        (view.failed && performance.now() < view.retryAt)
      )
        continue;
      view.failed = false;
      view.loading = true;
      void Promise.all([
        this.load(view.spriteUrl),
        view.maskUrl ? this.load(view.maskUrl) : Promise.resolve(Texture.EMPTY),
      ])
        .then(([sprite, mask]) => {
          if (!view.alive || !view.wanted) return;
          view.sprite.texture = sprite;
          view.mask.texture = mask;
          view.placeholder.visible = false;
          view.loaded = true;
          view.failures = 0;
          view.retryAt = 0;
        })
        .catch((error: unknown) => {
          view.failed = true;
          view.failures++;
          view.retryAt = performance.now() + textureRetryDelay(view.failures);
          console.warn("Facade texture unavailable", error);
        })
        .finally(() => {
          view.loading = false;
        });
    }
    if (this.entries.size > MAX_LOADED_TEXTURES) void this.prune();
  }

  private detach(view: FacadeView): void {
    if (view.loaded) {
      view.sprite.texture = Texture.EMPTY;
      view.mask.texture = Texture.EMPTY;
      view.placeholder.visible = true;
      view.loaded = false;
    }
    for (const overlay of view.media) {
      if (!overlay.loaded) continue;
      overlay.sprite.texture = Texture.EMPTY;
      if (overlay.fallback) overlay.fallback.visible = true;
      overlay.loaded = false;
    }
  }

  private load(url: string): Promise<Texture> {
    const retiring = this.retiring.get(url);
    if (retiring)
      return retiring.catch(() => undefined).then(() => this.load(url));
    const existing = this.entries.get(url);
    if (existing) {
      existing.lastUsed = performance.now();
      return existing.promise;
    }
    const entry: CacheEntry = {
      promise: Assets.load<Texture>(url),
      loaded: false,
      lastUsed: performance.now(),
    };
    this.entries.set(url, entry);
    entry.promise = entry.promise
      .then((texture) => {
        entry.loaded = true;
        return texture;
      })
      .catch((error: unknown) => {
        if (this.entries.get(url) === entry) this.entries.delete(url);
        throw error;
      });
    return entry.promise;
  }

  private async prune(): Promise<void> {
    if (this.pruning) return;
    this.pruning = true;
    try {
      const loaded = [...this.entries].filter(([, entry]) => entry.loaded);
      if (loaded.length <= MAX_LOADED_TEXTURES) return;
      loaded.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [url, entry] of loaded) {
        const loadedCount = [...this.entries.values()].filter(
          (current) => current.loaded,
        ).length;
        if (loadedCount <= MAX_LOADED_TEXTURES) break;
        if (this.entries.get(url) !== entry) continue;
        if (
          this.views.some(
            (view) =>
              view.wanted &&
              (view.spriteUrl === url ||
                view.maskUrl === url ||
                view.media.some((overlay) => overlay.url === url)),
          )
        )
          continue;
        for (const view of this.views) {
          if (
            view.spriteUrl === url ||
            view.maskUrl === url ||
            view.media.some((overlay) => overlay.url === url)
          )
            this.detach(view);
        }
        this.entries.delete(url);
        const retiring = Assets.unload(url);
        this.retiring.set(url, retiring);
        try {
          await retiring;
        } catch (error) {
          console.warn("Could not release facade texture", error);
        } finally {
          this.retiring.delete(url);
        }
      }
    } finally {
      this.pruning = false;
    }
  }
}
