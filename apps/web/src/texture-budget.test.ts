import assert from "node:assert/strict";
import test from "node:test";
import { selectNearTextureViews } from "./texture-budget.js";

test("the street texture selection stays within its unique image budget", () => {
  const views = Array.from({ length: 9 }, (_, index) => ({
    x: index * 170,
    urls: Array.from({ length: 4 }, (_, asset) => `${index}-${asset}`),
  }));
  const selected = selectNearTextureViews(views, 600, 700, 32);
  assert.equal(selected.size, 8);
  assert.equal(selected.has(5), true);
  const urls = new Set([...selected].flatMap((index) => views[index]!.urls));
  assert.equal(urls.size, 32);
});

test("visible facades take priority over nearby preloads", () => {
  const selected = selectNearTextureViews(
    [
      { x: 0, urls: ["left"] },
      { x: 170, urls: ["visible"] },
      { x: 340, urls: ["right"] },
      { x: 1000, urls: ["far"] },
    ],
    170,
    170,
    2,
  );
  assert.deepEqual([...selected].sort(), [0, 1]);
});

test("shared and repeated URLs count once", () => {
  const selected = selectNearTextureViews(
    [
      { x: 0, urls: ["shared", "shared"] },
      { x: 170, urls: ["shared", "second"] },
    ],
    0,
    340,
    2,
  );
  assert.deepEqual([...selected].sort(), [0, 1]);
});
