import type { PlayerPlot } from "@estate/shared";
import catalog from "./illustrated-catalog.json";

type Rect = { x: number; y: number; width: number; height: number };
export type IllustratedPreview = {
  spriteUrl: string;
  logoRect: Rect | null;
  nameRect: Rect | null;
};

const samplePlots: Record<string, string> = {
  "plot-main-n-5": "retail",
  "plot-main-n-1": "cafe",
  "plot-market-n-1": "restaurant",
  "plot-river-n-1": "office",
  "plot-central-n-1": "homes",
};

const mediaRects: Record<
  string,
  { logoRect: Rect | null; nameRect: Rect | null }
> = {
  retail: {
    logoRect: { x: 18, y: 78, width: 20, height: 20 },
    nameRect: { x: 51, y: 99, width: 66, height: 10 },
  },
  cafe: {
    logoRect: { x: 59, y: 82, width: 22, height: 18 },
    nameRect: { x: 48, y: 105, width: 44, height: 10 },
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

export function illustratedPreviewForPlot(
  plot: PlayerPlot,
): IllustratedPreview | null {
  const key = samplePlots[plot.id];
  if (!key || key !== plot.initialType.toLowerCase()) return null;
  const entry = catalog.facades.find((facade) => facade.type === key);
  const rects = mediaRects[key];
  if (!entry || !rects) return null;
  return {
    spriteUrl: `${import.meta.env.BASE_URL}illustrated/${entry.sprite}?v=${entry.sha256.slice(0, 16)}`,
    ...rects,
  };
}
