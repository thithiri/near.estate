import type { ChainAccount, ChainCar, ChainOwnerConfig } from "@estate/shared";

export function garageRecovery(
  account: Pick<
    ChainAccount,
    "active_session_id" | "balance" | "last_emergency_repair_at"
  >,
  cars: Pick<ChainCar, "durability">[],
  config: Pick<
    ChainOwnerConfig,
    | "park_durability_cost"
    | "repair_cost_per_point"
    | "emergency_repair_cooldown_seconds"
  >,
  nowSeconds: number,
): { stranded: boolean; eligible: boolean; availableAt: number | null } {
  if (account.active_session_id !== null || cars.length === 0)
    return { stranded: false, eligible: false, availableAt: null };
  const missing = cars.map(
    (car) => config.park_durability_cost - car.durability,
  );
  if (missing.some((points) => points <= 0))
    return { stranded: false, eligible: false, availableAt: null };
  const cheapestRepair =
    BigInt(Math.min(...missing)) * BigInt(config.repair_cost_per_point);
  if (BigInt(account.balance) >= cheapestRepair)
    return { stranded: false, eligible: false, availableAt: null };
  const availableAt =
    account.last_emergency_repair_at === null
      ? null
      : account.last_emergency_repair_at +
        config.emergency_repair_cooldown_seconds;
  return {
    stranded: true,
    eligible: availableAt === null || nowSeconds >= availableAt,
    availableAt,
  };
}
