import { z } from "zod";
import { GameConfig } from "./config.js";
import { CoinString } from "./money.js";

const basisPoints = z.number().int().min(0).max(30_000);
export const ParkingTerms = z.object({
  configVersion: z.number().int().positive(),
  baseRatePerHour: CoinString,
  tierMultiplierBps: basisPoints,
  legalityMultiplierBps: basisPoints,
  facilityMultiplierBps: basisPoints,
  meterRatePerHour: CoinString,
  earnCapSeconds: z.number().int().positive(),
  ticketRecipientBps: z.number().int().min(0).max(10_000),
  recipient: z.string().nullable(),
  legal: z.boolean(),
  tower: z.boolean(),
});
export type ParkingTerms = z.infer<typeof ParkingTerms>;

export function snapshotParkingTerms(
  config: GameConfig,
  tier: 1 | 2 | 3,
  legal: boolean,
  tower: boolean,
  meterRatePerHour: string,
  recipient: string | null,
): ParkingTerms {
  const multiplier = config.tierMultiplierBps[tier - 1];
  if (multiplier === undefined) throw new Error("invalid tier");
  const meter = BigInt(CoinString.parse(meterRatePerHour));
  if (meter > BigInt(config.meterRateMaxPerHour))
    throw new Error("meter rate exceeds config maximum");
  if ((!legal || tower) && meter !== 0n)
    throw new Error("meter is only valid on a legal curb session");
  return ParkingTerms.parse({
    configVersion: config.version,
    baseRatePerHour: config.baseRatePerHour,
    tierMultiplierBps: multiplier,
    legalityMultiplierBps: legal ? 10_000 : config.illegalMultiplierBps,
    facilityMultiplierBps: tower ? config.towerMultiplierBps : 10_000,
    meterRatePerHour,
    earnCapSeconds: config.earnCapSeconds,
    ticketRecipientBps: config.ticketRecipientBps,
    recipient,
    legal,
    tower,
  });
}

export interface Settlement {
  gross: bigint;
  driverPayout: bigint;
  recipientPayout: bigint;
  forfeited: bigint;
}

export function settleParking(
  terms: ParkingTerms,
  elapsedSeconds: number,
  reason: "Collect" | "Expire" | "Ticket",
): Settlement {
  if (!Number.isFinite(elapsedSeconds)) throw new Error("invalid elapsed time");
  const seconds = BigInt(
    Math.min(Math.max(0, Math.floor(elapsedSeconds)), terms.earnCapSeconds),
  );
  const gross =
    (BigInt(terms.baseRatePerHour) *
      BigInt(terms.tierMultiplierBps) *
      BigInt(terms.legalityMultiplierBps) *
      BigInt(terms.facilityMultiplierBps) *
      seconds) /
    (3_600n * 10_000n ** 3n);
  if (reason === "Ticket") {
    if (terms.legal || terms.tower)
      throw new Error("only illegal curb sessions can be ticketed");
    const recipientPayout =
      (gross * BigInt(terms.ticketRecipientBps)) / 10_000n;
    return {
      gross,
      driverPayout: 0n,
      recipientPayout,
      forfeited: gross - recipientPayout,
    };
  }
  const meter = terms.legal
    ? (BigInt(terms.meterRatePerHour) * seconds) / 3_600n
    : 0n;
  const recipientPayout = meter < gross / 2n ? meter : gross / 2n;
  return {
    gross,
    driverPayout: gross - recipientPayout,
    recipientPayout,
    forfeited: 0n,
  };
}
