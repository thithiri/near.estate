export function planPlotAgentTurn({ grantStatus, frontages, nowSeconds }) {
  if (!grantStatus?.grant)
    return { kind: "idle", reason: "plot-agent grant missing" };
  const { grant, actions_remaining_today: remaining } = grantStatus;
  if (nowSeconds >= grant.expires_at)
    return { kind: "idle", reason: "plot-agent grant expired" };
  if (remaining <= 0)
    return { kind: "idle", reason: "daily action limit reached" };
  for (const plotId of grant.plot_ids) {
    const frontage = frontages.find((entry) => entry.plot?.plot?.id === plotId);
    if (!frontage) continue;
    if (nowSeconds < frontage.plot.plot.ticket_cooldown_until) continue;
    for (let slot = 0; slot < frontage.slots.length; slot++) {
      const session = frontage.slots[slot];
      if (
        session &&
        !session.legal &&
        session.driver !== grant.owner &&
        nowSeconds < session.expires_at
      )
        return {
          kind: "call",
          method: "agent_ticket",
          args: { plot_id: plotId, slot, expected_session_id: session.id },
          reason: "illegal parked car on an authorized plot",
        };
    }
  }
  return { kind: "idle", reason: "no ticketable car on authorized plots" };
}
