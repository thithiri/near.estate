import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(
  await readFile(join(root, "apps/web/src/guest-illustrations.json"), "utf8"),
);
const groups = [
  {
    units: 1,
    ids: [
      "news-kiosk",
      "coffee-pod",
      "townhouse",
      "flower-stall",
      "bike-repair",
    ],
    left: "diner",
    right: "bookshop",
  },
  {
    units: 2,
    ids: ["corner-shop", "diner", "glass-studio", "bookshop", "arcade"],
    left: "townhouse",
    right: "market-hall",
  },
  {
    units: 3,
    ids: [
      "market-hall",
      "garden-bistro",
      "office-campus",
      "food-hall",
      "craft-works",
    ],
    left: "diner",
    right: "flower-stall",
  },
];
const panelWidth = 560;
const panelHeight = 240;
const gutter = 16;
const margin = 30;
const headingHeight = 84;
const imageWidth = margin * 2 + panelWidth * 4 + gutter * 3;
const imageHeight = headingHeight + panelHeight * 5 + gutter * 4 + margin;
const sourceDir = join(root, "apps/web/public/guest-buildings");
const check = process.argv.includes("--check");

function escapeXml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function title(id) {
  return id
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function entryFor(id, level) {
  const entry = catalog.buildings.find(
    (item) => item.id === id && item.level === level,
  );
  if (!entry)
    throw new Error(`Missing current art for ${id} at level ${level}`);
  return entry;
}

async function scaledSprite(entry) {
  return sharp(join(sourceDir, entry.sprite))
    .resize(entry.units * 85, 190, { fit: "fill" })
    .png()
    .toBuffer();
}

for (const group of groups) {
  let background = `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}">
    <rect width="100%" height="100%" fill="#fff8eb"/>
    <text x="${margin}" y="39" fill="#192b45" font-family="Arial,sans-serif" font-size="27" font-weight="700">near.estate · ${group.units}-unit buildings beside neighbours</text>
    <text x="${margin}" y="65" fill="#516476" font-family="Arial,sans-serif" font-size="16">Current game sprites at 1 logical pixel per image pixel · highlighted plot is the level under review</text>`;
  const composites = [];
  for (const [row, id] of group.ids.entries()) {
    const top = headingHeight + row * (panelHeight + gutter);
    for (let level = 1; level <= 4; level++) {
      const left = margin + (level - 1) * (panelWidth + gutter);
      const target = entryFor(id, level);
      if (target.units !== group.units)
        throw new Error(`Wrong plot width for ${id} level ${level}`);
      const neighbourLeft = entryFor(group.left, 2);
      const neighbourRight = entryFor(group.right, 2);
      const totalWidth =
        (neighbourLeft.units + target.units + neighbourRight.units) * 85;
      const firstX = left + Math.floor((panelWidth - totalWidth) / 2);
      const targetX = firstX + neighbourLeft.units * 85;
      const lastX = targetX + target.units * 85;
      background += `<rect x="${left}" y="${top}" width="${panelWidth}" height="${panelHeight}" rx="12" fill="#dceef2" stroke="#b9cdd1"/>
        <rect x="${left + 1}" y="${top + 28}" width="${panelWidth - 2}" height="190" fill="#dceef2"/>
        <rect x="${targetX}" y="${top + 28}" width="${target.units * 85}" height="190" fill="#fff3ce" opacity="0.55"/>
        <rect x="${left + 1}" y="${top + 218}" width="${panelWidth - 2}" height="12" fill="#d9d0bc"/>
        <rect x="${left + 1}" y="${top + 230}" width="${panelWidth - 2}" height="9" fill="#53677a"/>
        <path d="M${targetX} ${top + 28}V${top + 218} M${lastX} ${top + 28}V${top + 218}" fill="none" stroke="#c4a96a" stroke-width="1" stroke-dasharray="4 4"/>
        <text x="${left + 13}" y="${top + 19}" fill="#192b45" font-family="Arial,sans-serif" font-size="16" font-weight="700">${escapeXml(title(id))} · level ${level}</text>
        <text x="${left + panelWidth - 13}" y="${top + 19}" text-anchor="end" fill="#516476" font-family="Arial,sans-serif" font-size="13">${target.units * 85} px plot</text>`;
      for (const [entry, x] of [
        [neighbourLeft, firstX],
        [target, targetX],
        [neighbourRight, lastX],
      ])
        composites.push({
          input: await scaledSprite(entry),
          left: x,
          top: top + 28,
        });
    }
  }
  background += "</svg>";
  const image = await sharp(Buffer.from(background))
    .composite(composites)
    .png()
    .toBuffer();
  const output = join(
    root,
    `docs/images/near-estate-guest-neighbours-${group.units}-unit-v1.png`,
  );
  if (check) {
    const actual = await readFile(output);
    if (!actual.equals(image))
      throw new Error(`Guest neighbour sheet is stale: ${output}`);
    console.log(`Checked ${output}`);
  } else {
    await writeFile(output, image);
    console.log(`Wrote ${output}`);
  }
}
