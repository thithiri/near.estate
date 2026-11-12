import type { CitySeed } from "@estate/shared";

export type Road = CitySeed["streets"][number];
export type RoadConnection = Road["connections"][number];

export const FRONTAGE_PITCH = 170;
export const INTERSECTION_GAP = 76;

export function frontageWidth(
  road: Road,
  index: number,
  side: "North" | "South" = "North",
): number {
  return (road.frontageUnits?.[side][index] ?? 2) * 85;
}

export function frontageX(
  road: Road,
  index: number,
  side: "North" | "South" = "North",
): number {
  const gapsBefore = road.connections.filter(
    (connection) => connection.kind === "Intersection" && connection.at < index,
  ).length;
  let width = 0;
  for (let frontage = 0; frontage < index; frontage++)
    width += frontageWidth(road, frontage, side);
  return width + gapsBefore * INTERSECTION_GAP;
}

export function roadWidth(road: Road): number {
  return (
    Array.from({ length: road.length }, (_, index) =>
      frontageWidth(road, index),
    ).reduce((sum, width) => sum + width, 0) +
    road.connections.filter((connection) => connection.kind === "Intersection")
      .length *
      INTERSECTION_GAP
  );
}

export function intersectionX(road: Road, connection: RoadConnection): number {
  return frontageX(road, connection.at) + frontageWidth(road, connection.at);
}

export function connectionAtX(
  road: Road,
  x: number,
): RoadConnection | undefined {
  return road.connections.find(
    (connection) =>
      connection.kind === "Intersection" &&
      x >= intersectionX(road, connection) &&
      x < intersectionX(road, connection) + INTERSECTION_GAP,
  );
}

export function frontageAtX(
  road: Road,
  x: number,
  side: "North" | "South" = "North",
): number | undefined {
  for (let index = 0; index < road.length; index++) {
    const start = frontageX(road, index, side);
    if (x >= start && x < start + frontageWidth(road, index, side))
      return index;
  }
  return undefined;
}

export function endConnection(
  road: Road,
  direction: -1 | 1,
): RoadConnection | undefined {
  const endpoint = direction < 0 ? 0 : road.length - 1;
  return road.connections.find(
    (connection) => connection.kind === "End" && connection.at === endpoint,
  );
}

export function destination(
  city: CitySeed,
  connection: RoadConnection,
): { roadId: string; side: "North" | "South"; x: number } {
  const road = city.streets.find((entry) => entry.id === connection.toRoadId);
  if (!road) throw new Error("Connected street is missing");
  return {
    roadId: road.id,
    side: connection.toSide,
    x:
      frontageX(road, connection.toAt, connection.toSide) +
      frontageWidth(road, connection.toAt, connection.toSide) / 2,
  };
}

const mapRows: Record<string, number> = { main: 65, market: 150, river: 235 };
const mapColumns: Record<string, number> = { central: 180, harbor: 320 };

export function curbDirection(
  roadId: string,
  side: "North" | "South",
): "North" | "South" | "West" | "East" {
  if (roadId in mapColumns) return side === "North" ? "West" : "East";
  return side;
}

function mapCoordinate(
  value: number,
  anchors: Array<{ world: number; map: number }>,
): number {
  const bounded = Math.max(
    anchors[0]!.world,
    Math.min(value, anchors.at(-1)!.world),
  );
  for (let index = 1; index < anchors.length; index++) {
    const before = anchors[index - 1]!;
    const after = anchors[index]!;
    if (bounded <= after.world) {
      const fraction = (bounded - before.world) / (after.world - before.world);
      return before.map + fraction * (after.map - before.map);
    }
  }
  return anchors.at(-1)!.map;
}

export function cityMapPoint(
  city: CitySeed,
  roadId: string,
  x: number,
  side: "North" | "South" = "North",
): { x: number; y: number } {
  const road = city.streets.find((entry) => entry.id === roadId);
  if (!road) throw new Error("Map street is missing");
  const crossing = (toRoadId: string): number => {
    const connection = road.connections.find(
      (entry) => entry.kind === "Intersection" && entry.toRoadId === toRoadId,
    );
    if (!connection) throw new Error(`Map crossing to ${toRoadId} is missing`);
    return (
      frontageX(road, connection.at, side) +
      frontageWidth(road, connection.at, side) +
      INTERSECTION_GAP / 2
    );
  };
  if (roadId in mapRows) {
    return {
      x: mapCoordinate(x, [
        { world: 0, map: 50 },
        { world: crossing("central"), map: 180 },
        { world: crossing("harbor"), map: 320 },
        { world: roadWidth(road), map: 450 },
      ]),
      y: mapRows[roadId]!,
    };
  }
  if (roadId in mapColumns) {
    return {
      x: mapColumns[roadId]!,
      y: mapCoordinate(x, [
        { world: 0, map: 40 },
        { world: crossing("main"), map: 65 },
        { world: crossing("market"), map: 150 },
        { world: crossing("river"), map: 235 },
        { world: roadWidth(road), map: 260 },
      ]),
    };
  }
  throw new Error("Map street has no drawing axis");
}

export function cityMapCurbPoint(
  city: CitySeed,
  roadId: string,
  x: number,
  side: "North" | "South",
): { x: number; y: number } {
  const center = cityMapPoint(city, roadId, x, side);
  const offset = side === "North" ? -10 : 10;
  return roadId in mapColumns
    ? { x: center.x + offset, y: center.y }
    : { x: center.x, y: center.y + offset };
}
