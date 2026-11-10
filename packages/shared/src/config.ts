import { z } from "zod";
import { COIN_SCALE, CoinString, coins } from "./money.js";

const bounded = (min: number, max: number) =>
  z.number().int().min(min).max(max);
const coinAtMost = (wholeCoins: number) =>
  CoinString.refine(
    (value) => BigInt(value) <= BigInt(wholeCoins) * COIN_SCALE,
    {
      message: `coin amount exceeds ${wholeCoins} coins`,
    },
  );

export const GameConfig = z
  .object({
    version: bounded(1, 1_000_000),
    coinScale: z.literal(1_000_000),
    starterCoins: coinAtMost(10_000),
    baseRatePerHour: coinAtMost(1_000_000),
    tierMultiplierBps: z.tuple([
      bounded(10_000, 30_000),
      bounded(10_000, 30_000),
      bounded(10_000, 30_000),
    ]),
    illegalMultiplierBps: bounded(10_000, 20_000),
    towerMultiplierBps: bounded(1_000, 10_000),
    earnCapSeconds: bounded(60, 86_400),
    expiryGraceSeconds: bounded(0, 3_600),
    parkDurabilityCost: bounded(1, 100),
    maxDurability: bounded(2, 100),
    maxCars: bounded(1, 3),
    maxEarningCars: z.literal(1),
    accountStorageBytes: bounded(1_024, 16_384),
    plotStorageBytes: bounded(512, 8_192),
    repairCostPerPoint: coinAtMost(10_000),
    buyCarCost: coinAtMost(1_000_000),
    tierUpgradeCosts: z.tuple([coinAtMost(1_000_000), coinAtMost(1_000_000)]),
    buildingUpgradeCosts: z.tuple([
      coinAtMost(10_000_000),
      coinAtMost(10_000_000),
      coinAtMost(10_000_000),
    ]),
    changeBuildingTypeCost: coinAtMost(1_000_000),
    meterRateMaxPerHour: coinAtMost(30),
    ruleDelaySeconds: bounded(0, 86_400),
    ticketCooldownSeconds: bounded(0, 86_400),
    ticketRecipientBps: bounded(0, 10_000),
    inspectorChanceBps: bounded(0, 10_000),
    inspectorMinAgeSeconds: bounded(0, 86_400),
    inspectorWindowSeconds: bounded(60, 86_400),
    inspectorMaxAttemptsPerWindow: bounded(1, 100),
    plotBasePriceYocto: CoinString.refine(
      (value) => BigInt(value) > 0n && BigInt(value) <= 10n ** 26n,
      "plot base price must be between 1 yoctoNEAR and 100 NEAR",
    ),
    cornerPriceBps: bounded(10_000, 50_000),
    towerCapacity: z.literal(32),
    burgerDecalCost: coinAtMost(1_000_000),
    logoCooldownSeconds: bounded(0, 604_800),
    facadeCooldownSeconds: bounded(0, 604_800),
    emergencyRepairCooldownSeconds: bounded(0, 604_800),
  })
  .refine((config) => config.parkDurabilityCost <= config.maxDurability, {
    path: ["parkDurabilityCost"],
    message: "parking cost exceeds max durability",
  });
export type GameConfig = z.infer<typeof GameConfig>;

export const DEFAULT_CONFIG: GameConfig = GameConfig.parse({
  version: 1,
  coinScale: 1_000_000,
  starterCoins: coins(100),
  baseRatePerHour: coins(60),
  tierMultiplierBps: [10_000, 15_000, 22_000],
  illegalMultiplierBps: 15_000,
  towerMultiplierBps: 5_000,
  earnCapSeconds: 1_800,
  expiryGraceSeconds: 120,
  parkDurabilityCost: 2,
  maxDurability: 100,
  maxCars: 3,
  maxEarningCars: 1,
  accountStorageBytes: 4_096,
  plotStorageBytes: 4_096,
  repairCostPerPoint: coins(1),
  buyCarCost: coins(150),
  tierUpgradeCosts: [coins(200), coins(500)],
  buildingUpgradeCosts: [coins(200), coins(600), coins(1_500)],
  changeBuildingTypeCost: coins(100),
  meterRateMaxPerHour: coins(30),
  ruleDelaySeconds: 300,
  ticketCooldownSeconds: 300,
  ticketRecipientBps: 7_000,
  inspectorChanceBps: 2_500,
  inspectorMinAgeSeconds: 300,
  inspectorWindowSeconds: 300,
  inspectorMaxAttemptsPerWindow: 8,
  plotBasePriceYocto: "1000000000000000000000000",
  cornerPriceBps: 20_000,
  towerCapacity: 32,
  burgerDecalCost: coins(30),
  logoCooldownSeconds: 259_200,
  facadeCooldownSeconds: 86_400,
  emergencyRepairCooldownSeconds: 86_400,
});

export const TOWER_SPACES_PER_FLOOR = 8;
export const TOWER_FLOORS =
  DEFAULT_CONFIG.towerCapacity / TOWER_SPACES_PER_FLOOR;

export interface Clock {
  nowSeconds(): number;
}
export class MockClock implements Clock {
  constructor(private time: number = 0) {}
  nowSeconds(): number {
    return this.time;
  }
  advance(seconds: number): void {
    if (!Number.isSafeInteger(seconds) || seconds < 0)
      throw new Error("advance requires nonnegative whole seconds");
    this.time += seconds;
  }
}

export function grossEarnings(
  config: GameConfig,
  tier: 1 | 2 | 3,
  legal: boolean,
  tower: boolean,
  elapsedSeconds: number,
): bigint {
  const seconds = BigInt(
    Math.min(Math.max(0, Math.floor(elapsedSeconds)), config.earnCapSeconds),
  );
  const multiplier = config.tierMultiplierBps[tier - 1];
  if (multiplier === undefined) throw new Error("invalid car tier");
  const tierBps = BigInt(multiplier);
  const legalityBps = BigInt(legal ? 10_000 : config.illegalMultiplierBps);
  const facilityBps = BigInt(tower ? config.towerMultiplierBps : 10_000);
  return (
    (BigInt(config.baseRatePerHour) *
      tierBps *
      legalityBps *
      facilityBps *
      seconds) /
    (3_600n * 10_000n ** 3n)
  );
}
