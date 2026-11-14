import assert from "node:assert/strict";
import test from "node:test";
import {
  assertParkingAgentPermission,
  MAX_AGENT_ALLOWANCE,
  PARKING_AGENT_METHODS,
} from "./agent-permission.mjs";

const key = () => ({
  permission: {
    FunctionCall: {
      receiver_id: "estate.testnet",
      method_names: [...PARKING_AGENT_METHODS],
      allowance: MAX_AGENT_ALLOWANCE.toString(),
    },
  },
});

test("parking agent accepts only the exact bounded key", () => {
  assert.doesNotThrow(() =>
    assertParkingAgentPermission(key(), "estate.testnet", "park"),
  );
  const broad = key();
  broad.permission.FunctionCall.method_names.push("repair");
  assert.throws(() =>
    assertParkingAgentPermission(broad, "estate.testnet", "park"),
  );
  const wrongContract = key();
  wrongContract.permission.FunctionCall.receiver_id = "other.testnet";
  assert.throws(() =>
    assertParkingAgentPermission(wrongContract, "estate.testnet", "park"),
  );
  for (const allowance of [null, "0", (MAX_AGENT_ALLOWANCE + 1n).toString()]) {
    const altered = key();
    altered.permission.FunctionCall.allowance = allowance;
    assert.throws(() =>
      assertParkingAgentPermission(altered, "estate.testnet", "park"),
    );
  }
});
