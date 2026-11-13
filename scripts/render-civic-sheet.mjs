import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const catalog = JSON.parse(
  await readFile(new URL("apps/web/src/world-sprites.json", root), "utf8"),
);
const sites = catalog.sites;
if (sites.length !== 6) throw new Error("Expected six civic sprites");
const width = 1170;
const height = 770;
const labels = [
  "PARKING TOWER",
  "REPAIR GARAGE",
  "HARBOR CINEMA",
  "NEAR &amp; FAR BURGERS",
  "PRACTICE COURSE",
  "HORSE COURSE",
];
const elements = [];
for (let index = 0; index < sites.length; index++) {
  const col = index % 3;
  const row = Math.floor(index / 3);
  const x = 30 + col * 380;
  const y = 75 + row * 345;
  const background = Buffer.from(
    `<svg width="350" height="315" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="348" height="313" rx="18" fill="#fff8eb" stroke="#1e2d49" stroke-width="2"/><rect x="12" y="242" width="326" height="2" fill="#1e2d49"/><text x="175" y="281" font-family="Arial,sans-serif" font-size="20" font-weight="700" text-anchor="middle" fill="#1e2d49">${labels[index]}</text></svg>`,
  );
  elements.push({ input: background, left: x, top: y });
  const sprite = await readFile(
    new URL(`apps/web/public/world/${sites[index].sprite}`, root),
  );
  elements.push({
    input: await sharp(sprite).resize(210, 240).png().toBuffer(),
    left: x + 70,
    top: y + 3,
  });
}
const base = Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f8efdf"/><text x="30" y="48" font-family="Arial,sans-serif" font-size="28" font-weight="700" fill="#1e2d49">NEAR.ESTATE · GAME-OWNED DESTINATIONS</text></svg>`,
);
const png = await sharp(base).composite(elements).png().toBuffer();
const path = new URL("docs/images/near-estate-civic-destinations-v2.png", root);
if (process.argv.includes("--check")) {
  const existing = await readFile(path);
  if (!existing.equals(png))
    throw new Error("Civic sheet is stale; render it again");
} else await writeFile(path, png);
console.log("Rendered six game-owned destinations");
