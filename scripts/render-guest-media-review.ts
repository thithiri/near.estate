import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { variableFrontageMediaLayout } from "@estate/shared";

const root = resolve(import.meta.dirname, "..");
const cards: Array<{ id: "diner" | "arcade"; choice: 1 | 4; level: 3 | 4 }> = [
  { id: "diner", choice: 1, level: 3 },
  { id: "diner", choice: 1, level: 4 },
  { id: "arcade", choice: 4, level: 3 },
  { id: "arcade", choice: 4, level: 4 },
];
const composite: Array<{ input: Buffer; left: number; top: number }> = [];
const labels: string[] = [];
for (const [index, card] of cards.entries()) {
  const layout = variableFrontageMediaLayout(2, card.choice, card.level);
  if (!layout.billboard) throw new Error("Billboard layout missing");
  const { sign, logo, billboard } = layout;
  const svg =
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="680" height="760"><g transform="scale(4)">
    <rect x="${sign.x}" y="${sign.y}" width="${sign.width}" height="${sign.height}" fill="#fff9ed" stroke="#27384a" stroke-width="2"/>
    <rect x="${logo.x}" y="${logo.y}" width="${logo.width}" height="${logo.height}" fill="#e9634e"/>
    <text x="${logo.x + logo.width / 2}" y="${logo.y + logo.height / 2 + 3}" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="white">NE</text>
    <rect x="${billboard.x}" y="${billboard.y}" width="${billboard.width}" height="${billboard.height}" fill="#ffca37" stroke="#27384a" stroke-width="2"/>
    <text x="${billboard.x + billboard.width / 2}" y="${billboard.y + billboard.height / 2 + 4}" text-anchor="middle" font-family="Arial" font-size="11" font-weight="700" fill="#27384a">SAMPLE AD</text>
  </g></svg>`);
  const source = await readFile(
    resolve(
      root,
      `apps/web/public/guest-buildings/${card.id}-l${card.level}.png`,
    ),
  );
  const composed = await sharp(source)
    .composite([{ input: svg, left: 0, top: 0 }])
    .png()
    .toBuffer();
  const image = await sharp(composed).resize(340, 380).png().toBuffer();
  const x = 25 + (index % 2) * 370;
  const y = 55 + Math.floor(index / 2) * 430;
  composite.push({ input: image, left: x, top: y });
  labels.push(
    `<text x="${x}" y="${y + 405}" fill="#16283e" font-family="Arial" font-size="19" font-weight="700">${card.id} · level ${card.level}</text>`,
  );
}
const board = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="770" height="900"><rect width="770" height="900" fill="#fff8ec"/>${labels.join("")}</svg>`,
);
const output = await sharp(board).composite(composite).png().toBuffer();
const path = resolve(
  root,
  "docs/images/near-estate-new-media-placement-review-v1.png",
);
if (process.argv.includes("--check")) {
  if (!(await readFile(path)).equals(output))
    throw new Error("Guest media review sheet is stale");
} else {
  await writeFile(path, output);
  console.log(`Wrote ${path}`);
}
