export type FrontageUnits = 1 | 2 | 3;
export type DraftStreetId = "main" | "market" | "river" | "central" | "harbor";
export type DraftSide = "North" | "South";

export const UNIT_WIDTH = 85;
export const JUNCTION_WIDTH = 76;

export const DRAFT_STREETS: ReadonlyArray<{
  id: DraftStreetId;
  name: string;
  crossings: readonly string[];
}> = [
  {
    id: "main",
    name: "Main Street",
    crossings: ["Central Avenue", "Harbor Avenue"],
  },
  {
    id: "market",
    name: "Market Street",
    crossings: ["Central Avenue", "Harbor Avenue"],
  },
  {
    id: "river",
    name: "River Street",
    crossings: ["Central Avenue", "Harbor Avenue"],
  },
  {
    id: "central",
    name: "Central Avenue",
    crossings: ["Main Street", "Market Street", "River Street"],
  },
  {
    id: "harbor",
    name: "Harbor Avenue",
    crossings: ["Main Street", "Market Street", "River Street"],
  },
];

const horizontalGroups: ReadonlyArray<readonly FrontageUnits[]> = [
  [2, 2, 1, 1],
  [2, 2, 2],
  [3, 1, 2],
];
const avenueGroups: ReadonlyArray<readonly FrontageUnits[]> = [
  [2, 1],
  [2, 1, 1],
  [2, 2],
  [3, 2, 2],
];

export type DraftParcel = {
  index: number;
  units: FrontageUnits;
  x: number;
  width: number;
  spaces: number;
};

export type DraftLayout = {
  streetId: DraftStreetId;
  side: DraftSide;
  parcels: DraftParcel[];
  crossings: Array<{ x: number; name: string }>;
  width: number;
};

export function draftParcelLayout(
  streetId: DraftStreetId,
  side: DraftSide,
): DraftLayout {
  const street = DRAFT_STREETS.find((entry) => entry.id === streetId);
  if (!street) throw new Error("Unknown draft street");
  const groups =
    street.crossings.length === 2 ? horizontalGroups : avenueGroups;
  const streetOrder = DRAFT_STREETS.findIndex((entry) => entry.id === streetId);
  const parcels: DraftParcel[] = [];
  const crossings: DraftLayout["crossings"] = [];
  let x = 0;
  for (const [groupIndex, group] of groups.entries()) {
    const shift =
      (streetOrder + groupIndex + (side === "South" ? 1 : 0) + 1) % group.length;
    const ordered = [...group.slice(shift), ...group.slice(0, shift)];
    for (const units of ordered) {
      parcels.push({
        index: parcels.length,
        units,
        x,
        width: units * UNIT_WIDTH,
        spaces: units,
      });
      x += units * UNIT_WIDTH;
    }
    if (groupIndex < street.crossings.length) {
      crossings.push({ x, name: street.crossings[groupIndex]! });
      x += JUNCTION_WIDTH;
    }
  }
  return { streetId, side, parcels, crossings, width: x };
}
