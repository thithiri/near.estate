import rawCatalog from "./guest-illustrations.json";
import { choices, paintBuilding, type Choice } from "./frontage-art.js";
import { frontageMediaLayout, type BuildingLevel } from "./frontage-layout.js";

const sprites = new Map(
  rawCatalog.buildings.map((entry) => [
    `${entry.id}:${entry.level}`,
    entry.sprite,
  ]),
);
const images = new Map<string, HTMLImageElement>();
const loading = new Map<string, Promise<void>>();

export function guestBuildingUrl(choice: Choice, level: BuildingLevel): string {
  const sprite = sprites.get(`${choice.id}:${level}`);
  if (!sprite)
    throw new Error(`Missing illustration for ${choice.id} level ${level}`);
  return `${import.meta.env.BASE_URL}guest-buildings/${sprite}`;
}

export function preloadGuestBuilding(
  choice: Choice,
  level: BuildingLevel,
): Promise<void> {
  const url = guestBuildingUrl(choice, level);
  const existing = loading.get(url);
  if (existing) return existing;
  const image = new Image();
  images.set(url, image);
  const task = new Promise<void>((resolve) => {
    image.onload = () => resolve();
    image.onerror = () => resolve();
    image.src = url;
  });
  loading.set(url, task);
  return task;
}

export function paintGuestMedia(
  ctx: CanvasRenderingContext2D,
  choice: Choice,
  level: BuildingLevel,
  logo: ImageBitmap | null,
  selectedBuilding = true,
  ad: ImageBitmap | null = null,
): void {
  const {
    sign,
    logo: mark,
    name,
    billboard,
  } = frontageMediaLayout(choice, level);
  if (ad && billboard) {
    const scale = Math.max(
      billboard.width / ad.width,
      billboard.height / ad.height,
    );
    const width = ad.width * scale;
    const height = ad.height * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(billboard.x, billboard.y, billboard.width, billboard.height);
    ctx.clip();
    ctx.fillStyle = "#fff4d4";
    ctx.fillRect(billboard.x, billboard.y, billboard.width, billboard.height);
    ctx.drawImage(
      ad,
      billboard.x + (billboard.width - width) / 2,
      billboard.y + (billboard.height - height) / 2,
      width,
      height,
    );
    ctx.restore();
  }
  if (choice.units > 1) {
    ctx.fillStyle = "#fff9ed";
    ctx.fillRect(sign.x, sign.y, sign.width, sign.height);
    ctx.strokeStyle = choice.roof;
    ctx.lineWidth = 2;
    ctx.strokeRect(sign.x + 1, sign.y + 1, sign.width - 2, sign.height - 2);
  }
  ctx.fillStyle = choice.trim;
  ctx.fillRect(mark.x, mark.y, mark.width, mark.height);
  if (logo && selectedBuilding) {
    const scale = Math.min(
      (mark.width - 2) / logo.width,
      (mark.height - 2) / logo.height,
    );
    const width = logo.width * scale;
    const height = logo.height * scale;
    ctx.drawImage(
      logo,
      mark.x + (mark.width - width) / 2,
      mark.y + (mark.height - height) / 2,
      width,
      height,
    );
  } else {
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${choice.units === 1 ? 8 : 10}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      choice.name
        .split(" ")
        .map((word) => word[0])
        .join("")
        .slice(0, 2),
      mark.x + mark.width / 2,
      mark.y + mark.height / 2,
    );
  }
  if (name) {
    ctx.fillStyle = "#263a4e";
    ctx.font = `800 ${choice.units === 2 ? 8 : 10}px system-ui`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(
      choice.name.toUpperCase(),
      name.x,
      name.y + name.height / 2,
      name.width,
    );
  }
}

export function paintGuestChoice(
  ctx: CanvasRenderingContext2D,
  choice: Choice,
  level: BuildingLevel,
  logo: ImageBitmap | null,
  selectedBuilding = true,
  ad: ImageBitmap | null = null,
): void {
  const image = images.get(guestBuildingUrl(choice, level));
  if (!image?.complete || image.naturalWidth === 0) {
    paintBuilding(ctx, choice, 0, 190, logo, selectedBuilding, level);
    if (ad) paintGuestMedia(ctx, choice, level, logo, selectedBuilding, ad);
    return;
  }
  ctx.drawImage(image, 0, 0, choice.units * 85, 190);
  paintGuestMedia(ctx, choice, level, logo, selectedBuilding, ad);
}

export function validateGuestIllustrations(): void {
  for (const choice of choices)
    for (const level of [1, 2, 3, 4] as const) guestBuildingUrl(choice, level);
}
