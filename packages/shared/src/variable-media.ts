export type FrontageUnitsV2 = 1 | 2 | 3;
export type BuildingLevelV2 = 1 | 2 | 3 | 4;
export type FrontageRectV2 = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const FRONTAGE_UNIT_WIDTH_V2 = 85;
export const FRONTAGE_CANVAS_HEIGHT_V2 = 190;
export const FRONTAGE_SIDE_GAP_V2 = 3;
export const FRONTAGE_MIN_VISIBLE_FRACTION_V2 = 0.85;
export const FRONTAGE_LEVEL_HEIGHTS_V2: Record<BuildingLevelV2, number> = {
  1: 70,
  2: 100,
  3: 130,
  4: 160,
};

export const FRONTAGE_DESIGN_IDS_V2: Readonly<
  Record<FrontageUnitsV2, readonly string[]>
> = {
  1: ["news-kiosk", "coffee-pod", "townhouse", "flower-stall", "bike-repair"],
  2: ["corner-shop", "diner", "glass-studio", "bookshop", "arcade"],
  3: [
    "market-hall",
    "garden-bistro",
    "office-campus",
    "food-hall",
    "craft-works",
  ],
};

export const FRONTAGE_SIGN_COLORS_V2: Readonly<
  Record<FrontageUnitsV2, readonly { trim: string; roof: string }[]>
> = {
  1: [
    { trim: "#bb5345", roof: "#793f42" },
    { trim: "#407d80", roof: "#315f65" },
    { trim: "#994f56", roof: "#754250" },
    { trim: "#a55c80", roof: "#814968" },
    { trim: "#59677b", roof: "#465365" },
  ],
  2: [
    { trim: "#e27a58", roof: "#9e5357" },
    { trim: "#cf684f", roof: "#774650" },
    { trim: "#4b8398", roof: "#35596c" },
    { trim: "#77556a", roof: "#674b5b" },
    { trim: "#503a8c", roof: "#413573" },
  ],
  3: [
    { trim: "#ba7050", roof: "#80535a" },
    { trim: "#5e896e", roof: "#426b60" },
    { trim: "#37748b", roof: "#28596e" },
    { trim: "#a9554c", roof: "#77473e" },
    { trim: "#775b59", roof: "#674e51" },
  ],
};

// The order matches the five on-chain design choices for each plot width.
export const BILLBOARD_DESIGN_CHOICES_V2: Readonly<
  Record<FrontageUnitsV2, readonly number[]>
> = {
  1: [],
  2: [1, 4],
  3: [],
};

export function variableDesignHasBillboard(
  units: FrontageUnitsV2,
  designChoice: number,
): boolean {
  if (!Number.isInteger(designChoice) || designChoice < 0 || designChoice > 4)
    throw new Error("Invalid building design choice");
  return BILLBOARD_DESIGN_CHOICES_V2[units].includes(designChoice);
}

export function variableFrontageMediaLayout(
  units: FrontageUnitsV2,
  designChoice: number,
  level: BuildingLevelV2,
  x = 0,
  base = FRONTAGE_CANVAS_HEIGHT_V2,
): {
  facade: FrontageRectV2;
  sign: FrontageRectV2;
  logo: FrontageRectV2;
  name: FrontageRectV2 | null;
  billboard: FrontageRectV2 | null;
} {
  const hasBillboard = variableDesignHasBillboard(units, designChoice);
  const plotWidth = units * FRONTAGE_UNIT_WIDTH_V2;
  const facade: FrontageRectV2 = {
    x: x + FRONTAGE_SIDE_GAP_V2,
    y: base - FRONTAGE_LEVEL_HEIGHTS_V2[level] + 2,
    width: plotWidth - FRONTAGE_SIDE_GAP_V2 * 2,
    height: FRONTAGE_LEVEL_HEIGHTS_V2[level] - 2,
  };
  const signWidth = units === 1 ? 35 : units === 2 ? 83 : 130;
  const signHeight = units === 1 ? 18 : units === 2 ? 22 : 26;
  const sign: FrontageRectV2 = {
    x: facade.x + (facade.width - signWidth) / 2,
    y: base - (units === 1 ? 50 : 57),
    width: signWidth,
    height: signHeight,
  };
  const mark = units === 1 ? 14 : units === 2 ? 20 : 24;
  const logo: FrontageRectV2 = {
    x: sign.x + 4,
    y: sign.y + (sign.height - mark) / 2,
    width: mark,
    height: mark,
  };
  const name: FrontageRectV2 | null =
    units === 1
      ? null
      : {
          x: logo.x + mark + 5,
          y: sign.y,
          width: sign.width - mark - 12,
          height: sign.height,
        };
  const billboard: FrontageRectV2 | null =
    hasBillboard && units > 1 && level >= 3
      ? {
          x: facade.x + (facade.width - (units === 2 ? 88 : 72)) / 2,
          y:
            base -
            FRONTAGE_CANVAS_HEIGHT_V2 +
            (units === 2
              ? designChoice === 4 && level === 4
                ? 84
                : 62
              : level === 3
                ? 72
                : 60),
          width: units === 2 ? 88 : 72,
          height: units === 2 ? 20 : 24,
        }
      : null;
  return { facade, sign, logo, name, billboard };
}
