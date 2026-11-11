import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChainCar,
  ChainSession,
  ChainStreetEconomyConfig,
} from "@estate/shared";
import {
  plotEarningPreview,
  sessionFullPayout,
  towerEarningPreview,
} from "./plot-earnings.js";

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

test("parked payout uses frozen session terms, including meter and tower rates", () => {
  const session: ChainSession = {
    id: 6,
    car_id: 3,
    driver: "driver.testnet",
    location_id: "plot-river-s-0",
    slot: 0,
    facility: "Curb",
    started_at: 1_000,
    earn_until: 2_800,
    expires_at: 2_920,
    legal: true,
    inspector_attempted: false,
    terms: {
      config_version: 1,
      base_rate_per_hour: "60000000",
      tier_multiplier_bps: 10_000,
      legality_multiplier_bps: 10_000,
      facility_multiplier_bps: 10_000,
      meter_rate_per_hour: "0",
      earn_cap_seconds: 1_800,
      ticket_recipient_bps: 7_000,
      meter_recipient: null,
    },
  };
  assert.equal(sessionFullPayout(session), "30");
  assert.equal(
    sessionFullPayout({
      ...session,
      terms: {
        ...session.terms,
        meter_rate_per_hour: "10000000",
        meter_recipient: "owner.testnet",
      },
    }),
    "25",
  );
  assert.equal(
    sessionFullPayout({
      ...session,
      facility: "Tower",
      terms: { ...session.terms, facility_multiplier_bps: 5_000 },
    }),
    "15",
  );
});
