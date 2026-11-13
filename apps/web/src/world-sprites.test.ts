import assert from "node:assert/strict";
import test from "node:test";
import { CarBody, CarColor, ServiceRole } from "@estate/shared";
import rawCatalog from "./world-sprites.json";
import { carSpriteFile, siteSpriteFile } from "./world-sprites.js";

test("all body, colour and civic destination combinations are available", () => {
  assert.equal(rawCatalog.cars.length, 24);
  assert.equal(rawCatalog.sites.length, 6);
  for (const body of CarBody.options) {
    for (const color of CarColor.options)
      assert.match(carSpriteFile(body, color), /\.png$/);
  }
  for (const role of ServiceRole.options)
    assert.match(siteSpriteFile(role), /\.png$/);
});
