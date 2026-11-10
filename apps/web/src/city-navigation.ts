import type { CitySeed } from "@estate/shared";

export type Road = CitySeed["streets"][number];
export type RoadConnection = Road["connections"][number];

export const FRONTAGE_PITCH = 170;
export const INTERSECTION_GAP = 76;

export function frontageX(road: Road, index: number): number {
  const gapsBefore = road.connections.filter(
    (connection) => connection.kind === "Intersection" && connection.at < index,
  ).length;
  return index * FRONTAGE_PITCH + gapsBefore * INTERSECTION_GAP;
}

export function roadWidth(road: Road): number {
  return (
    road.length * FRONTAGE_PITCH +
    road.connections.filter((connection) => connection.kind === "Intersection")
      .length *
      INTERSECTION_GAP
  );
}

export function intersectionX(road: Road, connection: RoadConnection): number {
  return frontageX(road, connection.at) + FRONTAGE_PITCH;
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

export function frontageAtX(road: Road, x: number): number | undefined {
  for (let index = 0; index < road.length; index++) {
    const start = frontageX(road, index);
    if (x >= start && x < start + FRONTAGE_PITCH) return index;
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
    x: frontageX(road, connection.toAt) + FRONTAGE_PITCH / 2,
  };
}

const mapRows: Record<string, number> = { main: 65, market: 150, river: 235 };
const mapColumns: Record<string, number> = { central: 180, harbor: 320 };

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
): { x: number; y: number } {
  const road = city.streets.find((entry) => entry.id === roadId);
  if (!road) throw new Error("Map street is missing");
  const crossing = (toRoadId: string): number => {
    const connection = road.connections.find(
      (entry) => entry.kind === "Intersection" && entry.toRoadId === toRoadId,
    );
    if (!connection) throw new Error(`Map crossing to ${toRoadId} is missing`);
    return intersectionX(road, connection) + INTERSECTION_GAP / 2;
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
