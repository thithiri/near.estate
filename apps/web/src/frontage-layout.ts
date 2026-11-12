import {
  FRONTAGE_LEVEL_HEIGHTS_V2,
  FRONTAGE_DESIGN_IDS_V2,
  FRONTAGE_SIDE_GAP_V2,
  variableFrontageMediaLayout,
  type BuildingLevelV2,
  type FrontageRectV2,
} from "@estate/shared";
import type { FrontageUnits } from "./parcel-layout.js";

export type BuildingLevel = BuildingLevelV2;
export type ArtRect = FrontageRectV2;
export const LEVEL_HEIGHTS = FRONTAGE_LEVEL_HEIGHTS_V2;
export const FACADE_SIDE_GAP = FRONTAGE_SIDE_GAP_V2;

export function frontageMediaLayout(
  choice: { id: string; units: FrontageUnits; billboard?: boolean },
  level: BuildingLevel,
  x = 0,
  base = 190,
) {
  return variableFrontageMediaLayout(
    choice.units,
    FRONTAGE_DESIGN_IDS_V2[choice.units].indexOf(choice.id),
    level,
    x,
    base,
  );
}
