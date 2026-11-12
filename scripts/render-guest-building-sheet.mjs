import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(
  await readFile(join(root, "apps/web/src/guest-illustrations.json"), "utf8"),
);
const names = [
  ["News kiosk", "Coffee pod", "Townhouse", "Flower stall", "Bike repair"],
  ["Corner shop", "Diner", "Glass studio", "Bookshop", "Arcade"],
  ["Market hall", "Garden bistro", "Office campus", "Food hall", "Craft works"],
];
const width = 1740;
const height = 1190;
const columnWidth = 560;
const rowHeight = 199;
const columnLeft = (index) => 20 + index * 575;
const rowTop = (index) => 165 + index * rowHeight;
const escapeXml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

let labels = `<rect width="${width}" height="${height}" fill="#fff8ec"/>
  <text x="28" y="48" fill="#16283e" font-family="Arial,sans-serif" font-size="30" font-weight="700">near.estate · illustrated building choices</text>
  <text x="29" y="79" fill="#557083" font-family="Arial,sans-serif" font-size="17">Fifteen designs · three plot widths · level 2 preview</text>`;
const composites = [];
for (let column = 0; column < 3; column++) {
  const left = columnLeft(column);
  labels += `<rect x="${left}" y="98" width="${columnWidth}" height="1063" rx="18" fill="#e9f4f4" stroke="#bed4d9"/>
    <text x="${left + 20}" y="132" fill="#18354b" font-family="Arial,sans-serif" font-size="22" font-weight="700">${column + 1} ${column === 0 ? "unit" : "units"}</text>
    <text x="${left + 20}" y="156" fill="#557083" font-family="Arial,sans-serif" font-size="15">${column + 1} curb ${column === 0 ? "space" : "spaces"} · ${(column + 1) * 85} px frontage</text>`;
  for (let row = 0; row < 5; row++) {
    const name = names[column][row];
    const slug = name.toLowerCase().replaceAll(" ", "-");
    const entry = catalog.buildings.find(
      (item) => item.id === slug && item.level === 2,
    );
    if (!entry || entry.units !== column + 1)
      throw new Error(`Missing level-2 art for ${name}`);
    const top = rowTop(row);
    labels += `<text x="${left + 20}" y="${top + 20}" fill="#18354b" font-family="Arial,sans-serif" font-size="18" font-weight="700">${escapeXml(name)}</text>`;
    if (row < 4)
      labels += `<line x1="${left + 16}" y1="${top + 194}" x2="${left + columnWidth - 16}" y2="${top + 194}" stroke="#c7dadd"/>`;
    const { data, info } = await sharp(
      join(root, "apps/web/public/guest-buildings", entry.sprite),
    )
      .trim()
      .resize({ height: 155 })
      .png()
      .toBuffer({ resolveWithObject: true });
    composites.push({
      input: data,
      left: left + Math.floor((columnWidth - info.width) / 2),
      top: top + 185 - info.height,
    });
  }
}
const sheet = await sharp(
  Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${labels}</svg>`,
  ),
)
  .composite(composites)
  .png()
  .toBuffer();
const path = join(
  root,
  "docs/images/near-estate-fifteen-building-choices-v2.png",
);
if (process.argv.includes("--check")) {
  const current = await readFile(path);
  if (!current.equals(sheet)) throw new Error("Building choice sheet is stale");
  console.log("Checked current illustrated choice sheet.");
} else {
  await writeFile(path, sheet);
  console.log(`Wrote ${path}`);
}
