import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "art", "source", "illustrated");
const outputDir = path.join(root, "apps", "web", "public", "illustrated");
const catalogPath = path.join(
  root,
  "apps",
  "web",
  "src",
  "illustrated-catalog.json",
);
const facades = [
  {
    type: "retail",
    variant: 1,
    level: 1,
    source: "retail-corner-l1-source.png",
    sprite: "retail-corner-l1.png",
  },
  {
    type: "retail",
    variant: 1,
    source: "retail-source.png",
    sprite: "retail-l2.png",
  },
  {
    type: "retail",
    variant: 1,
    level: 3,
    source: "retail-corner-l3-source.png",
    sprite: "retail-corner-l3.png",
  },
  {
    type: "retail",
    variant: 1,
    level: 4,
    source: "retail-corner-l4-source.png",
    sprite: "retail-corner-l4.png",
  },
  {
    type: "retail",
    variant: 2,
    level: 1,
    source: "retail-market-l1-source.png",
    sprite: "retail-market-l1.png",
  },
  {
    type: "retail",
    variant: 2,
    source: "retail-market-source.png",
    sprite: "retail-market-l2.png",
  },
  {
    type: "retail",
    variant: 2,
    level: 3,
    source: "retail-market-l3-source.png",
    sprite: "retail-market-l3.png",
  },
  {
    type: "retail",
    variant: 2,
    level: 4,
    source: "retail-market-l4-source.png",
    sprite: "retail-market-l4.png",
  },
  {
    type: "cafe",
    variant: 1,
    level: 1,
    source: "cafe-glasshouse-l1-source.png",
    sprite: "cafe-glasshouse-l1.png",
  },
  {
    type: "cafe",
    variant: 1,
    source: "cafe-source.png",
    sprite: "cafe-l2.png",
  },
  {
    type: "cafe",
    variant: 1,
    level: 3,
    source: "cafe-glasshouse-l3-source.png",
    sprite: "cafe-glasshouse-l3.png",
  },
  {
    type: "cafe",
    variant: 1,
    level: 4,
    source: "cafe-glasshouse-l4-source.png",
    sprite: "cafe-glasshouse-l4.png",
  },
  {
    type: "cafe",
    variant: 2,
    level: 1,
    source: "cafe-pergola-l1-source.png",
    sprite: "cafe-pergola-l1.png",
  },
  {
    type: "cafe",
    variant: 2,
    source: "cafe-pergola-source.png",
    sprite: "cafe-pergola-l2.png",
  },
  {
    type: "cafe",
    variant: 2,
    level: 3,
    source: "cafe-pergola-l3-source.png",
    sprite: "cafe-pergola-l3.png",
  },
  {
    type: "cafe",
    variant: 2,
    level: 4,
    source: "cafe-pergola-l4-source.png",
    sprite: "cafe-pergola-l4.png",
  },
  {
    type: "restaurant",
    variant: 1,
    level: 1,
    source: "restaurant-diner-l1-source.png",
    sprite: "restaurant-diner-l1.png",
  },
  {
    type: "restaurant",
    variant: 1,
    source: "restaurant-source.png",
    sprite: "restaurant-l2.png",
  },
  {
    type: "restaurant",
    variant: 2,
    level: 1,
    source: "restaurant-bistro-l1-source.png",
    sprite: "restaurant-bistro-l1.png",
  },
  {
    type: "restaurant",
    variant: 1,
    level: 3,
    source: "restaurant-diner-l3-source.png",
    sprite: "restaurant-diner-l3.png",
  },
  {
    type: "restaurant",
    variant: 1,
    level: 4,
    source: "restaurant-diner-l4-source.png",
    sprite: "restaurant-diner-l4.png",
  },
  {
    type: "restaurant",
    variant: 2,
    source: "restaurant-bistro-source.png",
    sprite: "restaurant-bistro-l2.png",
  },
  {
    type: "restaurant",
    variant: 2,
    level: 3,
    source: "restaurant-bistro-l3-source.png",
    sprite: "restaurant-bistro-l3.png",
  },
  {
    type: "restaurant",
    variant: 2,
    level: 4,
    source: "restaurant-bistro-l4-source.png",
    sprite: "restaurant-bistro-l4.png",
  },
  {
    type: "office",
    variant: 1,
    level: 1,
    source: "office-glass-l1-source.png",
    sprite: "office-glass-l1.png",
  },
  {
    type: "office",
    variant: 1,
    source: "office-source.png",
    sprite: "office-l2.png",
  },
  {
    type: "office",
    variant: 2,
    level: 1,
    source: "office-studio-l1-source.png",
    sprite: "office-studio-l1.png",
  },
  {
    type: "office",
    variant: 1,
    level: 3,
    source: "office-glass-l3-source.png",
    sprite: "office-glass-l3.png",
  },
  {
    type: "office",
    variant: 1,
    level: 4,
    source: "office-glass-l4-source.png",
    sprite: "office-glass-l4.png",
  },
  {
    type: "office",
    variant: 2,
    source: "office-wide-source.png",
    sprite: "office-wide-l2.png",
  },
  {
    type: "office",
    variant: 2,
    level: 3,
    source: "office-studio-l3-source.png",
    sprite: "office-studio-l3.png",
  },
  {
    type: "office",
    variant: 2,
    level: 4,
    source: "office-studio-l4-source.png",
    sprite: "office-studio-l4.png",
  },
  {
    type: "homes",
    variant: 1,
    source: "homes-source.png",
    sprite: "homes-l2.png",
  },
  {
    type: "homes",
    variant: 2,
    source: "homes-townhouse-source.png",
    sprite: "homes-townhouse-l2.png",
  },
];
const canvas = { width: 560, height: 640 };
// Keep the original level-2 images at 95 logical pixels; this remains below
// their 100-pixel cap and preserves their published guest-preview hashes.
const maxArtHeightByLevel = [280, 380, 520, 640];
const check = process.argv.includes("--check");

if (!check) await mkdir(outputDir, { recursive: true });
const catalog = [];
const keys = new Set();
for (const facade of facades) {
  const level = facade.level ?? 2;
  const maxHeight = maxArtHeightByLevel[level - 1];
  if (!maxHeight)
    throw new Error(`Invalid level ${level} for ${facade.sprite}`);
  const key = `${facade.type}:${facade.variant}:${level}`;
  if (keys.has(key)) throw new Error(`Duplicate illustrated facade ${key}`);
  keys.add(key);
  const source = path.join(sourceDir, facade.source);
  const input = await readFile(source);
  const metadata = await sharp(input).metadata();
  if (!metadata.hasAlpha)
    throw new Error(`${facade.source} must have a transparent background`);
  const trimmed = await sharp(input)
    .trim({ background: "#00000000", threshold: 8 })
    .png()
    .toBuffer();
  const resized = await sharp(trimmed)
    .resize(520, maxHeight, { fit: "inside" })
    .png()
    .toBuffer();
  const bounds = await sharp(resized).metadata();
  if (!bounds.width || !bounds.height)
    throw new Error(`${facade.source} has no image bounds`);
  const left = Math.floor((canvas.width - bounds.width) / 2);
  const top = canvas.height - bounds.height;
  const sprite = await sharp({
    create: { ...canvas, channels: 4, background: "#00000000" },
  })
    .composite([{ input: resized, left, top }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const filename = facade.sprite;
  const output = path.join(outputDir, filename);
  if (check) {
    const existing = await readFile(output);
    if (!existing.equals(sprite)) throw new Error(`${filename} is out of date`);
  } else {
    await writeFile(output, sprite);
  }
  catalog.push({
    type: facade.type,
    ...(facade.variant ? { variant: facade.variant } : {}),
    level,
    sprite: filename,
    sha256: createHash("sha256").update(sprite).digest("hex"),
    source: facade.source,
    canvas,
    alphaBounds: {
      x: left / 4,
      y: top / 4,
      width: bounds.width / 4,
      height: bounds.height / 4,
    },
  });
}
const content = `${JSON.stringify({ version: 3, facades: catalog }, null, 2)}\n`;
if (check) {
  if ((await readFile(catalogPath, "utf8")) !== content)
    throw new Error("Illustrated facade catalog is out of date");
} else {
  await writeFile(catalogPath, content);
}
console.log(
  `${check ? "Checked" : "Prepared"} ${catalog.length} illustrated facades`,
);
