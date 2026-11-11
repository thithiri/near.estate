import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "apps", "web", "public", "illustrated");
const output = path.join(
  root,
  "docs",
  "images",
  "near-estate-illustrated-buildings-v1.png",
);
const names = ["Retail", "Cafe", "Restaurant", "Office", "Homes"];
const width = 1580;
const height = 335;
const art = [];
for (const [index, name] of names.entries()) {
  const bytes = await readFile(
    path.join(assets, `${name.toLowerCase()}-l2.png`),
  );
  art.push({
    input: await sharp(bytes)
      .resize(280, 320)
      .extract({ left: 0, top: 40, width: 280, height: 280 })
      .png()
      .toBuffer(),
    left: 30 + index * 310,
    top: 0,
  });
}
const labels = names
  .map(
    (name, index) =>
      `<text x="${170 + index * 310}" y="65" text-anchor="middle" font-size="26" font-weight="800" fill="#14213d">${name}</text>`,
  )
  .join("");
const overlay =
  Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <text x="30" y="32" font-family="Arial, sans-serif" font-size="17" font-weight="700" fill="#536276">ILLUSTRATED BUILDING DRAFTS · LEVEL 2 · SAME GAME SCALE</text>
  <path d="M 0 280 H ${width}" stroke="#15223e" stroke-width="3"/>
  <g font-family="Arial, sans-serif">${labels}</g>
  <text x="30" y="318" font-family="Arial, sans-serif" font-size="16" fill="#536276">One image per type. Logos, names, billboards and parking rules are separate game layers.</text>
</svg>`);
await sharp({
  create: { width, height, channels: 4, background: "#fff9ed" },
})
  .composite([...art, { input: overlay, left: 0, top: 0 }])
  .png()
  .toFile(output);
console.log(output);
