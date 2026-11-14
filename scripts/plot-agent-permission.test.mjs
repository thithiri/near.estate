import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPlotAgentPermission,
  PLOT_AGENT_MAX_ALLOWANCE,
  PLOT_AGENT_METHODS,
} from "./plot-agent-permission.mjs";

const key = () => ({
  permission: {
    FunctionCall: {
      receiver_id: "estate.testnet",
      method_names: [...PLOT_AGENT_METHODS],
      allowance: PLOT_AGENT_MAX_ALLOWANCE.toString(),
    },
  },
});

test("plot agent needs the exact contract, methods and finite allowance", () => {
  assert.doesNotThrow(() =>
    assertPlotAgentPermission(key(), "estate.testnet", "agent_ticket"),
  );
  assert.throws(() =>
    assertPlotAgentPermission(key(), "other.testnet", "agent_ticket"),
  );
  assert.throws(() =>
    assertPlotAgentPermission(key(), "estate.testnet", "set_rule"),
  );
  const broad = key();
  broad.permission.FunctionCall.method_names.push("set_rule");
  assert.throws(() =>
    assertPlotAgentPermission(broad, "estate.testnet", "agent_ticket"),
  );
  const unlimited = key();
  unlimited.permission.FunctionCall.allowance = null;
  assert.throws(() =>
    assertPlotAgentPermission(unlimited, "estate.testnet", "agent_ticket"),
  );
  const excessive = key();
  excessive.permission.FunctionCall.allowance = (
    PLOT_AGENT_MAX_ALLOWANCE + 1n
  ).toString();
  assert.throws(() =>
    assertPlotAgentPermission(excessive, "estate.testnet", "agent_ticket"),
  );
});
