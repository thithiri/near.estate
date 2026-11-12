import { Assets, Container, Rectangle, Sprite, Texture } from "pixi.js";
import { choices, paintBuilding, type Choice } from "./frontage-art.js";
import type { PlayerPlot } from "@estate/shared";
import type { BuildingLevel } from "./frontage-layout.js";
import { frontageMediaLayout, type ArtRect } from "./frontage-layout.js";
import { guestBuildingUrl, paintGuestMedia } from "./guest-illustration.js";

const textures = new Map<string, Texture>();
const logoTextures = new WeakMap<ImageBitmap, Map<string, Texture>>();
const coveredAds = new Map<string, Promise<Texture>>();

function coveredAdTexture(
  url: string,
  width: number,
  height: number,
): Promise<Texture> {
  const key = `${url}:${width}x${height}`;
  const cached = coveredAds.get(key);
  if (cached) return cached;
  const task = (async () => {
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
  })();
  coveredAds.set(key, task);
  void task.catch(() => coveredAds.delete(key));
  return task;
}

export type GuestFrontage = Container & {
  customFacadeSprite: Sprite;
  mediaViews: Array<{
    kind: "Logo" | "Billboard";
    rect: ArtRect;
    sprite: Sprite;
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
  const cache = logo
    ? (logoTextures.get(logo) ?? new Map<string, Texture>())
    : textures;
  if (logo && !logoTextures.has(logo)) logoTextures.set(logo, cache);
  const textureKey = `${choice.id}:level-${level}:name-${displayedChoice.name}`;
  let texture = cache.get(textureKey);
  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = choice.units * 85;
    canvas.height = 190;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Building canvas is unavailable");
    paintBuilding(context, displayedChoice, 0, 190, logo, true, level);
    texture = Texture.from(canvas);
    cache.set(textureKey, texture);
  }
  const group = new Container() as GuestFrontage;
  group.mediaViews = [];
  group.x = x;
  group.hitArea = new Rectangle(0, 0, choice.units * 85, 190);
  const fallback = new Sprite(texture);
  const illustration = new Sprite(Texture.EMPTY);
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
    group.mediaViews.push({ kind, rect, sprite: media });
    const url = `/api/assets/${hash}`;
    const image =
      kind === "Billboard"
        ? coveredAdTexture(url, rect.width, rect.height)
        : Assets.load<Texture>({ alias: url, src: url, parser: "texture" });
    void image
      .then((loaded) => {
        if (group.destroyed) return;
        media.texture = loaded;
        media.width = rect.width;
        media.height = rect.height;
        media.visible = true;
      })
      .catch((error: unknown) => {
        console.warn("Approved building media unavailable", error);
      });
  }
  void Assets.load<Texture>(guestBuildingUrl(choice, level))
    .then((loaded) => {
      if (group.destroyed) return;
      if (loaded.width !== choice.units * 85 * 4 || loaded.height !== 190 * 4)
        throw new Error("Guest building illustration has the wrong dimensions");
      illustration.texture = loaded;
      fallback.visible = false;
      overlay.visible = true;
    })
    .catch((error: unknown) => {
      console.warn("Guest building illustration unavailable", error);
    });
  if (customFacadeHash) {
    const url = `/api/assets/${customFacadeHash}`;
    void Assets.load<Texture>({ alias: url, src: url, parser: "texture" })
      .then((loaded) => {
        if (group.destroyed) return;
        if (loaded.width !== choice.units * 85 * 4 || loaded.height !== 190 * 4)
          throw new Error("Approved facade image has the wrong dimensions");
        customFacade.texture = loaded;
        customFacade.visible = true;
        illustration.visible = false;
        fallback.visible = false;
        overlay.visible = true;
      })
      .catch((error: unknown) => {
        console.warn("Approved building facade unavailable", error);
      });
  }
  return group;
}
