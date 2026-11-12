import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateCitySeed } from "@estate/shared";
import { choices } from "./frontage-art.js";
import guestIllustrations from "./guest-illustrations.json";
import { frontageMediaLayout, LEVEL_HEIGHTS } from "./frontage-layout.js";
import { createGuestCity } from "./guest-city.js";
import { choiceForGuestPlot } from "./guest-frontage.js";
import { MockGame } from "./mock-game.js";
import {
  frontageAtX,
  frontageWidth,
  frontageX,
  intersectionX,
  roadWidth,
} from "./city-navigation.js";

const path = fileURLToPath(
  new URL("../../../contracts/estate/seed.json", import.meta.url),
);
const live = validateCitySeed(JSON.parse(readFileSync(path, "utf8")));
const guest = validateCitySeed(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../contracts/estate/seed-v2.json", import.meta.url),
      ),
      "utf8",
    ),
  ),
);

test("version-2 seed matches the draft city generator", () => {
  assert.deepEqual(guest, createGuestCity(live));
});

test("playable guest city has five suitable building choices and exact curb capacity", () => {
  assert.equal(live.version, 1);
  assert.equal(guest.version, 2);
  assert.equal(guest.plots.length, 100);
  assert.deepEqual(
    [1, 2, 3].map(
      (units) => choices.filter((choice) => choice.units === units).length,
    ),
    [5, 5, 5],
  );
  for (const plot of guest.plots)
    assert.equal(choiceForGuestPlot(plot).units, plot.frontageUnits);
  const game = new MockGame(guest, () => 10_000);
  const one = guest.plots.find(
    (plot) => plot.frontageUnits === 1 && plot.id !== game.ownedPlotId,
  )!;
  const three = guest.plots.find((plot) => plot.frontageUnits === 3)!;
  assert.equal(game.curbAvailability(one.id), 1);
  assert.equal(game.curbAvailability(three.id), 3);
  const visitor = game.sessions.get(`c:${game.ownedPlotId}:0`)!;
  game.sessions.set(`c:${one.id}:0`, {
    ...visitor,
    locationId: one.id,
    space: 0,
  });
  assert.equal(game.openSlot(one.id), undefined);
  for (const space of [0, 1])
    game.sessions.set(`c:${three.id}:${space}`, {
      ...visitor,
      locationId: three.id,
      space,
    });
  assert.equal(game.openSlot(three.id), 2);
  const parked = game.park(three.id);
  assert.equal(parked.space, 2);
  assert.equal(game.curbAvailability(three.id), 0);
});

test("every illustrated building stays on its matching one, two, or three-unit plot", () => {
  for (const choice of choices) {
    const plotWidth = choice.units * 85;
    for (const level of [1, 2, 3, 4] as const) {
      const art = guestIllustrations.buildings.find(
        (entry) => entry.id === choice.id && entry.level === level,
      );
      assert.ok(art, `${choice.id} level ${level} has an illustration`);
      assert.equal(art.units, choice.units);
      assert.ok(art.alphaBounds.x >= 0);
      assert.ok(art.alphaBounds.x + art.alphaBounds.width <= plotWidth);
      assert.ok(art.alphaBounds.y >= 190 - LEVEL_HEIGHTS[level]);
      assert.ok(art.alphaBounds.y + art.alphaBounds.height <= 190);
      const { sign } = frontageMediaLayout(choice, level);
      assert.ok(sign.x >= art.alphaBounds.x);
      assert.ok(
        sign.x + sign.width <= art.alphaBounds.x + art.alphaBounds.width,
      );
      assert.ok(sign.y >= art.alphaBounds.y);
      assert.ok(sign.y + sign.height <= 190);
    }
  }
});

test("guest intersections align between sides and remain reachable", () => {
  for (const road of guest.streets) {
    assert.equal(road.length, 14);
    assert.equal(
      roadWidth(road),
      18 * 85 +
        4 * 170 +
        road.connections.filter((entry) => entry.kind === "Intersection")
          .length *
          76,
    );
    for (const connection of road.connections.filter(
      (entry) => entry.kind === "Intersection",
    )) {
      const north = intersectionX(road, connection);
      const south =
        frontageX(road, connection.at, "South") +
        frontageWidth(road, connection.at, "South");
      assert.equal(north, south);
      assert.equal(frontageAtX(road, north - 1, "North"), connection.at);
      assert.equal(frontageAtX(road, north + 76, "South"), connection.at + 1);
    }
  }
});
