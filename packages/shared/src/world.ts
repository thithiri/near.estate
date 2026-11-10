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
  id: z.string().regex(/^plot-(main|market|river|central|harbor)-(n|s)-[0-7]$/),
  roadId: RoadId,
  side: Side,
  index: z.number().int().min(0).max(7),
  corner: z.boolean(),
  initialType: BuildingType,
  initialVariant: BuildingVariant,
});
export type PlayerPlot = z.infer<typeof PlayerPlot>;

export const ServiceRole = z.enum([
  "ParkingTower",
  "RepairGarage",
  "Cinema",
  "BurgerStop",
  "PracticeCourse",
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
});

export const PlayerCurbSpace = z.object({
  kind: z.literal("PlayerCurb"),
  plotId: PlayerPlot.shape.id,
  slot: z.number().int().min(0).max(1),
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

export const CitySeed = z.object({
  version: z.literal(1),
  streets: z.array(Street).length(5),
  plots: z.array(PlayerPlot).length(80),
  npcSites: z.array(NPCSite).length(7),
});
export type CitySeed = z.infer<typeof CitySeed>;

export function validateCitySeed(input: unknown): CitySeed {
  const seed = CitySeed.parse(input);
  const streetIds = new Set(seed.streets.map((street) => street.id));
  if (streetIds.size !== 5) throw new Error("street IDs must be unique");
  const streetById = new Map(seed.streets.map((street) => [street.id, street]));
  const plotIds = new Set<string>();
  const frontages = new Set<string>();
  for (const plot of seed.plots) {
    if (plotIds.has(plot.id)) throw new Error(`duplicate plot ${plot.id}`);
    plotIds.add(plot.id);
    const expectedId = `plot-${plot.roadId}-${plot.side === "North" ? "n" : "s"}-${plot.index}`;
    if (plot.id !== expectedId)
      throw new Error(`plot ID does not match position: ${plot.id}`);
    if (plot.corner !== (plot.index === 0 || plot.index === 7))
      throw new Error(`corner flag does not match position: ${plot.id}`);
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
    const key = `${site.roadId}:${site.side}:${site.frontageIndex}`;
    if (frontages.has(key)) throw new Error(`overlapping frontage ${key}`);
    frontages.add(key);
    if ((site.role === "ParkingTower") !== (site.capacity === 32))
      throw new Error(`invalid capacity for ${site.id}`);
  }
  if (seed.npcSites.filter((site) => site.role === "ParkingTower").length !== 3)
    throw new Error("city needs three parking towers");
  for (const road of seed.streets) {
    const connectionPositions = new Set<number>();
    const connectionTargets = new Set<string>();
    for (const side of ["North", "South"] as const) {
      if (
        seed.plots.filter(
          (plot) => plot.roadId === road.id && plot.side === side,
        ).length !== 8
      )
        throw new Error(`${road.id} ${side} needs eight player plots`);
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
  return seed;
}
