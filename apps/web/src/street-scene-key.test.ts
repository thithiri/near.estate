import assert from "node:assert/strict";
import test from "node:test";
import type { ChainStreetSide } from "@estate/shared";
import { streetSceneKey } from "./street-scene-key.js";

test("street scene redraws when a parked car expires even if the RPC snapshot is unchanged", () => {
  const street = {
    road_id: "main",
    side: "North",
    plots: [{ slots: [{ expires_at: 100 }, null] }],
  } as unknown as ChainStreetSide;
  const base = {
    roadId: "main",
    side: "North" as const,
    street,
    car: null,
    session: null,
    burgerDecal: false,
  };
  assert.equal(
    streetSceneKey({ ...base, nowSeconds: 98 }),
    streetSceneKey({ ...base, nowSeconds: 99 }),
  );
  assert.notEqual(
    streetSceneKey({ ...base, nowSeconds: 99 }),
    streetSceneKey({ ...base, nowSeconds: 100 }),
  );
});
