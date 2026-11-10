import {
  formatCoins,
  type ChainCar,
  type ChainStreetEconomyConfig,
  type ParkingRule,
} from "@estate/shared";

function capDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return [
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    rest ? `${rest}s` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function earningPreview(
  config: ChainStreetEconomyConfig | null,
  rule: ParkingRule,
  car: ChainCar | null | undefined,
  tower: boolean,
): string {
  if (!car) return "Select a car to preview earnings";
  if (!config) return "Loading current earnings…";
  const legal =
    rule.kind === "Free" ||
    rule.kind === "Meter" ||
    (rule.kind === "ColorOnly" && rule.color === car.color);
  const tierBps = config.tier_multiplier_bps[car.tier - 1];
  if (tierBps === undefined) return "Earnings unavailable";
  const seconds = BigInt(config.earn_cap_seconds);
  const gross =
    (BigInt(config.base_rate_per_hour) *
      BigInt(tierBps) *
      BigInt(legal ? 10_000 : config.illegal_multiplier_bps) *
      BigInt(tower ? config.tower_multiplier_bps : 10_000) *
      seconds) /
    (3_600n * 10_000n ** 3n);
  let meterFee = 0n;
  if (legal && rule.kind === "Meter") {
    const uncapped = (BigInt(rule.ratePerHour) * seconds) / 3_600n;
    meterFee = uncapped < gross / 2n ? uncapped : gross / 2n;
  }
  const payout = gross - meterFee;
  const note = !legal
    ? " · ticket risk"
    : rule.kind === "Meter"
      ? " · after meter"
      : "";
  return `New park: ${formatCoins(payout.toString())} coins / ${capDuration(config.earn_cap_seconds)} cap${note}`;
}

export function plotEarningPreview(
  config: ChainStreetEconomyConfig | null,
  rule: ParkingRule,
  car: ChainCar | null | undefined,
): string {
  return earningPreview(config, rule, car, false);
}

export function towerEarningPreview(
  config: ChainStreetEconomyConfig | null,
  car: ChainCar | null | undefined,
): string {
  return earningPreview(config, { kind: "Free" }, car, true);
}
