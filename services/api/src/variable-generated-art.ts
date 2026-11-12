import { createHash } from "node:crypto";
import {
  FRONTAGE_CANVAS_HEIGHT_V2,
  FRONTAGE_LEVEL_HEIGHTS_V2,
  FRONTAGE_MIN_VISIBLE_FRACTION_V2,
  FRONTAGE_SIDE_GAP_V2,
  FRONTAGE_UNIT_WIDTH_V2,
  canonicalJson,
  validateAssetManifestV2,
  variableFrontageMediaLayout,
  type AssetManifestV2,
  type BuildingLevelV2,
  type FrontageUnitsV2,
} from "@estate/shared";
import sharp from "sharp";
import { saveImmutablePng } from "./asset-storage.js";
import { GeneratedArtError } from "./generated-art.js";

const SCALE = 4;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 8_294_400;
const MAX_SOURCE_EDGE = 3_840;
const VISIBLE_ALPHA = 8;

export type VariableGeneratedCandidate = {
  manifest: AssetManifestV2;
  manifestHash: string;
  sprite: Buffer;
  spriteHash: string;
  thumbnail: Buffer;
  thumbnailHash: string;
};

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function visibleBounds(
  rgba: Buffer,
  width: number,
  height: number,
): {
  left: number;
  top: number;
  right: number;
  bottom: number;
  visible: number;
  transparent: number;
} {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let visible = 0;
  let transparent = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = rgba[(y * width + x) * 4 + 3]!;
      if (alpha === 0) transparent++;
      if (alpha <= VISIBLE_ALPHA) continue;
      visible++;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top)
    throw new GeneratedArtError("Generated facade has no visible pixels");
  return { left, top, right, bottom, visible, transparent };
}

export async function normalizeVariableGeneratedFacade(
  source: Buffer,
  input: {
    frontageUnits: FrontageUnitsV2;
    designChoice: number;
    buildingType: AssetManifestV2["buildingType"];
    level: BuildingLevelV2;
  },
): Promise<VariableGeneratedCandidate> {
  if (source.length < 8 || source.length > MAX_SOURCE_BYTES)
    throw new GeneratedArtError("Generated image size is outside the limit");
  const layout = variableFrontageMediaLayout(
    input.frontageUnits,
    input.designChoice,
    input.level,
  );
  const logicalWidth = input.frontageUnits * FRONTAGE_UNIT_WIDTH_V2;
  const logicalHeight = FRONTAGE_CANVAS_HEIGHT_V2;
  const maxVisibleHeight = FRONTAGE_LEVEL_HEIGHTS_V2[input.level];
  const decoder = sharp(source, {
    limitInputPixels: MAX_SOURCE_PIXELS,
    failOn: "error",
    animated: false,
  });
  let metadata;
  try {
    metadata = await decoder.metadata();
  } catch {
    throw new GeneratedArtError("Generated image could not be decoded");
  }
  if (
    metadata.format !== "png" ||
    !metadata.hasAlpha ||
    !metadata.width ||
    !metadata.height ||
    metadata.width < 64 ||
    metadata.height < 64 ||
    metadata.width > MAX_SOURCE_EDGE ||
    metadata.height > MAX_SOURCE_EDGE ||
    metadata.width * metadata.height > MAX_SOURCE_PIXELS ||
    (metadata.pages ?? 1) !== 1
  )
    throw new GeneratedArtError("Generated image must be one transparent PNG");
  const decoded = await decoder.ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  if (
    decoded.info.width !== metadata.width ||
    decoded.info.height !== metadata.height ||
    decoded.info.channels !== 4
  )
    throw new GeneratedArtError(
      "Generated PNG dimensions changed during decode",
    );
  const original = visibleBounds(decoded.data, metadata.width, metadata.height);
  if (original.transparent < metadata.width * metadata.height * 0.02)
    throw new GeneratedArtError(
      "Generated facade has no transparent background",
    );
  if (original.visible < metadata.width * metadata.height * 0.01)
    throw new GeneratedArtError("Generated facade silhouette is unusable");
  const cropped = await sharp(decoded.data, {
    raw: { width: metadata.width, height: metadata.height, channels: 4 },
  })
    .extract({
      left: original.left,
      top: original.top,
      width: original.right - original.left + 1,
      height: original.bottom - original.top + 1,
    })
    .resize({
      width: (logicalWidth - FRONTAGE_SIDE_GAP_V2 * 2) * SCALE,
      height: maxVisibleHeight * SCALE,
      fit: "inside",
      kernel: "lanczos3",
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  if (
    cropped.info.width <
    logicalWidth * SCALE * FRONTAGE_MIN_VISIBLE_FRACTION_V2
  )
    throw new GeneratedArtError("Generated facade is too narrow for its plot");
  // The source must already occupy most of its plot. Once accepted, use the
  // same close-fitting frontage as the illustrated street buildings.
  const frontageWidth = (logicalWidth - FRONTAGE_SIDE_GAP_V2 * 2) * SCALE;
  const fitted =
    cropped.info.width === frontageWidth
      ? cropped.data
      : await sharp(cropped.data)
          .resize({
            width: frontageWidth,
            height: cropped.info.height,
            fit: "fill",
            kernel: "lanczos3",
          })
          .png()
          .toBuffer();
  const spriteWidth = logicalWidth * SCALE;
  const spriteHeight = logicalHeight * SCALE;
  const left = FRONTAGE_SIDE_GAP_V2 * SCALE;
  const top = spriteHeight - cropped.info.height;
  const sprite = await sharp({
    create: {
      width: spriteWidth,
      height: spriteHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: fitted, left, top }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const alphaBounds = {
    x: left / SCALE,
    y: top / SCALE,
    width: frontageWidth / SCALE,
    height: cropped.info.height / SCALE,
  };
  const thumbnail = await sharp(sprite)
    .resize(logicalWidth, logicalHeight)
    .png({ compressionLevel: 9 })
    .toBuffer();
  const spriteHash = hash(sprite);
  const thumbnailHash = hash(thumbnail);
  let manifest: AssetManifestV2;
  try {
    manifest = validateAssetManifestV2({
      schemaVersion: 2,
      renderProfileVersion: 2,
      frontageUnits: input.frontageUnits,
      designChoice: input.designChoice,
      buildingType: input.buildingType,
      level: input.level,
      spriteHash,
      thumbnailHash,
      alphaBounds,
      logoRect: layout.logo,
      billboardRect: layout.billboard,
    });
  } catch {
    throw new GeneratedArtError("Generated facade placement is invalid");
  }
  return {
    manifest,
    manifestHash: hash(canonicalJson(manifest)),
    sprite,
    spriteHash,
    thumbnail,
    thumbnailHash,
  };
}

export async function saveVariableGeneratedFacade(
  source: Buffer,
  input: Parameters<typeof normalizeVariableGeneratedFacade>[1],
  assetDir: string,
): Promise<VariableGeneratedCandidate> {
  const candidate = await normalizeVariableGeneratedFacade(source, input);
  await Promise.all([
    saveImmutablePng(assetDir, candidate.spriteHash, candidate.sprite),
    saveImmutablePng(assetDir, candidate.thumbnailHash, candidate.thumbnail),
  ]);
  return candidate;
}
