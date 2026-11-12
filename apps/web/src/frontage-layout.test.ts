import assert from "node:assert/strict";
import test from "node:test";
import { choices } from "./frontage-art.js";
import {
  FRONTAGE_DESIGN_IDS_V2,
  FRONTAGE_SIGN_COLORS_V2,
  variableDesignHasBillboard,
} from "@estate/shared";
import {
  frontageMediaLayout,
  FACADE_SIDE_GAP,
  LEVEL_HEIGHTS,
  type ArtRect,
  type BuildingLevel,
} from "./frontage-layout.js";

function overlaps(a: ArtRect, b: ArtRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

test("all fifteen designs keep logo, name and optional billboard inside level bounds", () => {
  assert.equal(choices.length, 15);
  for (const units of [1, 2, 3] as const) {
    const matched = choices.filter((choice) => choice.units === units);
    assert.deepEqual(
      matched.map((choice) => choice.id),
      FRONTAGE_DESIGN_IDS_V2[units],
    );
    assert.deepEqual(
      matched.map(({ trim, roof }) => ({ trim, roof })),
      FRONTAGE_SIGN_COLORS_V2[units],
    );
    matched.forEach((choice, index) =>
      assert.equal(
        Boolean(choice.billboard),
        variableDesignHasBillboard(units, index),
      ),
    );
  }
  for (const choice of choices) {
    for (const level of [1, 2, 3, 4] as BuildingLevel[]) {
      const layout = frontageMediaLayout(choice, level);
      assert.equal(
        layout.facade.width,
        choice.units * 85 - FACADE_SIDE_GAP * 2,
      );
      assert.equal(layout.facade.x, FACADE_SIDE_GAP);
      assert.equal(layout.facade.y, 190 - LEVEL_HEIGHTS[level] + 2);
      for (const media of [
        layout.sign,
        layout.logo,
        layout.name,
        layout.billboard,
      ]) {
        if (!media) continue;
        assert.ok(
          media.x >= layout.facade.x,
          `${choice.id} level ${level} left`,
        );
        assert.ok(
          media.x + media.width <= layout.facade.x + layout.facade.width,
          `${choice.id} level ${level} right`,
        );
        assert.ok(
          media.y >= layout.facade.y,
          `${choice.id} level ${level} top`,
        );
        assert.ok(
          media.y + media.height <= 190,
          `${choice.id} level ${level} bottom`,
        );
      }
      assert.equal(
        Boolean(layout.billboard),
        Boolean(choice.billboard && level >= 3),
      );
      if (layout.billboard) {
        assert.equal(
          overlaps(layout.billboard, layout.sign),
          false,
          `${choice.id} level ${level} ad over sign`,
        );
        assert.equal(
          overlaps(layout.billboard, layout.logo),
          false,
          `${choice.id} level ${level} ad over logo`,
        );
      }
    }
  }
});
