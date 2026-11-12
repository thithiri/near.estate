import { validateCitySeed, type CitySeed } from "@estate/shared";
import {
  DRAFT_STREETS,
  draftParcelLayout,
  type DraftStreetId,
} from "./parcel-layout.js";

function guestIndex(
  roadId: string,
  toRoadId: string,
  kind: string,
  oldAt: number,
): number {
  if (kind === "End") return oldAt === 0 ? 0 : 13;
  if (["main", "market", "river"].includes(roadId))
    return toRoadId === "central" ? 3 : 6;
  return toRoadId === "main" ? 1 : toRoadId === "market" ? 4 : 6;
}

export function createGuestCity(live: CitySeed): CitySeed {
  if (live.version !== 1)
    throw new Error("Guest city needs the original testnet seed");
  const streets = live.streets.map((road) => {
    const streetId = road.id as DraftStreetId;
    if (!DRAFT_STREETS.some((entry) => entry.id === streetId))
      throw new Error(`No guest layout for ${streetId}`);
    return {
      ...road,
      length: 14,
      frontageUnits: {
        North: [
          ...draftParcelLayout(streetId, "North").parcels.map(
            (parcel) => parcel.units,
          ),
          2,
          2,
          2,
          2,
        ],
        South: [
          ...draftParcelLayout(streetId, "South").parcels.map(
            (parcel) => parcel.units,
          ),
          2,
          2,
          2,
          2,
        ],
      },
      connections: road.connections.map((connection) => ({
        ...connection,
        at: guestIndex(
          road.id,
          connection.toRoadId,
          connection.kind,
          connection.at,
        ),
        toAt: guestIndex(
          connection.toRoadId,
          road.id,
          connection.kind,
          connection.toAt,
        ),
      })),
    };
  });
  const plots = streets.flatMap((road) =>
    (["North", "South"] as const).flatMap((side) =>
      Array.from({ length: 10 }, (_, index) => {
        const source = live.plots.find(
          (plot) =>
            plot.roadId === road.id &&
            plot.side === side &&
            plot.index === index % 8,
        );
        if (!source)
          throw new Error(
            `Missing starting plot for ${road.id} ${side} ${index}`,
          );
        return {
          ...source,
          id: `plot-${road.id}-${side === "North" ? "n" : "s"}-${index}`,
          index,
          corner: index === 0 || index === 9,
          frontageUnits: road.frontageUnits[side][index],
        };
      }),
    ),
  );
  const npcSites = live.npcSites.map((site) => ({
    ...site,
    frontageIndex: site.frontageIndex + 2,
  }));
  return validateCitySeed({ version: 2, streets, plots, npcSites });
}
