// A conservative, deterministic player policy. It only uses public chain state.
export function planAgentTurn({
  player,
  plots,
  nowSeconds,
  accountId = "",
  carId = null,
}) {
  if (!player?.account)
    return { kind: "idle", reason: "register_player first" };
  const session = player.active_session;
  if (session) {
    if (carId !== null && session.car_id !== carId)
      return { kind: "idle", reason: "another car has the active session" };
    if (nowSeconds >= session.expires_at) {
      return {
        kind: "call",
        method: "settle_expired",
        args: { expected_session_id: session.id },
        reason: "session expired",
      };
    }
    if (nowSeconds >= session.earn_until) {
      return {
        kind: "call",
        method: "collect",
        args: { expected_session_id: session.id },
        reason: "earnings cap reached",
      };
    }
    return {
      kind: "idle",
      reason: "earning session active",
      nextAt: session.earn_until,
    };
  }
  const car = player.cars.find(
    (candidate) =>
      (carId === null || candidate.id === carId) &&
      candidate.parked_session_id === null &&
      candidate.durability >= 2,
  );
  if (!car) return { kind: "idle", reason: "no parkable car" };
  const offset =
    [...accountId].reduce((sum, char) => sum + char.charCodeAt(0), 0) %
    (plots.length || 1);
  for (let index = 0; index < plots.length; index += 1) {
    const frontage = plots[(index + offset) % plots.length];
    if (frontage.plot?.effective_rule?.kind !== "Free") continue;
    const plot = frontage.plot.plot;
    if (!plot || !Array.isArray(frontage.slots)) continue;
    const slot = frontage.slots.findIndex((item) => item === null);
    if (slot >= 0) {
      return {
        kind: "call",
        method: "park",
        args: { car_id: car.id, plot_id: plot.id, slot },
        reason: "free curb available",
      };
    }
  }
  return { kind: "idle", reason: "no free curb available" };
}
