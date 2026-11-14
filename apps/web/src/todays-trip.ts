import type { CitySeed, NPCSite } from "@estate/shared";

export type TripProgress = {
  day: string;
  completed: string[];
  collected: string[];
  parkedSessions: Record<string, string>;
};
export type ParkedPlace = { facility: string; locationId: string };

export function todaysTrip(city: CitySeed, now = new Date()): NPCSite[] {
  const stops = city.npcSites.filter((site) =>
    ["Cinema", "BurgerStop", "PracticeCourse", "HorseCourse"].includes(
      site.role,
    ),
  );
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
  const empty: TripProgress = {
    day: tripDay(now),
    completed: [],
    collected: [],
    parkedSessions: {},
  };
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null");
    if (value?.day !== empty.day || !Array.isArray(value.completed))
      return empty;
    const completed = stops
      .filter((stop) => value.completed.includes(stop.id))
      .map((stop) => stop.id);
    const collected = completed.filter(
      (id) => Array.isArray(value.collected) && value.collected.includes(id),
    );
    const parkedSessions = Object.fromEntries(
      completed
        .filter(
          (id) =>
            !collected.includes(id) &&
            typeof value.parkedSessions?.[id] === "string" &&
            value.parkedSessions[id].length > 0,
        )
        .map((id) => [id, value.parkedSessions[id]]),
    );
    return { day: empty.day, completed, collected, parkedSessions };
  } catch {
    return empty;
  }
}

export function markTripActivity(
  progress: TripProgress,
  stopId: string,
  sessionId: string,
): TripProgress {
  if (progress.completed.includes(stopId)) return progress;
  return {
    ...progress,
    completed: [...progress.completed, stopId],
    parkedSessions: { ...progress.parkedSessions, [stopId]: sessionId },
  };
}

export function markTripCollection(
  progress: TripProgress,
  sessionId: string,
): TripProgress {
  const collected = progress.completed.filter(
    (id) =>
      progress.collected.includes(id) ||
      progress.parkedSessions[id] === sessionId,
  );
  if (collected.length === progress.collected.length) return progress;
  const parkedSessions = { ...progress.parkedSessions };
  for (const id of collected) delete parkedSessions[id];
  return { ...progress, collected, parkedSessions };
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
