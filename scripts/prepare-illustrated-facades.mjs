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
const names = ["retail", "cafe", "restaurant", "office", "homes"];
const canvas = { width: 560, height: 640 };
const maxArt = { width: 520, height: 380 };
const check = process.argv.includes("--check");

if (!check) await mkdir(outputDir, { recursive: true });
const catalog = [];
for (const name of names) {
  const source = path.join(sourceDir, `${name}-source.png`);
  const input = await readFile(source);
  const metadata = await sharp(input).metadata();
  if (!metadata.hasAlpha)
    throw new Error(`${name} must have a transparent background`);
  const trimmed = await sharp(input)
    .trim({ background: "#00000000", threshold: 8 })
    .png()
    .toBuffer();
  const resized = await sharp(trimmed)
    .resize(maxArt.width, maxArt.height, { fit: "inside" })
    .png()
    .toBuffer();
  const bounds = await sharp(resized).metadata();
  if (!bounds.width || !bounds.height)
    throw new Error(`${name} has no image bounds`);
  const left = Math.floor((canvas.width - bounds.width) / 2);
  const top = canvas.height - bounds.height;
  const sprite = await sharp({
    create: { ...canvas, channels: 4, background: "#00000000" },
  })
    .composite([{ input: resized, left, top }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const filename = `${name}-l2.png`;
  const output = path.join(outputDir, filename);
  if (check) {
    const existing = await readFile(output);
    if (!existing.equals(sprite)) throw new Error(`${filename} is out of date`);
  } else {
    await writeFile(output, sprite);
  }
  catalog.push({
    type: name,
    sprite: filename,
    sha256: createHash("sha256").update(sprite).digest("hex"),
    source: `${name}-source.png`,
    canvas,
    alphaBounds: {
      x: left / 4,
      y: top / 4,
      width: bounds.width / 4,
      height: bounds.height / 4,
    },
  });
}
const content = `${JSON.stringify({ version: 1, facades: catalog }, null, 2)}\n`;
if (check) {
  if ((await readFile(catalogPath, "utf8")) !== content)
    throw new Error("Illustrated facade catalog is out of date");
} else {
  await writeFile(catalogPath, content);
}
console.log(
  `${check ? "Checked" : "Prepared"} ${catalog.length} illustrated level-2 facades`,
);
