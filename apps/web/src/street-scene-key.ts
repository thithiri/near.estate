import type { ChainCar, ChainSession, ChainStreetSide } from "@estate/shared";

export function streetSceneKey(input: {
  roadId: string;
  side: "North" | "South";
  street: ChainStreetSide | null;
  car: ChainCar | null | undefined;
  session: ChainSession | null | undefined;
  burgerDecal: boolean;
  nowSeconds: number;
}): string {
  const { roadId, side, street, car, session, burgerDecal, nowSeconds } = input;
  return JSON.stringify([
    roadId,
    side,
    street,
    street?.plots.map((entry) =>
      entry.slots.map((slot) => Boolean(slot && nowSeconds >= slot.expires_at)),
    ),
    car && [car.id, car.body, car.color, car.parked_session_id],
    session && [session.id, session.facility, session.location_id],
    burgerDecal,
  ]);
}
