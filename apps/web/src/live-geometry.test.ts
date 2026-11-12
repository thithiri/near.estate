import assert from "node:assert/strict";
import test from "node:test";
import { validateCitySeed, type ChainStreetSide } from "@estate/shared";
import rawLegacy from "../../../contracts/estate/seed.json";
import rawVariable from "../../../contracts/estate/seed-v2.json";
import { validateLiveGeometry } from "./live-geometry.js";

function street(city: ReturnType<typeof validateCitySeed>): ChainStreetSide {
  return {
    road_id: "main",
    side: "North",
    plots: city.plots
      .filter((plot) => plot.roadId === "main" && plot.side === "North")
      .map((plot) => ({
        plot: {
          plot: {
            id: plot.id,
            ...(city.version === 2
              ? { frontage_units: plot.frontageUnits }
              : {}),
          },
        },
      })),
  } as unknown as ChainStreetSide;
}

test("live street must match the reported version's checked seed", () => {
  const legacy = validateCitySeed(rawLegacy);
  const variable = validateCitySeed(rawVariable);
  validateLiveGeometry(legacy, street(legacy));
  const variableStreet = street(variable);
  validateLiveGeometry(variable, variableStreet);
  (
    variableStreet.plots[1]!.plot.plot as { frontage_units: number }
  ).frontage_units = 3;
  assert.throws(
    () => validateLiveGeometry(variable, variableStreet),
    /plot width/,
  );
  assert.throws(
    () => validateLiveGeometry(legacy, street(variable)),
    /selected city seed/,
  );
});
