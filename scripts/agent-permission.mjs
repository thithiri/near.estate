export const PARKING_AGENT_METHODS = ["park", "collect", "settle_expired"];
export const MAX_AGENT_ALLOWANCE = 50n * 10n ** 21n;

export function assertParkingAgentPermission(key, contractId, method) {
  const call = key?.permission?.FunctionCall;
  if (
    !call ||
    call.receiver_id !== contractId ||
    !Array.isArray(call.method_names) ||
    !call.method_names.includes(method) ||
    call.method_names.length !== PARKING_AGENT_METHODS.length ||
    !PARKING_AGENT_METHODS.every((allowed) =>
      call.method_names.includes(allowed),
    ) ||
    typeof call.allowance !== "string" ||
    !/^\d+$/.test(call.allowance) ||
    BigInt(call.allowance) <= 0n ||
    BigInt(call.allowance) > MAX_AGENT_ALLOWANCE
  )
    throw new Error(
      "Agent key must allow only park, collect, settle_expired on this contract with at most 0.05 NEAR gas allowance",
    );
}
