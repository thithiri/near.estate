export const PLOT_AGENT_METHODS = [
  "agent_set_rule",
  "agent_ticket",
  "agent_choose_design",
  "agent_upgrade_building",
];
export const PLOT_AGENT_MAX_ALLOWANCE = 50n * 10n ** 21n;

export function assertPlotAgentPermission(key, contractId, method) {
  const call = key?.permission?.FunctionCall;
  if (
    !call ||
    call.receiver_id !== contractId ||
    !Array.isArray(call.method_names) ||
    !PLOT_AGENT_METHODS.includes(method) ||
    call.method_names.length !== PLOT_AGENT_METHODS.length ||
    !PLOT_AGENT_METHODS.every((allowed) =>
      call.method_names.includes(allowed),
    ) ||
    typeof call.allowance !== "string" ||
    !/^\d+$/.test(call.allowance) ||
    BigInt(call.allowance) <= 0n ||
    BigInt(call.allowance) > PLOT_AGENT_MAX_ALLOWANCE
  )
    throw new Error(
      "Plot-agent key has wrong methods, receiver or gas allowance",
    );
}
