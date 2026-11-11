import { createHash } from "node:crypto";
import {
  DEFAULT_RENDER_PROFILE,
  canonicalJson,
  validateAssetManifest,
  type AssetManifest,
} from "@estate/shared";
import sharp from "sharp";
import { saveImmutablePng } from "./asset-storage.js";
import type { RenderedCandidate } from "./mock-art.js";

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 8_294_400;
const MAX_SOURCE_EDGE = 3_840;
const MIN_VISIBLE_SIDE = 24;
const SIDE_MARGIN_LOGICAL = 5;
const VISIBLE_ALPHA = 8;
const PLACEMENT_ALPHA = 224;
const MIN_PLACEMENT_COVERAGE = 0.8;

type Bounds = { left: number; top: number; right: number; bottom: number };
type Rect = NonNullable<AssetManifest["logoRect"]>;

export class GeneratedArtError extends Error {}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pixelBounds(
  rgba: Buffer,
  width: number,
  height: number,
  threshold: number,
): { bounds: Bounds; visible: number; transparent: number } {
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
      if (alpha <= threshold) continue;
      visible++;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top)
    throw new GeneratedArtError("Generated facade has no visible pixels");
  return { bounds: { left, top, right, bottom }, visible, transparent };
}

function logicalBounds(bounds: Bounds): AssetManifest["alphaBounds"] {
  return {
    x: bounds.left / 4,
    y: bounds.top / 4,
    width: (bounds.right - bounds.left + 1) / 4,
    height: (bounds.bottom - bounds.top + 1) / 4,
  };
}

function coverage(rgba: Buffer, rect: Rect): number {
  let opaque = 0;
  let sampled = 0;
  const left = rect.x * 4;
  const top = rect.y * 4;
  for (let y = top; y < top + rect.height * 4; y += 4) {
    for (let x = left; x < left + rect.width * 4; x += 4) {
      sampled++;
      if (rgba[(y * 560 + x) * 4 + 3]! >= PLACEMENT_ALPHA) opaque++;
    }
  }
  return opaque / sampled;
}

function intersects(left: Rect, right: Rect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function placeOverlay(
  rgba: Buffer,
  alphaBounds: AssetManifest["alphaBounds"],
  width: number,
  height: number,
  preferRight: boolean,
  lowerHalf: boolean,
  avoid: Rect | null,
): Rect | null {
  const left = Math.ceil(alphaBounds.x + 4);
  const right = Math.floor(alphaBounds.x + alphaBounds.width - width - 4);
  const top = Math.ceil(alphaBounds.y + 4);
  const bottom = Math.floor(alphaBounds.y + alphaBounds.height - height - 4);
  if (left > right || top > bottom) return null;
  const startY = lowerHalf
    ? Math.max(top, Math.floor(alphaBounds.y + alphaBounds.height / 2))
    : top;
  const xs: number[] = [];
  for (let x = left; x <= right; x += 4) xs.push(x);
  if (xs[xs.length - 1] !== right) xs.push(right);
  if (preferRight) xs.reverse();
  for (let y = startY; y <= bottom; y += 4) {
    for (const x of xs) {
      const rect = { x, y, width, height };
      if (avoid && intersects(rect, avoid)) continue;
      if (coverage(rgba, rect) >= MIN_PLACEMENT_COVERAGE) return rect;
    }
  }
  return null;
}

export async function normalizeGeneratedFacade(
  source: Buffer,
  buildingType: AssetManifest["buildingType"],
  level: 1 | 2 | 3 | 4,
): Promise<RenderedCandidate> {
  if (source.length < 8 || source.length > MAX_SOURCE_BYTES)
    throw new GeneratedArtError("Generated image size is outside the limit");
  const maxLogicalHeight = DEFAULT_RENDER_PROFILE.maxHeightByLevel[level - 1];
  if (!maxLogicalHeight) throw new GeneratedArtError("Invalid paid level");
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
  let decoded;
  try {
    decoded = await decoder
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new GeneratedArtError("Generated PNG pixels could not be decoded");
  }
  if (
    decoded.info.width !== metadata.width ||
    decoded.info.height !== metadata.height ||
    decoded.info.channels !== 4
  )
    throw new GeneratedArtError(
      "Generated PNG dimensions changed during decode",
    );
  const original = pixelBounds(
    decoded.data,
    metadata.width,
    metadata.height,
    VISIBLE_ALPHA,
  );
  if (original.transparent < metadata.width * metadata.height * 0.02)
    throw new GeneratedArtError(
      "Generated facade has no transparent background",
    );
  const cropWidth = original.bounds.right - original.bounds.left + 1;
  const cropHeight = original.bounds.bottom - original.bounds.top + 1;
  if (
    cropWidth / cropHeight < 0.14 ||
    cropWidth / cropHeight > 8 ||
    original.visible < metadata.width * metadata.height * 0.01
  )
    throw new GeneratedArtError("Generated facade silhouette is unusable");
  const cropped = await sharp(decoded.data, {
    raw: { width: metadata.width, height: metadata.height, channels: 4 },
  })
    .extract({
      left: original.bounds.left,
      top: original.bounds.top,
      width: cropWidth,
      height: cropHeight,
    })
    .resize({
      width:
        (DEFAULT_RENDER_PROFILE.logicalWidth - SIDE_MARGIN_LOGICAL * 2) * 4,
      height: maxLogicalHeight * 4,
      fit: "inside",
      kernel: "lanczos3",
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  if (
    cropped.info.width < MIN_VISIBLE_SIDE * 4 ||
    cropped.info.height < MIN_VISIBLE_SIDE * 4
  )
    throw new GeneratedArtError("Generated facade is too thin at game scale");
  const left = Math.floor((560 - cropped.info.width) / 2);
  const top = 640 - cropped.info.height;
  const sprite = await sharp({
    create: {
      width: 560,
      height: 640,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: cropped.data, left, top }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const rgba = await sharp(sprite).ensureAlpha().raw().toBuffer();
  const normalized = pixelBounds(rgba, 560, 640, 0);
  const alphaBounds = logicalBounds(normalized.bounds);
  if (alphaBounds.y < 160 - maxLogicalHeight)
    throw new GeneratedArtError("Generated facade exceeds paid height");
  if (
    alphaBounds.x < SIDE_MARGIN_LOGICAL ||
    alphaBounds.x + alphaBounds.width >
      DEFAULT_RENDER_PROFILE.logicalWidth - SIDE_MARGIN_LOGICAL
  )
    throw new GeneratedArtError("Generated facade exceeds side margins");
  const logoRect = placeOverlay(rgba, alphaBounds, 20, 20, false, false, null);
  if (!logoRect)
    throw new GeneratedArtError("Generated facade lacks a usable logo area");
  const billboardRect = placeOverlay(
    rgba,
    alphaBounds,
    48,
    24,
    true,
    true,
    logoRect,
  );
  const thumbnail = await sharp(sprite)
    .resize(140, 160)
    .png({ compressionLevel: 9 })
    .toBuffer();
  const spriteHash = sha256(sprite);
  const thumbnailHash = sha256(thumbnail);
  let manifest: AssetManifest;
  try {
    manifest = validateAssetManifest({
      schemaVersion: 1,
      renderProfileVersion: DEFAULT_RENDER_PROFILE.version,
      buildingType,
      level,
      spriteHash,
      thumbnailHash,
      alphaBounds,
      logoRect,
      billboardRect,
    });
  } catch {
    throw new GeneratedArtError("Generated facade placement is invalid");
  }
  return {
    manifest,
    manifestHash: sha256(canonicalJson(manifest)),
    sprite,
    spriteHash,
    thumbnail,
    thumbnailHash,
  };
}

export async function saveGeneratedFacade(
  source: Buffer,
  buildingType: AssetManifest["buildingType"],
  level: 1 | 2 | 3 | 4,
  assetDir: string,
): Promise<RenderedCandidate> {
  const candidate = await normalizeGeneratedFacade(source, buildingType, level);
  await Promise.all([
    saveImmutablePng(assetDir, candidate.spriteHash, candidate.sprite),
    saveImmutablePng(assetDir, candidate.thumbnailHash, candidate.thumbnail),
  ]);
  return candidate;
}
