import type { PlayerPlot } from "@estate/shared";
import catalog from "./illustrated-catalog.json";

type Rect = { x: number; y: number; width: number; height: number };
export type IllustratedPreview = {
  spriteUrl: string;
  logoRect: Rect | null;
  nameRect: Rect | null;
};

const samplePlots: Record<string, { type: string; variant?: number }> = {
  "plot-main-n-5": { type: "retail" },
  "plot-main-n-1": { type: "cafe", variant: 2 },
  "plot-main-n-6": { type: "cafe", variant: 1 },
  "plot-market-n-1": { type: "restaurant" },
  "plot-river-n-1": { type: "office" },
  "plot-central-n-1": { type: "homes" },
};

const mediaRects: Record<
  string,
  { logoRect: Rect | null; nameRect: Rect | null }
> = {
  retail: {
    logoRect: { x: 18, y: 78, width: 20, height: 20 },
    nameRect: { x: 51, y: 99, width: 66, height: 10 },
  },
  "cafe:1": {
    logoRect: { x: 59, y: 82, width: 22, height: 18 },
    nameRect: { x: 48, y: 105, width: 44, height: 10 },
  },
  "cafe:2": {
    logoRect: { x: 27, y: 97, width: 12, height: 12 },
    nameRect: { x: 48, y: 97, width: 60, height: 12 },
  },
  restaurant: {
    logoRect: null,
    nameRect: { x: 45, y: 101, width: 50, height: 13 },
  },
  office: {
    logoRect: null,
    nameRect: { x: 48, y: 85, width: 36, height: 13 },
  },
  homes: { logoRect: null, nameRect: null },
};

export function illustratedPreviewForType(
  buildingType: string,
  variant?: number,
): IllustratedPreview | null {
  const key = buildingType.toLowerCase();
  const entry = catalog.facades.find(
    (facade) =>
      facade.type === key &&
      (variant === undefined ||
        ("variant" in facade && facade.variant === variant)),
  );
  const rects =
    mediaRects[
      variant === undefined && key === "cafe" ? "cafe:1" : `${key}:${variant}`
    ] ?? mediaRects[key];
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
    (sample.variant === undefined || sample.variant === plot.initialVariant)
    ? illustratedPreviewForType(plot.initialType, sample.variant)
    : null;
}
