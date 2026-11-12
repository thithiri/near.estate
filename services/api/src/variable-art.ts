import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  FRONTAGE_DESIGN_IDS_V2,
  FRONTAGE_SIGN_COLORS_V2,
  FRONTAGE_CANVAS_HEIGHT_V2,
  FRONTAGE_UNIT_WIDTH_V2,
  variableFrontageMediaLayout,
  validateAssetManifestV2,
  type AssetManifestV2,
  type BuildingLevelV2,
  type ChainPlotV2,
} from "@estate/shared";
import sharp from "sharp";

const catalogPath = fileURLToPath(
  new URL("../../../apps/web/src/guest-illustrations.json", import.meta.url),
);
const spriteDir = fileURLToPath(
  new URL("../../../apps/web/public/guest-buildings/", import.meta.url),
);
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
  buildings: Array<{
    id: string;
    units: number;
    level: number;
    sprite: string;
    sha256: string;
  }>;
};

function xml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

export async function composeVariableFacadePreview(input: {
  plot: ChainPlotV2;
  logo?: Buffer | null;
  billboard?: Buffer | null;
  approvedFacade?: { manifest: AssetManifestV2; sprite: Buffer } | null;
}): Promise<Buffer> {
  const { frontage_units: units, design_choice: design } = input.plot.plot;
  const { level, name } = input.plot.plot.building;
  const designId = FRONTAGE_DESIGN_IDS_V2[units][design];
  const signColors = FRONTAGE_SIGN_COLORS_V2[units][design];
  const entry = catalog.buildings.find(
    (item) =>
      item.id === designId && item.units === units && item.level === level,
  );
  if (!signColors) throw new Error("Variable facade sign is unavailable");
  let bytes: Buffer;
  if (input.approvedFacade) {
    const manifest = validateAssetManifestV2(input.approvedFacade.manifest);
    if (
      manifest.frontageUnits !== units ||
      manifest.designChoice !== design ||
      manifest.buildingType !== input.plot.plot.building.building_type ||
      manifest.level !== level
    )
      throw new Error("Approved variable facade does not match its plot");
    bytes = input.approvedFacade.sprite;
    if (
      createHash("sha256").update(bytes).digest("hex") !== manifest.spriteHash
    )
      throw new Error("Approved variable facade image hash mismatch");
  } else {
    if (!entry || !/^[a-z0-9-]+\.png$/.test(entry.sprite))
      throw new Error("Variable facade illustration is unavailable");
    bytes = await readFile(`${spriteDir}/${entry.sprite}`);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error("Variable facade illustration hash mismatch");
  }
  const width = units * FRONTAGE_UNIT_WIDTH_V2;
  const metadata = await sharp(bytes).metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== width * 4 ||
    metadata.height !== FRONTAGE_CANVAS_HEIGHT_V2 * 4
  )
    throw new Error("Variable facade illustration dimensions are invalid");
  const layout = variableFrontageMediaLayout(
    units,
    design,
    level as BuildingLevelV2,
  );
  if (input.billboard && !layout.billboard)
    throw new Error("This building has no billboard placement at this level");
  const sign = layout.sign;
  const mark = layout.logo;
  const scale = 4;
  const initials = name
    .trim()
    .split(/\s+/)
    .map((word) => word[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const signSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${FRONTAGE_CANVAS_HEIGHT_V2 * scale}"><g transform="scale(${scale})">` +
      (units > 1
        ? `<rect x="${sign.x}" y="${sign.y}" width="${sign.width}" height="${sign.height}" fill="#fff9ed"/><rect x="${sign.x + 1}" y="${sign.y + 1}" width="${sign.width - 2}" height="${sign.height - 2}" fill="none" stroke="${signColors.roof}" stroke-width="2"/>`
        : "") +
      `<rect x="${mark.x}" y="${mark.y}" width="${mark.width}" height="${mark.height}" fill="${signColors.trim}"/>` +
      (input.logo
        ? ""
        : `<text x="${mark.x + mark.width / 2}" y="${mark.y + mark.height / 2}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${units === 1 ? 8 : 10}" font-weight="800" fill="#fff">${xml(initials)}</text>`) +
      (layout.name
        ? `<text x="${layout.name.x}" y="${layout.name.y + layout.name.height / 2}" dominant-baseline="middle" font-family="sans-serif" font-size="${units === 2 ? 8 : 10}" font-weight="800" textLength="${layout.name.width}" lengthAdjust="spacingAndGlyphs" fill="#263a4e">${xml(name.toUpperCase())}</text>`
        : "") +
      `</g></svg>`,
  );
  const overlays: Array<{ input: Buffer; left: number; top: number }> = [
    { input: signSvg, left: 0, top: 0 },
  ];
  if (input.logo) {
    const image = await sharp(input.logo)
      .resize((mark.width - 2) * scale, (mark.height - 2) * scale, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    overlays.push({
      input: image,
      left: Math.round((mark.x + 1) * scale),
      top: Math.round((mark.y + 1) * scale),
    });
  }
  if (input.billboard && layout.billboard) {
    const rect = layout.billboard;
    overlays.push({
      input: await sharp(input.billboard)
        .resize(rect.width * scale, rect.height * scale, { fit: "cover" })
        .png()
        .toBuffer(),
      left: Math.round(rect.x * scale),
      top: Math.round(rect.y * scale),
    });
  }
  const composed = await sharp(bytes)
    .composite(overlays)
    .png({ compressionLevel: 9 })
    .toBuffer();
  return sharp(composed)
    .resize(width, FRONTAGE_CANVAS_HEIGHT_V2)
    .png({ compressionLevel: 9 })
    .toBuffer();
}
