import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "apps/web/public/guest-buildings");
const worldOutput = join(root, "apps/web/public/world");
const catalogPath = join(root, "apps/web/src/guest-illustrations.json");
const illustratedCatalog = JSON.parse(
  await readFile(join(root, "apps/web/src/illustrated-catalog.json"), "utf8"),
);
const heightCaps = [70, 100, 130, 160];
const facadeSideGap = 3;
const check = process.argv.includes("--check");
const buildings = [
  { id: "news-kiosk", units: 1, strip: true },
  { id: "coffee-pod", units: 1, strip: true },
  { id: "townhouse", units: 1, type: "homes", variant: 2 },
  { id: "flower-stall", units: 1, strip: true },
  { id: "bike-repair", units: 1, strip: true },
  { id: "corner-shop", units: 2, type: "retail", variant: 1 },
  { id: "diner", units: 2, type: "restaurant", variant: 1 },
  { id: "glass-studio", units: 2, type: "office", variant: 1 },
  { id: "bookshop", units: 2, strip: true },
  { id: "arcade", units: 2, strip: true },
  { id: "market-hall", units: 3, type: "retail", variant: 2 },
  { id: "garden-bistro", units: 3, type: "restaurant", variant: 2 },
  { id: "office-campus", units: 3, strip: true },
  { id: "food-hall", units: 3, strip: true },
  { id: "craft-works", units: 3, strip: true, maxHorizontalScale: 1.35 },
];
const carBodies = [
  "Hatchback",
  "Sedan",
  "SportsCoupe",
  "SUV",
  "Pickup",
  "Microvan",
];
const carColors = ["Red", "Blue", "Yellow", "Green"];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function save(path, bytes) {
  if (check) {
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error(`Guest art is stale: ${path}`);
  } else await writeFile(path, bytes);
}

async function sourceForBuilding(building, level) {
  if (building.strip) {
    const file = join(
      root,
      `art/source/guest-building-strips/${building.id}.png`,
    );
    const meta = await sharp(file).metadata();
    const left = Math.floor(((level - 1) * meta.width) / 4);
    const right = Math.floor((level * meta.width) / 4);
    return {
      input: await sharp(file)
        .extract({ left, top: 0, width: right - left, height: meta.height })
        .png()
        .toBuffer(),
      source: `guest-building-strips/${building.id}.png#${level}`,
    };
  }
  const entry = illustratedCatalog.facades.find(
    (facade) =>
      facade.type === building.type &&
      facade.variant === building.variant &&
      facade.level === level,
  );
  if (!entry)
    throw new Error(
      `Missing illustrated source for ${building.id} level ${level}`,
    );
  return {
    input: await readFile(
      join(root, "apps/web/public/illustrated", entry.sprite),
    ),
    source: `illustrated/${entry.sprite}`,
  };
}

async function fitTransparent(
  input,
  canvasWidth,
  canvasHeight,
  artWidth,
  artHeight,
  maxHorizontalScale = Number.POSITIVE_INFINITY,
) {
  const trimmed = await sharp(input).ensureAlpha().trim().png().toBuffer();
  const contained = await sharp(trimmed)
    .resize({ width: artWidth, height: artHeight, fit: "inside" })
    .png()
    .toBuffer();
  const containedMeta = await sharp(contained).metadata();
  // A wide parcel should not turn Craft Works' garage doors and windows into
  // long horizontal bars. Allow a modest adjustment, then keep side setbacks.
  const fittedWidth = Math.min(
    artWidth,
    Math.round(containedMeta.width * maxHorizontalScale),
  );
  const fitted =
    fittedWidth === containedMeta.width
      ? contained
      : await sharp(contained)
          .resize({
            width: fittedWidth,
            height: containedMeta.height,
            fit: "fill",
          })
          .png()
          .toBuffer();
  const meta = await sharp(fitted).metadata();
  const left = Math.floor((canvasWidth - meta.width) / 2);
  const top = canvasHeight - meta.height;
  const bytes = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: fitted, left, top }])
    .png({ palette: true, colours: 128, effort: 10 })
    .toBuffer();
  return {
    bytes,
    bounds: {
      x: left / 4,
      y: top / 4,
      width: meta.width / 4,
      height: meta.height / 4,
    },
  };
}

await mkdir(output, { recursive: true });
await mkdir(worldOutput, { recursive: true });
const entries = [];
for (const building of buildings) {
  for (let level = 1; level <= 4; level++) {
    const { input, source } = await sourceForBuilding(building, level);
    const { bytes, bounds } = await fitTransparent(
      input,
      building.units * 85 * 4,
      190 * 4,
      (building.units * 85 - facadeSideGap * 2) * 4,
      heightCaps[level - 1] * 4,
      building.maxHorizontalScale,
    );
    const sprite = `${building.id}-l${level}.png`;
    await save(join(output, sprite), bytes);
    entries.push({
      id: building.id,
      units: building.units,
      level,
      sprite,
      source,
      sha256: digest(bytes),
      alphaBounds: bounds,
    });
  }
}
const cars = [];
for (const body of carBodies) {
  const bodySlug = body.toLowerCase();
  const source = `guest-car-strips/${bodySlug}.png`;
  const strip = join(root, "art/source", source);
  const meta = await sharp(strip).metadata();
  for (const [index, color] of carColors.entries()) {
    const left = Math.floor((index * meta.width) / 4);
    const right = Math.floor(((index + 1) * meta.width) / 4);
    const input = await sharp(strip)
      .extract({ left, top: 0, width: right - left, height: meta.height })
      .png()
      .toBuffer();
    const { bytes } = await fitTransparent(input, 256, 128, 248, 124);
    const sprite = `guest-${bodySlug}-${color.toLowerCase()}.png`;
    await save(join(worldOutput, sprite), bytes);
    cars.push({ body, color, sprite, source, sha256: digest(bytes) });
  }
}
await save(
  catalogPath,
  Buffer.from(
    `${JSON.stringify({ version: 1, buildings: entries, cars }, null, 2)}\n`,
  ),
);
console.log(
  `${check ? "Checked" : "Prepared"} ${entries.length} illustrated buildings and ${cars.length} cars.`,
);
