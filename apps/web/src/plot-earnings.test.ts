import assert from "node:assert/strict";
import test from "node:test";
import type { ChainCar, ChainStreetEconomyConfig } from "@estate/shared";
import { plotEarningPreview, towerEarningPreview } from "./plot-earnings.js";

const config: ChainStreetEconomyConfig = {
  base_rate_per_hour: "60000000",
  tier_multiplier_bps: [10_000, 15_000, 22_000],
  illegal_multiplier_bps: 15_000,
  tower_multiplier_bps: 5_000,
  earn_cap_seconds: 1_800,
};
const car: ChainCar = {
  id: 1,
  owner: "driver.testnet",
  body: "Hatchback",
  color: "Red",
  tier: 1,
  durability: 100,
  parked_session_id: null,
};

test("plot preview distinguishes legal payout, meter cap, and ticket risk", () => {
  assert.equal(
    plotEarningPreview(config, { kind: "Free" }, car),
    "New park: 30 coins / 30m cap",
  );
  assert.equal(
    plotEarningPreview(config, { kind: "Meter", ratePerHour: "90000000" }, car),
    "New park: 15 coins / 30m cap · after meter",
  );
  assert.equal(
    plotEarningPreview(config, { kind: "NoParking" }, car),
    "New park: 45 coins / 30m cap · ticket risk",
  );
  assert.equal(
    plotEarningPreview(config, { kind: "ColorOnly", color: "Blue" }, car),
    "New park: 45 coins / 30m cap · ticket risk",
  );
  assert.equal(
    plotEarningPreview(config, { kind: "ColorOnly", color: "Red" }, car),
    "New park: 30 coins / 30m cap",
  );
  assert.equal(
    plotEarningPreview(config, { kind: "Free" }, { ...car, tier: 3 }),
    "New park: 66 coins / 30m cap",
  );
  assert.equal(
    towerEarningPreview(config, { ...car, tier: 2 }),
    "New park: 22.5 coins / 30m cap",
  );
});

test("plot preview makes missing car or current settings explicit", () => {
  assert.equal(
    plotEarningPreview(config, { kind: "Free" }, null),
    "Select a car to preview earnings",
  );
  assert.equal(
    plotEarningPreview(null, { kind: "Free" }, car),
    "Loading current earnings…",
  );
});
