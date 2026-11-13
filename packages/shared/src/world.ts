import { z } from "zod";
import { CoinString } from "./money.js";

export const RoadId = z.enum(["main", "market", "river", "central", "harbor"]);
export const Side = z.enum(["North", "South"]);
export const BuildingType = z.enum([
  "Retail",
  "Cafe",
  "Restaurant",
  "Office",
  "Homes",
]);
export type BuildingType = z.infer<typeof BuildingType>;
export const BuildingVariant = z.number().int().min(1).max(2);
export const CarBody = z.enum([
  "Hatchback",
  "Sedan",
  "SportsCoupe",
  "SUV",
  "Pickup",
  "Microvan",
]);
export const CarColor = z.enum(["Red", "Blue", "Yellow", "Green"]);
export const ParkingRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Free") }),
  z.object({ kind: z.literal("Meter"), ratePerHour: CoinString }),
  z.object({ kind: z.literal("ColorOnly"), color: CarColor }),
  z.object({ kind: z.literal("NoParking") }),
]);
export type ParkingRule = z.infer<typeof ParkingRule>;

export const PlayerPlot = z.object({
  id: z
    .string()
    .regex(/^plot-(main|market|river|central|harbor)-(n|s)-([0-9])$/),
  roadId: RoadId,
  side: Side,
  index: z.number().int().min(0).max(9),
  corner: z.boolean(),
  initialType: BuildingType,
  initialVariant: BuildingVariant,
  frontageUnits: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});
export type PlayerPlot = z.infer<typeof PlayerPlot>;

export const ServiceRole = z.enum([
  "ParkingTower",
  "RepairGarage",
  "Cinema",
  "BurgerStop",
  "PracticeCourse",
  "HorseCourse",
]);
export const NPCSite = z.object({
  id: z.string().regex(/^npc-[a-z0-9-]+$/),
  roadId: RoadId,
  side: Side,
  frontageIndex: z.number().int().min(8).max(31),
  role: ServiceRole,
  name: z.string().min(1).max(40),
  capacity: z.number().int().min(0).max(256),
});
export type NPCSite = z.infer<typeof NPCSite>;

export const StreetConnection = z.object({
  at: z.number().int().min(0).max(31),
  toRoadId: RoadId,
  toAt: z.number().int().min(0).max(31),
  toSide: Side,
  facing: z.enum(["Left", "Right"]),
  kind: z.enum(["Intersection", "End"]),
});
export const Street = z.object({
  id: RoadId,
  name: z.string().min(1).max(40),
  length: z.number().int().min(8).max(32),
  connections: z.array(StreetConnection),
  frontageUnits: z
    .object({
      North: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])),
      South: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])),
    })
    .optional(),
});

export const PlayerCurbSpace = z.object({
  kind: z.literal("PlayerCurb"),
  plotId: PlayerPlot.shape.id,
  slot: z.number().int().min(0).max(2),
});
export const TowerSpace = z.object({
  kind: z.literal("Tower"),
  siteId: NPCSite.shape.id,
  space: z.number().int().min(0).max(31),
});
export const ParkingSpaceId = z.discriminatedUnion("kind", [
  PlayerCurbSpace,
  TowerSpace,
]);
export type ParkingSpaceId = z.infer<typeof ParkingSpaceId>;

export const CitySeed = z.discriminatedUnion("version", [
  z.object({
    version: z.literal(1),
    streets: z.array(Street).length(5),
    plots: z.array(PlayerPlot).length(80),
    npcSites: z.array(NPCSite).length(7),
  }),
  z.object({
    version: z.literal(2),
    streets: z.array(Street).length(5),
    plots: z.array(PlayerPlot).length(100),
    npcSites: z.array(NPCSite).min(7).max(8),
  }),
]);
export type CitySeed = z.infer<typeof CitySeed>;

export function validateCitySeed(input: unknown): CitySeed {
  const seed = CitySeed.parse(input);
  const streetIds = new Set(seed.streets.map((street) => street.id));
  if (streetIds.size !== 5) throw new Error("street IDs must be unique");
  const streetById = new Map(seed.streets.map((street) => [street.id, street]));
  const plotIds = new Set<string>();
  const frontages = new Set<string>();
  for (const plot of seed.plots) {
    if (
      seed.version === 1 &&
      (plot.index > 7 ||
        (plot.frontageUnits !== undefined && plot.frontageUnits !== 2))
    )
      throw new Error(`legacy plot frontage is invalid: ${plot.id}`);
    if (plotIds.has(plot.id)) throw new Error(`duplicate plot ${plot.id}`);
    plotIds.add(plot.id);
    const expectedId = `plot-${plot.roadId}-${plot.side === "North" ? "n" : "s"}-${plot.index}`;
    if (plot.id !== expectedId)
      throw new Error(`plot ID does not match position: ${plot.id}`);
    if (
      plot.corner !==
      (plot.index === 0 || plot.index === (seed.version === 1 ? 7 : 9))
    )
      throw new Error(`corner flag does not match position: ${plot.id}`);
    if (seed.version === 2) {
      const road = streetById.get(plot.roadId);
      if (
        !road?.frontageUnits ||
        road.frontageUnits[plot.side][plot.index] !== plot.frontageUnits
      )
        throw new Error(`plot frontage does not match street: ${plot.id}`);
    }
    const key = `${plot.roadId}:${plot.side}:${plot.index}`;
    if (frontages.has(key)) throw new Error(`overlapping frontage ${key}`);
    frontages.add(key);
  }
  const siteIds = new Set<string>();
  for (const site of seed.npcSites) {
    if (siteIds.has(site.id)) throw new Error(`duplicate NPC site ${site.id}`);
    siteIds.add(site.id);
    if (site.frontageIndex >= (streetById.get(site.roadId)?.length ?? 0))
      throw new Error(`NPC site outside street: ${site.id}`);
    if (seed.version === 2 && site.frontageIndex < 10)
      throw new Error(`NPC site overlaps player frontage: ${site.id}`);
    const key = `${site.roadId}:${site.side}:${site.frontageIndex}`;
    if (frontages.has(key)) throw new Error(`overlapping frontage ${key}`);
    frontages.add(key);
    if ((site.role === "ParkingTower") !== (site.capacity === 32))
      throw new Error(`invalid capacity for ${site.id}`);
  }
  if (seed.npcSites.filter((site) => site.role === "ParkingTower").length !== 3)
    throw new Error("city needs three parking towers");
  const horseCourses = seed.npcSites.filter(
    (site) => site.role === "HorseCourse",
  );
  if (
    seed.version === 1
      ? horseCourses.length !== 0
      : horseCourses.length !== seed.npcSites.length - 7
  )
    throw new Error("version-2 city may add exactly one horse course");
  for (const road of seed.streets) {
    if (seed.version === 1 && road.frontageUnits)
      throw new Error(`legacy street has variable frontage: ${road.id}`);
    if (seed.version === 2) {
      if (road.length !== 14)
        throw new Error(
          `variable street must have fourteen frontages: ${road.id}`,
        );
      if (
        !road.frontageUnits ||
        road.frontageUnits.North.length !== road.length ||
        road.frontageUnits.South.length !== road.length
      )
        throw new Error(`missing variable frontage on ${road.id}`);
      const sideLength = (side: "North" | "South") =>
        road.frontageUnits![side].reduce((sum, width) => sum + width, 0);
      if (sideLength("North") !== sideLength("South"))
        throw new Error(
          `opposite road sides have different lengths: ${road.id}`,
        );
      for (const side of ["North", "South"] as const) {
        const widths = road.frontageUnits[side].slice(0, 10);
        if (
          [1, 2, 3].some(
            (units, offset) =>
              widths.filter((width) => width === units).length !==
              [3, 6, 1][offset],
          )
        )
          throw new Error(`wrong frontage mix on ${road.id} ${side}`);
        if (road.frontageUnits[side].slice(10).some((width) => width !== 2))
          throw new Error(
            `NPC frontage must remain two units on ${road.id} ${side}`,
          );
      }
    }
    const connectionPositions = new Set<number>();
    const connectionTargets = new Set<string>();
    for (const side of ["North", "South"] as const) {
      if (
        seed.plots.filter(
          (plot) => plot.roadId === road.id && plot.side === side,
        ).length !== (seed.version === 1 ? 8 : 10)
      )
        throw new Error(
          `${road.id} ${side} needs ${seed.version === 1 ? 8 : 10} player plots`,
        );
    }
    for (const connection of road.connections) {
      if (connectionPositions.has(connection.at))
        throw new Error(
          `duplicate road junction at ${road.id}:${connection.at}`,
        );
      connectionPositions.add(connection.at);
      const targetKey = `${connection.kind}:${connection.toRoadId}`;
      if (connectionTargets.has(targetKey))
        throw new Error(
          `duplicate road connection from ${road.id} to ${connection.toRoadId}`,
        );
      connectionTargets.add(targetKey);
      if (
        connection.at >= road.length ||
        connection.toAt >= (streetById.get(connection.toRoadId)?.length ?? 0)
      )
        throw new Error(`connection outside street from ${road.id}`);
      if (seed.version === 2 && connection.kind === "Intersection") {
        const northWidth = road
          .frontageUnits!.North.slice(0, connection.at + 1)
          .reduce((sum, width) => sum + width, 0);
        const southWidth = road
          .frontageUnits!.South.slice(0, connection.at + 1)
          .reduce((sum, width) => sum + width, 0);
        if (northWidth !== southWidth)
          throw new Error(`intersection sides misaligned: ${road.id}`);
      }
      if (
        !streetIds.has(connection.toRoadId) ||
        connection.toRoadId === road.id
      )
        throw new Error(`invalid road connection from ${road.id}`);
      if (
        connection.kind === "End" &&
        connection.at !== 0 &&
        connection.at !== road.length - 1
      )
        throw new Error(`end connection must be at a road edge: ${road.id}`);
      if (
        connection.kind === "Intersection" &&
        (connection.at === 0 || connection.at >= road.length - 1)
      )
        throw new Error(`intersection must be inside a road: ${road.id}`);
      const reverse = seed.streets
        .find((street) => street.id === connection.toRoadId)
        ?.connections.some(
          (other) =>
            other.toRoadId === road.id &&
            other.toAt === connection.at &&
            other.at === connection.toAt &&
            other.kind === connection.kind,
        );
      if (!reverse)
        throw new Error(
          `missing reverse connection from ${connection.toRoadId} to ${road.id}`,
        );
    }
  }
  const reachable = new Set([seed.streets[0]!.id]);
  const frontier = [seed.streets[0]!.id];
  for (let index = 0; index < frontier.length; index++) {
    const road = streetById.get(frontier[index]!);
    if (!road) throw new Error("connected street is missing");
    for (const connection of road.connections) {
      if (reachable.has(connection.toRoadId)) continue;
      reachable.add(connection.toRoadId);
      frontier.push(connection.toRoadId);
    }
  }
  if (reachable.size !== seed.streets.length)
    throw new Error("road graph is disconnected");
  return seed;
}
