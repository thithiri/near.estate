import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { FRONTAGE_DESIGN_IDS_V2 } from "@estate/shared";
import {
  draftParcelLayout,
  type DraftStreetId,
} from "../apps/web/src/parcel-layout.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const assetDir = `${root}apps/web/public/guest-buildings/`;
const destination = `${root}docs/images/near-estate-deed-move-review-v1.png`;
const catalog = JSON.parse(
  await readFile(`${root}apps/web/src/guest-illustrations.json`, "utf8"),
) as {
  buildings: Array<{
    id: string;
    level: number;
    sprite: string;
    sha256: string;
  }>;
};
const seed = JSON.parse(
  await readFile(`${root}contracts/estate/seed-v2.json`, "utf8"),
) as {
  plots: Array<{
    roadId: string;
    side: string;
    index: number;
    frontageUnits: number;
  }>;
};
const moveMap = JSON.parse(
  await readFile(
    `${root}contracts/estate/migration-v1-to-v2-draft.json`,
    "utf8",
  ),
) as { moves: Array<{ from: string; to: string }> };
const moves = [
  {
    road: "main" as DraftStreetId,
    title: "MAIN STREET · NORTH",
    source: 2,
    target: 3,
    level: 2,
    note: "Near Garden moves beside Central Avenue. V1 facade is hidden, logo stays visible, billboard is hidden at level 2.",
  },
  {
    road: "market" as DraftStreetId,
    title: "MARKET STREET · NORTH",
    source: 1,
    target: 2,
    level: 1,
    note: "The deed stays on the same block, one frontage to the right.",
  },
];
const scale = 2;
const width = 1600;
const height = 1600;
const panelTop = [104, 864];
const sceneLeft = 48;
const escape = (value: string): string =>
  value.replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  );
const shapes: string[] = [
  `<rect width="${width}" height="${height}" fill="#e8f0ef"/>`,
  `<rect width="${width}" height="76" fill="#153a52"/>`,
  `<text x="48" y="49" fill="#fffaf0" font-family="Arial,sans-serif" font-size="31" font-weight="800">near.estate · deed move review</text>`,
  `<text x="1538" y="48" fill="#b9dce4" font-family="Arial,sans-serif" font-size="18" text-anchor="end">Version 2 street art · 12 Nov 2026</text>`,
];
const overlays: string[] = [];
const sprites: Array<{ input: Buffer; left: number; top: number }> = [];

for (const [panelIndex, move] of moves.entries()) {
  const layout = draftParcelLayout(move.road, "North");
  if (
    !moveMap.moves.some(
      (entry) =>
        entry.from === `plot-${move.road}-n-${move.source}` &&
        entry.to === `plot-${move.road}-n-${move.target}`,
    ) ||
    layout.parcels.some(
      (parcel) =>
        !seed.plots.some(
          (entry) =>
            entry.roadId === move.road &&
            entry.side === "North" &&
            entry.index === parcel.index &&
            entry.frontageUnits === parcel.units,
        ),
    )
  )
    throw new Error(`Review image differs from ${move.road} move or seed`);
  const top = panelTop[panelIndex]!;
  const streetWidth = 1510;
  const sceneY = top + 60;
  shapes.push(
    `<rect x="30" y="${top - 18}" width="1540" height="720" rx="18" fill="#fffaf0" stroke="#cad7d2" stroke-width="2"/>`,
    `<text x="52" y="${top + 18}" fill="#173c53" font-family="Arial,sans-serif" font-size="24" font-weight="800">${move.title}</text>`,
    `<text x="1538" y="${top + 18}" fill="#536f7b" font-family="Arial,sans-serif" font-size="17" text-anchor="end">Old ID: plot-${move.road}-n-${move.source} → proposed: plot-${move.road}-n-${move.target}</text>`,
    `<text x="52" y="${top + 44}" fill="#657c83" font-family="Arial,sans-serif" font-size="16">Proposed V2 street layout; the current V1 building and media are not pictured.</text>`,
    `<rect x="${sceneLeft}" y="${sceneY}" width="${streetWidth}" height="${300 * scale}" fill="#d7edf0"/>`,
    `<rect x="${sceneLeft}" y="${sceneY + 190 * scale}" width="${streetWidth}" height="${16 * scale}" fill="#c8bda9"/>`,
    `<rect x="${sceneLeft}" y="${sceneY + 206 * scale}" width="${streetWidth}" height="${40 * scale}" fill="#66757b"/>`,
    `<rect x="${sceneLeft}" y="${sceneY + 246 * scale}" width="${streetWidth}" height="${54 * scale}" fill="#45525e"/>`,
  );
  for (const parcel of layout.parcels.slice(0, 5)) {
    const choice = (parcel.index * 2 + (move.road === "main" ? 0 : 1)) % 5;
    const designId = FRONTAGE_DESIGN_IDS_V2[parcel.units][choice]!;
    const art = catalog.buildings.find(
      (entry) => entry.id === designId && entry.level === move.level,
    );
    if (!art) throw new Error(`Missing ${designId} level ${move.level}`);
    const bytes = await readFile(`${assetDir}${art.sprite}`);
    if (createHash("sha256").update(bytes).digest("hex") !== art.sha256)
      throw new Error(`Building art changed: ${art.sprite}`);
    const x = sceneLeft + parcel.x * scale;
    const w = parcel.width * scale;
    sprites.push({
      input: await sharp(bytes)
        .resize(w, 190 * scale)
        .png()
        .toBuffer(),
      left: x,
      top: sceneY,
    });
    for (let slot = 0; slot < parcel.spaces; slot++) {
      const bayX = x + slot * 85 * scale + 10;
      overlays.push(
        `<rect x="${bayX}" y="${sceneY + 214 * scale}" width="${65 * scale}" height="${26 * scale}" rx="3" fill="none" stroke="#f5eddb" stroke-width="3"/>`,
      );
    }
    overlays.push(
      `<text x="${x + w / 2}" y="${sceneY + 285 * scale}" fill="#fffaf0" font-family="Arial,sans-serif" font-size="18" font-weight="800" text-anchor="middle">PLOT ${parcel.index} · ${parcel.units} SPACE${parcel.units === 1 ? "" : "S"}</text>`,
    );
    if (parcel.index === move.source || parcel.index === move.target) {
      const source = parcel.index === move.source;
      overlays.push(
        `<rect x="${x + 2}" y="${sceneY + 4}" width="${w - 4}" height="${242 * scale}" rx="5" fill="none" stroke="${source ? "#d8564e" : "#26a98a"}" stroke-width="6" ${source ? 'stroke-dasharray="12 8"' : ""}/>`,
        `<rect x="${x + 6}" y="${sceneY + 6}" width="${Math.min(w - 12, 204)}" height="30" rx="6" fill="${source ? "#b43e39" : "#117d68"}"/>`,
        `<text x="${x + 18}" y="${sceneY + 28}" fill="white" font-family="Arial,sans-serif" font-size="18" font-weight="800">${source ? "OLD ID SLOT" : "PROPOSED DEED"}</text>`,
      );
    }
  }
  for (const crossing of layout.crossings.slice(0, 1)) {
    const x = sceneLeft + crossing.x * scale;
    shapes.push(
      `<rect x="${x}" y="${sceneY + 140 * scale}" width="${76 * scale}" height="${160 * scale}" fill="#53666d"/>`,
    );
    for (let n = 0; n < 5; n++)
      overlays.push(
        `<rect x="${x + 14 + n * 27}" y="${sceneY + 210 * scale}" width="16" height="67" fill="#f7f1df"/>`,
      );
    overlays.push(
      `<rect x="${x + 14}" y="${sceneY + 155 * scale}" width="124" height="36" rx="5" fill="#166c5a"/>`,
      `<text x="${x + 76}" y="${sceneY + 179 * scale}" fill="white" font-family="Arial,sans-serif" font-size="14" font-weight="800" text-anchor="middle">CENTRAL AVE</text>`,
    );
  }
  overlays.push(
    `<rect x="${sceneLeft}" y="${top + 670}" width="${streetWidth}" height="32" fill="#fffaf0"/>`,
    `<text x="${sceneLeft}" y="${top + 692}" fill="#3a5865" font-family="Arial,sans-serif" font-size="18">${escape(move.note)}</text>`,
  );
}

const image = await sharp(
  Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${shapes.join("")}</svg>`,
  ),
)
  .composite([
    ...sprites,
    {
      input: Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${overlays.join("")}</svg>`,
      ),
      left: 0,
      top: 0,
    },
  ])
  .png()
  .toBuffer();
await writeFile(destination, image);
console.log(destination);
