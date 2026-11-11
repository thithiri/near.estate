import type { PlayerPlot } from "@estate/shared";
import catalog from "./illustrated-catalog.json";

type Rect = { x: number; y: number; width: number; height: number };
export type IllustratedPreview = {
  spriteUrl: string;
  logoRect: Rect | null;
  nameRect: Rect | null;
};

const samplePlots: Record<string, { type: string; variant: 1 | 2 }> = {
  "plot-central-n-2": { type: "retail", variant: 1 },
  "plot-main-n-5": { type: "retail", variant: 2 },
  "plot-main-n-1": { type: "cafe", variant: 2 },
  "plot-main-n-6": { type: "cafe", variant: 1 },
  "plot-main-n-2": { type: "restaurant", variant: 1 },
  "plot-market-n-1": { type: "restaurant", variant: 2 },
  "plot-market-n-2": { type: "office", variant: 1 },
  "plot-river-n-1": { type: "office", variant: 2 },
  "plot-central-n-6": { type: "homes", variant: 1 },
  "plot-central-n-1": { type: "homes", variant: 2 },
};

const mediaRects: Record<
  string,
  { logoRect: Rect | null; nameRect: Rect | null }
> = {
  "retail:1": {
    logoRect: { x: 18, y: 78, width: 20, height: 20 },
    nameRect: { x: 51, y: 99, width: 66, height: 10 },
  },
  "retail:2": {
    logoRect: { x: 20, y: 109, width: 12, height: 12 },
    nameRect: { x: 40, y: 110, width: 78, height: 11 },
  },
  "cafe:1": {
    logoRect: { x: 59, y: 82, width: 22, height: 18 },
    nameRect: { x: 48, y: 105, width: 44, height: 10 },
  },
  "cafe:2": {
    logoRect: { x: 27, y: 97, width: 12, height: 12 },
    nameRect: { x: 48, y: 97, width: 60, height: 12 },
  },
  "restaurant:1": {
    logoRect: null,
    nameRect: { x: 45, y: 101, width: 50, height: 13 },
  },
  "restaurant:2": {
    logoRect: { x: 30, y: 119, width: 14, height: 13 },
    nameRect: { x: 93, y: 125, width: 35, height: 8 },
  },
  "office:1": {
    logoRect: null,
    nameRect: { x: 48, y: 85, width: 36, height: 13 },
  },
  "office:2": {
    logoRect: { x: 16, y: 81, width: 11, height: 11 },
    nameRect: { x: 34, y: 82, width: 66, height: 10 },
  },
  "homes:1": { logoRect: null, nameRect: null },
  "homes:2": { logoRect: null, nameRect: null },
};

export function illustratedPreviewForType(
  buildingType: string,
  variant: 1 | 2,
): IllustratedPreview | null {
  const key = buildingType.toLowerCase();
  const entry = catalog.facades.find(
    (facade) => facade.type === key && facade.variant === variant,
  );
  const rects = mediaRects[`${key}:${variant}`];
  if (!entry || !rects) return null;
  return {
    spriteUrl: `${import.meta.env?.BASE_URL ?? "/"}illustrated/${entry.sprite}?v=${entry.sha256.slice(0, 16)}`,
    ...rects,
  };
}

export function illustratedPreviewForPlot(
  plot: PlayerPlot,
): IllustratedPreview | null {
  const sample = samplePlots[plot.id];
  return sample?.type === plot.initialType.toLowerCase() &&
    sample.variant === plot.initialVariant
    ? illustratedPreviewForType(plot.initialType, sample.variant)
    : null;
}
