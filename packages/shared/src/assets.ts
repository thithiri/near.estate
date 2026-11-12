import { z } from "zod";
import { BuildingType } from "./world.js";
import {
  FRONTAGE_CANVAS_HEIGHT_V2,
  FRONTAGE_LEVEL_HEIGHTS_V2,
  FRONTAGE_MIN_VISIBLE_FRACTION_V2,
  FRONTAGE_SIDE_GAP_V2,
  FRONTAGE_UNIT_WIDTH_V2,
  variableFrontageMediaLayout,
  type BuildingLevelV2,
  type FrontageUnitsV2,
} from "./variable-media.js";

export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const HexColor = z.string().regex(/^#[A-Fa-f0-9]{6}$/);
export const CURATED_PALETTES = [
  "#EF8270",
  "#69B9E9",
  "#73D9A6",
  "#F6C85F",
] as const;
export const RenderProfile = z.object({
  version: z.literal(1),
  sourceWidth: z.literal(560),
  sourceHeight: z.literal(640),
  logicalWidth: z.literal(140),
  logicalHeight: z.literal(160),
  anchorX: z.literal(70),
  anchorY: z.literal(160),
  maxHeightByLevel: z.tuple([
    z.literal(70),
    z.literal(100),
    z.literal(130),
    z.literal(160),
  ]),
});
export const DEFAULT_RENDER_PROFILE = RenderProfile.parse({
  version: 1,
  sourceWidth: 560,
  sourceHeight: 640,
  logicalWidth: 140,
  logicalHeight: 160,
  anchorX: 70,
  anchorY: 160,
  maxHeightByLevel: [70, 100, 130, 160],
});

const Rect = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
});
export const AssetManifest = z.object({
  schemaVersion: z.literal(1),
  renderProfileVersion: z.literal(1),
  buildingType: BuildingType,
  level: z.number().int().min(1).max(4),
  spriteHash: Hash,
  thumbnailHash: Hash,
  alphaBounds: Rect,
  logoRect: Rect.nullable(),
  billboardRect: Rect.nullable(),
});
export type AssetManifest = z.infer<typeof AssetManifest>;

export const AssetManifestV2 = z.object({
  schemaVersion: z.literal(2),
  renderProfileVersion: z.literal(2),
  frontageUnits: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  designChoice: z.number().int().min(0).max(4),
  buildingType: BuildingType,
  level: z.number().int().min(1).max(4),
  spriteHash: Hash,
  thumbnailHash: Hash,
  alphaBounds: Rect,
  logoRect: Rect,
  billboardRect: Rect.nullable(),
});
export type AssetManifestV2 = z.infer<typeof AssetManifestV2>;

export function validateAssetManifestV2(input: unknown): AssetManifestV2 {
  const manifest = AssetManifestV2.parse(input);
  const units = manifest.frontageUnits as FrontageUnitsV2;
  const level = manifest.level as BuildingLevelV2;
  const width = units * FRONTAGE_UNIT_WIDTH_V2;
  const bounds = manifest.alphaBounds;
  if (
    bounds.x < FRONTAGE_SIDE_GAP_V2 ||
    bounds.x + bounds.width > width - FRONTAGE_SIDE_GAP_V2 ||
    bounds.y < FRONTAGE_CANVAS_HEIGHT_V2 - FRONTAGE_LEVEL_HEIGHTS_V2[level] ||
    bounds.y + bounds.height > FRONTAGE_CANVAS_HEIGHT_V2 ||
    bounds.y + bounds.height !== FRONTAGE_CANVAS_HEIGHT_V2 ||
    bounds.width < width * FRONTAGE_MIN_VISIBLE_FRACTION_V2
  )
    throw new Error("version-2 facade exceeds its plot or level envelope");
  const layout = variableFrontageMediaLayout(
    units,
    manifest.designChoice,
    level,
  );
  const exact = (
    actual: z.infer<typeof Rect> | null,
    expected: z.infer<typeof Rect> | null,
  ) =>
    actual === null || expected === null
      ? actual === expected
      : actual.x === expected.x &&
        actual.y === expected.y &&
        actual.width === expected.width &&
        actual.height === expected.height;
  if (!exact(manifest.logoRect, layout.logo))
    throw new Error("version-2 logo placement differs from the street sign");
  if (!exact(manifest.billboardRect, layout.billboard))
    throw new Error("version-2 billboard placement differs from the street");
  return manifest;
}

export function validateAssetManifest(input: unknown): AssetManifest {
  const manifest = AssetManifest.parse(input);
  const maxHeight = DEFAULT_RENDER_PROFILE.maxHeightByLevel[manifest.level - 1];
  if (maxHeight === undefined) throw new Error("invalid level");
  const inEnvelope = (rect: z.infer<typeof Rect>) =>
    rect.x + rect.width <= 140 &&
    rect.y + rect.height <= 160 &&
    rect.y >= 160 - maxHeight;
  if (!inEnvelope(manifest.alphaBounds))
    throw new Error("facade pixels exceed level envelope");
  if (manifest.logoRect && !inEnvelope(manifest.logoRect))
    throw new Error("logo placement exceeds level envelope");
  if (
    manifest.billboardRect &&
    (!inEnvelope(manifest.billboardRect) ||
      manifest.billboardRect.width < 48 ||
      manifest.billboardRect.height < 24)
  )
    throw new Error("billboard placement invalid");
  return manifest;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(",")}}`;
}

export async function manifestHash(manifest: AssetManifest): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalJson(validateAssetManifest(manifest)),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function manifestHashV2(
  manifest: AssetManifestV2,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalJson(validateAssetManifestV2(manifest)),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export const AppearanceRevision = z.object({
  revision: z.number().int().positive(),
  owner: z.string().min(2),
  buildingType: BuildingType,
  level: z.number().int().min(1).max(4),
  manifestHash: Hash,
  status: z.enum(["Pending", "Approved", "Rejected", "Revoked"]),
  decidedAt: z.number().int().nonnegative().nullable(),
  reason: z.string().max(500).nullable(),
});
export type AppearanceRevision = z.infer<typeof AppearanceRevision>;

export const AppearanceRecord = z.object({
  revision: z.number().int().positive(),
  buildingType: BuildingType,
  level: z.number().int().min(1).max(4),
  active: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("Preset"),
      variant: z.number().int().min(1).max(2),
      palette: HexColor,
    }),
    z.object({
      kind: z.literal("Custom"),
      manifestHash: Hash,
      approvedAt: z.number().int().nonnegative(),
    }),
  ]),
  pending: AppearanceRevision.nullable(),
  lastDecision: AppearanceRevision.nullable(),
});
export type AppearanceRecord = z.infer<typeof AppearanceRecord>;

export function newPresetAppearance(
  buildingType: z.infer<typeof BuildingType>,
  level: number,
  variant: 1 | 2,
  palette: string,
): AppearanceRecord {
  return AppearanceRecord.parse({
    revision: 1,
    buildingType,
    level,
    active: { kind: "Preset", variant, palette },
    pending: null,
    lastDecision: null,
  });
}

export function proposeAppearance(
  record: AppearanceRecord,
  expectedRevision: number,
  owner: string,
  manifestHash: string,
): AppearanceRecord {
  if (record.revision !== expectedRevision)
    throw new Error("stale appearance revision");
  const next = record.revision + 1;
  if (!Number.isSafeInteger(next))
    throw new Error("appearance revision overflow");
  const pending = AppearanceRevision.parse({
    revision: next,
    owner,
    buildingType: record.buildingType,
    level: record.level,
    manifestHash,
    status: "Pending",
    decidedAt: null,
    reason: null,
  });
  return AppearanceRecord.parse({
    ...record,
    revision: next,
    pending,
    lastDecision: record.pending
      ? {
          ...record.pending,
          status: "Rejected",
          decidedAt: 0,
          reason: "Superseded",
        }
      : record.lastDecision,
  });
}

export function decideAppearance(
  record: AppearanceRecord,
  expected: Pick<
    AppearanceRevision,
    "revision" | "owner" | "buildingType" | "level" | "manifestHash"
  >,
  approved: boolean,
  atSeconds: number,
  reason: string | null = null,
): AppearanceRecord {
  const pending = record.pending;
  if (
    !pending ||
    pending.status !== "Pending" ||
    pending.revision !== expected.revision ||
    pending.owner !== expected.owner ||
    pending.buildingType !== expected.buildingType ||
    pending.level !== expected.level ||
    pending.manifestHash !== expected.manifestHash ||
    record.revision !== expected.revision ||
    record.buildingType !== expected.buildingType ||
    record.level !== expected.level
  )
    throw new Error("stale or mismatched appearance approval");
  if (!approved && !reason) throw new Error("rejection reason required");
  const decision = AppearanceRevision.parse({
    ...pending,
    status: approved ? "Approved" : "Rejected",
    decidedAt: atSeconds,
    reason: approved ? null : reason,
  });
  return AppearanceRecord.parse({
    ...record,
    active: approved
      ? {
          kind: "Custom",
          manifestHash: pending.manifestHash,
          approvedAt: atSeconds,
        }
      : record.active,
    pending: null,
    lastDecision: decision,
  });
}

export function resetAppearanceToPreset(
  record: AppearanceRecord,
  buildingType: z.infer<typeof BuildingType>,
  level: number,
  variant: 1 | 2,
  palette: string,
): AppearanceRecord {
  if (!Number.isSafeInteger(record.revision + 1))
    throw new Error("appearance revision overflow");
  return AppearanceRecord.parse({
    revision: record.revision + 1,
    buildingType,
    level,
    active: { kind: "Preset", variant, palette },
    pending: null,
    lastDecision: record.pending
      ? {
          ...record.pending,
          status: "Rejected",
          decidedAt: 0,
          reason: "Building changed",
        }
      : record.lastDecision,
  });
}
