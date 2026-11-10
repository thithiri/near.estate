import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  validateAssetManifest,
  type AssetManifest,
} from "@estate/shared";
import sharp from "sharp";

const catalogPath = fileURLToPath(
  new URL("../../../apps/web/src/preset-catalog.json", import.meta.url),
);
const presetDir = fileURLToPath(
  new URL("../../../apps/web/public/presets/", import.meta.url),
);

type CatalogPreset = {
  buildingType: string;
  variant: number;
  level: number;
  sprite: string;
  paletteMask: string;
  spriteHash: string;
  paletteMaskHash: string;
  logoRect: AssetManifest["logoRect"];
  billboardRect: AssetManifest["billboardRect"];
};

export type RenderedCandidate = {
  manifest: AssetManifest;
  manifestHash: string;
  sprite: Buffer;
  spriteHash: string;
  thumbnail: Buffer;
  thumbnailHash: string;
};

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function colorChannels(hex: string): [number, number, number] {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) throw new Error("Invalid palette");
  return [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  ) as [number, number, number];
}

async function catalogPreset(
  buildingType: string,
  variant: 1 | 2,
  level: number,
): Promise<CatalogPreset> {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
    version: number;
    facades: CatalogPreset[];
  };
  if (catalog.version !== 1) throw new Error("Unsupported preset catalog");
  const preset = catalog.facades.find(
    (entry) =>
      entry.buildingType === buildingType &&
      entry.variant === variant &&
      entry.level === level,
  );
  if (!preset) throw new Error("Missing curated building art");
  return preset;
}

function alphaBounds(rgba: Buffer): AssetManifest["alphaBounds"] {
  let left = 560;
  let top = 640;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < 640; y++) {
    for (let x = 0; x < 560; x++) {
      if (rgba[(y * 560 + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error("Empty facade image");
  return {
    x: left / 4,
    y: top / 4,
    width: (right - left + 1) / 4,
    height: (bottom - top + 1) / 4,
  };
}

export async function renderMockCandidate(
  buildingType: string,
  variant: 1 | 2,
  level: number,
  palette: string,
): Promise<RenderedCandidate> {
  const preset = await catalogPreset(buildingType, variant, level);
  const [base, mask] = await Promise.all([
    readFile(join(presetDir, preset.sprite)),
    readFile(join(presetDir, preset.paletteMask)),
  ]);
  if (
    sha256(base) !== preset.spriteHash ||
    sha256(mask) !== preset.paletteMaskHash
  )
    throw new Error("Curated art hash does not match the catalog");
  const decodedMask = await sharp(mask)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    decodedMask.info.width !== 560 ||
    decodedMask.info.height !== 640 ||
    decodedMask.info.channels !== 4
  )
    throw new Error("Invalid curated palette mask");
  const [red, green, blue] = colorChannels(palette);
  const overlay = Buffer.alloc(560 * 640 * 4);
  for (let offset = 0; offset < overlay.length; offset += 4) {
    overlay[offset] = red;
    overlay[offset + 1] = green;
    overlay[offset + 2] = blue;
    overlay[offset + 3] = decodedMask.data[offset + 3]!;
  }
  const sprite = await sharp(base)
    .composite([
      { input: overlay, raw: { width: 560, height: 640, channels: 4 } },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const rgba = await sharp(sprite).ensureAlpha().raw().toBuffer();
  const thumbnail = await sharp(sprite)
    .resize(140, 160)
    .png({ compressionLevel: 9 })
    .toBuffer();
  const spriteHash = sha256(sprite);
  const thumbnailHash = sha256(thumbnail);
  const manifest = validateAssetManifest({
    schemaVersion: 1,
    renderProfileVersion: 1,
    buildingType,
    level,
    spriteHash,
    thumbnailHash,
    alphaBounds: alphaBounds(rgba),
    logoRect: preset.logoRect,
    billboardRect: preset.billboardRect,
  });
  return {
    manifest,
    manifestHash: sha256(canonicalJson(manifest)),
    sprite,
    spriteHash,
    thumbnail,
    thumbnailHash,
  };
}
