import assert from "node:assert/strict";
import test from "node:test";
import { planAgentTurn } from "./agent-policy.mjs";

const player = {
  account: { active_session_id: null },
  active_session: null,
  cars: [{ id: 4, durability: 100, parked_session_id: null }],
};
const plots = [
  {
    plot: {
      plot: { id: "plot-main-n-0" },
      effective_rule: { kind: "NoParking" },
    },
    slots: [null],
  },
  {
    plot: { plot: { id: "plot-main-n-1" }, effective_rule: { kind: "Free" } },
    slots: [{ id: 1 }, null],
  },
];

test("agent chooses a legal unoccupied curb", () => {
  assert.deepEqual(planAgentTurn({ player, plots, nowSeconds: 100 }), {
    kind: "call",
    method: "park",
    args: { car_id: 4, plot_id: "plot-main-n-1", slot: 1 },
    reason: "free curb available",
  });
});

test("agent waits for earning cap then collects the same session", () => {
  const parked = {
    ...player,
    active_session: { id: 9, earn_until: 200, expires_at: 320 },
  };
  assert.equal(
    planAgentTurn({ player: parked, plots, nowSeconds: 199 }).kind,
    "idle",
  );
  assert.deepEqual(planAgentTurn({ player: parked, plots, nowSeconds: 200 }), {
    kind: "call",
    method: "collect",
    args: { expected_session_id: 9 },
    reason: "earnings cap reached",
  });
  assert.deepEqual(planAgentTurn({ player: parked, plots, nowSeconds: 320 }), {
    kind: "call",
    method: "settle_expired",
    args: { expected_session_id: 9 },
    reason: "session expired",
  });
});

test("agent will not invent a profitable move without a parkable car or legal space", () => {
  assert.equal(
    planAgentTurn({
      player: { ...player, cars: [{ ...player.cars[0], durability: 1 }] },
      plots,
      nowSeconds: 0,
    }).kind,
    "idle",
  );
  assert.equal(
    planAgentTurn({ player, plots: plots.slice(0, 1), nowSeconds: 0 }).kind,
    "idle",
  );
});
