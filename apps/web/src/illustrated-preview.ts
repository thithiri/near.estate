import type { PlayerPlot } from "@estate/shared";
import catalog from "./illustrated-catalog.json";

type Rect = { x: number; y: number; width: number; height: number };
export type IllustratedPreview = {
  level: number;
  spriteUrl: string;
  logoRect: Rect | null;
  nameRect: Rect | null;
  billboardRect?: Rect;
};

const samplePlots: Record<string, { type: string; variant: 1 | 2 }> = {
  "plot-main-n-0": { type: "retail", variant: 1 },
  "plot-central-n-2": { type: "retail", variant: 1 },
  "plot-main-n-5": { type: "retail", variant: 2 },
  "plot-river-n-3": { type: "retail", variant: 2 },
  "plot-main-n-1": { type: "cafe", variant: 2 },
  "plot-main-n-6": { type: "cafe", variant: 1 },
  "plot-market-n-0": { type: "cafe", variant: 1 },
  "plot-central-n-3": { type: "cafe", variant: 2 },
  "plot-main-n-2": { type: "restaurant", variant: 1 },
  "plot-river-n-0": { type: "restaurant", variant: 1 },
  "plot-market-n-1": { type: "restaurant", variant: 2 },
  "plot-main-n-7": { type: "restaurant", variant: 2 },
  "plot-market-n-2": { type: "office", variant: 1 },
  "plot-central-n-0": { type: "office", variant: 1 },
  "plot-river-n-1": { type: "office", variant: 2 },
  "plot-main-n-3": { type: "office", variant: 2 },
  "plot-central-n-6": { type: "homes", variant: 1 },
  "plot-central-n-1": { type: "homes", variant: 2 },
  "plot-main-n-4": { type: "homes", variant: 1 },
  "plot-market-n-3": { type: "homes", variant: 2 },
};

const mediaRects: Record<
  string,
  { logoRect: Rect | null; nameRect: Rect | null; billboardRect?: Rect }
> = {
  "retail:1": {
    logoRect: { x: 18, y: 78, width: 20, height: 20 },
    nameRect: { x: 51, y: 99, width: 66, height: 10 },
  },
  "retail:2": {
    logoRect: { x: 20, y: 109, width: 12, height: 12 },
    nameRect: { x: 40, y: 110, width: 78, height: 11 },
  },
  "retail:1:1": {
    logoRect: { x: 17, y: 99, width: 17, height: 17 },
    nameRect: { x: 52, y: 108, width: 66, height: 10 },
  },
  "retail:1:3": {
    logoRect: { x: 20, y: 45, width: 20, height: 20 },
    nameRect: { x: 51, y: 99, width: 68, height: 10 },
  },
  "retail:1:4": {
    logoRect: { x: 20, y: 28, width: 20, height: 20 },
    nameRect: { x: 50, y: 100, width: 70, height: 11 },
  },
  "retail:2:1": {
    logoRect: { x: 20, y: 120, width: 16, height: 13 },
    nameRect: { x: 40, y: 122, width: 82, height: 10 },
  },
  "retail:2:3": {
    logoRect: { x: 18, y: 112, width: 16, height: 16 },
    nameRect: { x: 37, y: 112, width: 82, height: 16 },
  },
  "retail:2:4": {
    logoRect: { x: 16, y: 103, width: 17, height: 16 },
    nameRect: { x: 36, y: 103, width: 82, height: 16 },
  },
  "cafe:1": {
    logoRect: { x: 59, y: 82, width: 22, height: 18 },
    nameRect: { x: 48, y: 105, width: 44, height: 10 },
  },
  "cafe:2": {
    logoRect: { x: 27, y: 97, width: 12, height: 12 },
    nameRect: { x: 48, y: 97, width: 60, height: 12 },
  },
  "cafe:1:1": {
    logoRect: { x: 62, y: 104, width: 16, height: 14 },
    nameRect: { x: 47, y: 119, width: 47, height: 7 },
  },
  "cafe:1:3": {
    logoRect: { x: 61, y: 53, width: 18, height: 18 },
    nameRect: { x: 39, y: 112, width: 62, height: 8 },
  },
  "cafe:1:4": {
    logoRect: { x: 61, y: 22, width: 17, height: 17 },
    nameRect: { x: 42, y: 110, width: 57, height: 10 },
  },
  "cafe:2:1": {
    logoRect: { x: 27, y: 105, width: 14, height: 13 },
    nameRect: { x: 48, y: 106, width: 62, height: 9 },
  },
  "cafe:2:3": {
    logoRect: { x: 28, y: 97, width: 13, height: 11 },
    nameRect: { x: 50, y: 98, width: 60, height: 10 },
  },
  "cafe:2:4": {
    logoRect: { x: 28, y: 98, width: 13, height: 13 },
    nameRect: { x: 50, y: 98, width: 60, height: 12 },
  },
  "restaurant:1": {
    logoRect: null,
    nameRect: { x: 45, y: 101, width: 50, height: 13 },
  },
  "restaurant:2": {
    logoRect: { x: 30, y: 119, width: 14, height: 13 },
    nameRect: { x: 93, y: 125, width: 35, height: 8 },
  },
  "restaurant:1:1": {
    logoRect: null,
    nameRect: { x: 44, y: 118, width: 52, height: 10 },
  },
  "restaurant:1:3": {
    logoRect: null,
    nameRect: { x: 49, y: 117, width: 44, height: 10 },
    billboardRect: { x: 34, y: 40, width: 72, height: 18 },
  },
  "restaurant:1:4": {
    logoRect: null,
    nameRect: { x: 49, y: 117, width: 44, height: 10 },
    billboardRect: { x: 30, y: 12, width: 80, height: 18 },
  },
  "restaurant:2:1": {
    logoRect: { x: 30, y: 118, width: 11, height: 11 },
    nameRect: { x: 96, y: 128, width: 34, height: 8 },
  },
  "restaurant:2:3": {
    logoRect: { x: 39, y: 46, width: 14, height: 14 },
    nameRect: { x: 67, y: 107, width: 55, height: 10 },
  },
  "restaurant:2:4": {
    logoRect: { x: 37, y: 18, width: 12, height: 14 },
    nameRect: { x: 65, y: 101, width: 55, height: 10 },
  },
  "office:1": {
    logoRect: null,
    nameRect: { x: 48, y: 85, width: 36, height: 13 },
  },
  "office:2": {
    logoRect: { x: 16, y: 81, width: 11, height: 11 },
    nameRect: { x: 34, y: 82, width: 66, height: 10 },
  },
  "office:1:1": {
    logoRect: null,
    nameRect: { x: 23, y: 115, width: 79, height: 8 },
  },
  "office:1:3": {
    logoRect: null,
    nameRect: { x: 35, y: 47, width: 59, height: 9 },
  },
  "office:1:4": {
    logoRect: null,
    nameRect: { x: 37, y: 82, width: 59, height: 20 },
  },
  "office:2:1": {
    logoRect: { x: 16, y: 116, width: 10, height: 9 },
    nameRect: { x: 33, y: 117, width: 71, height: 8 },
  },
  "office:2:3": {
    logoRect: { x: 15, y: 118, width: 13, height: 11 },
    nameRect: { x: 33, y: 120, width: 69, height: 9 },
  },
  "office:2:4": {
    logoRect: { x: 23, y: 23, width: 19, height: 13 },
    nameRect: { x: 45, y: 24, width: 48, height: 10 },
  },
  "homes:1": { logoRect: null, nameRect: null },
  "homes:2": { logoRect: null, nameRect: null },
};

export function illustratedPreviewForType(
  buildingType: string,
  variant: 1 | 2,
  level = 2,
): IllustratedPreview | null {
  const key = buildingType.toLowerCase();
  const entry = catalog.facades.find(
    (facade) =>
      facade.type === key &&
      facade.variant === variant &&
      facade.level === level,
  );
  const rects =
    mediaRects[`${key}:${variant}:${level}`] ?? mediaRects[`${key}:${variant}`];
  if (!entry || !rects) return null;
  return {
    level,
    spriteUrl: `${import.meta.env?.BASE_URL ?? "/"}illustrated/${entry.sprite}?v=${entry.sha256.slice(0, 16)}`,
    ...rects,
  };
}

export function illustratedPreviewForPlot(
  plot: PlayerPlot,
): IllustratedPreview | null {
  const sample = samplePlots[plot.id];
  if (
    sample?.type !== plot.initialType.toLowerCase() ||
    sample.variant !== plot.initialVariant
  )
    return null;
  const level = (plot.index % 4) + 1;
  return (
    illustratedPreviewForType(plot.initialType, sample.variant, level) ??
    (level > 2
      ? illustratedPreviewForType(plot.initialType, sample.variant, 2)
      : null)
  );
}
