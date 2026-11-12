import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAFT_STREETS,
  draftParcelLayout,
  UNIT_WIDTH,
} from "./parcel-layout.js";

test("each draft street side has the exact parcel mix and aligned crossings", () => {
  for (const street of DRAFT_STREETS) {
    const north = draftParcelLayout(street.id, "North");
    const south = draftParcelLayout(street.id, "South");
    for (const layout of [north, south]) {
      assert.equal(layout.parcels.length, 10);
      assert.deepEqual(
        [1, 2, 3].map(
          (units) =>
            layout.parcels.filter((plot) => plot.units === units).length,
        ),
        [3, 6, 1],
      );
      assert.equal(
        layout.parcels.reduce((total, plot) => total + plot.spaces, 0),
        18,
      );
      assert.equal(
        layout.parcels.reduce((total, plot) => total + plot.width, 0),
        18 * UNIT_WIDTH,
      );
      assert.equal(layout.crossings.length, street.crossings.length);
    }
    assert.equal(north.width, south.width);
    assert.deepEqual(north.crossings, south.crossings);
    assert.notDeepEqual(
      north.parcels.map((plot) => plot.units),
      south.parcels.map((plot) => plot.units),
    );
  }
});
