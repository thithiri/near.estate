import type { CitySeed, NPCSite } from "@estate/shared";

export type TripProgress = { day: string; completed: string[] };
export type ParkedPlace = { facility: string; locationId: string };

export function todaysTrip(city: CitySeed, now = new Date()): NPCSite[] {
  const stops = city.npcSites.filter((site) => site.role !== "ParkingTower");
  if (stops.length < 2) return [];
  const dayNumber = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) /
      86_400_000,
  );
  const first = dayNumber % stops.length;
  return [stops[first]!, stops[(first + 2) % stops.length]!];
}

export function tripDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function readTripProgress(
  storage: Pick<Storage, "getItem">,
  key: string,
  stops: NPCSite[],
  now = new Date(),
): TripProgress {
  const empty = { day: tripDay(now), completed: [] };
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null");
    if (value?.day !== empty.day || !Array.isArray(value.completed))
      return empty;
    return {
      day: empty.day,
      completed: stops
        .filter((stop) => value.completed.includes(stop.id))
        .map((stop) => stop.id),
    };
  } catch {
    return empty;
  }
}

export function parkedNearStop(
  city: CitySeed,
  stop: NPCSite,
  parked: ParkedPlace | null,
): boolean {
  if (!parked) return false;
  const location =
    parked.facility === "Curb"
      ? city.plots.find((plot) => plot.id === parked.locationId)
      : city.npcSites.find(
          (site) =>
            site.id === parked.locationId && site.role === "ParkingTower",
        );
  if (!location) return false;
  const index = "index" in location ? location.index : location.frontageIndex;
  return (
    location.roadId === stop.roadId &&
    location.side === stop.side &&
    Math.abs(index - stop.frontageIndex) <= 2
  );
}
