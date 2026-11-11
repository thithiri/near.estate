import { BuildingType } from "@estate/shared";

const shapeNames: Record<
  (typeof BuildingType.options)[number],
  readonly [string, string]
> = {
  Retail: ["Corner shop", "Market hall"],
  Cafe: ["Glasshouse", "Pergola"],
  Restaurant: ["Diner", "Bistro"],
  Office: ["Glass block", "Studio"],
  Homes: ["Terrace", "Townhouse"],
};

export function buildingShapeName(
  type: (typeof BuildingType.options)[number],
  variant: 1 | 2,
): string {
  return shapeNames[type][variant - 1]!;
}
