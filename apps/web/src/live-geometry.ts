import type { ChainStreetSide, CitySeed } from "@estate/shared";

export function validateLiveGeometry(
  city: CitySeed,
  street: ChainStreetSide,
): void {
  const expected = city.plots
    .filter(
      (plot) => plot.roadId === street.road_id && plot.side === street.side,
    )
    .sort((a, b) => a.index - b.index);
  if (street.plots.length !== expected.length)
    throw new Error("Contract street does not match the selected city seed");
  for (const [index, entry] of street.plots.entries()) {
    const plot = expected[index];
    if (!plot || entry.plot.plot.id !== plot.id)
      throw new Error("Contract plot order does not match the city seed");
    const chainPlot = entry.plot.plot;
    if (city.version === 2) {
      if (
        !("frontage_units" in chainPlot) ||
        chainPlot.frontage_units !== plot.frontageUnits
      )
        throw new Error(`Contract plot width does not match ${plot.id}`);
    } else if ("frontage_units" in chainPlot) {
      throw new Error("Contract city version does not match the city seed");
    }
  }
}
