import assert from "node:assert/strict";
import test from "node:test";
import { planPlotAgentTurn } from "./plot-agent-policy.mjs";

const grantStatus = {
  grant: {
    owner: "owner.testnet",
    plot_ids: ["plot-main-n-2"],
    expires_at: 1_000,
  },
  actions_remaining_today: 2,
};
const frontages = [
  {
    plot: { plot: { id: "plot-main-n-1", ticket_cooldown_until: 0 } },
    slots: [{ id: 10, legal: false, driver: "other.testnet", expires_at: 900 }],
  },
  {
    plot: { plot: { id: "plot-main-n-2", ticket_cooldown_until: 100 } },
    slots: [
      { id: 11, legal: true, driver: "other.testnet", expires_at: 900 },
      { id: 12, legal: false, driver: "other.testnet", expires_at: 900 },
    ],
  },
];

test("plot agent tickets only a live illegal car on its granted plot", () => {
  assert.deepEqual(
    planPlotAgentTurn({ grantStatus, frontages, nowSeconds: 101 }),
    {
      kind: "call",
      method: "agent_ticket",
      args: { plot_id: "plot-main-n-2", slot: 1, expected_session_id: 12 },
      reason: "illegal parked car on an authorized plot",
    },
  );
  assert.equal(
    planPlotAgentTurn({ grantStatus, frontages, nowSeconds: 99 }).kind,
    "idle",
  );
  assert.equal(
    planPlotAgentTurn({ grantStatus, frontages, nowSeconds: 900 }).kind,
    "idle",
  );
});

test("plot agent does not act after expiry or budget exhaustion", () => {
  assert.equal(
    planPlotAgentTurn({ grantStatus, frontages, nowSeconds: 1_000 }).kind,
    "idle",
  );
  assert.equal(
    planPlotAgentTurn({
      grantStatus: { ...grantStatus, actions_remaining_today: 0 },
      frontages,
      nowSeconds: 101,
    }).kind,
    "idle",
  );
});
