import { z } from "zod";

export const COIN_SCALE = 1_000_000n;
export const CoinString = z
  .string()
  .max(39)
  .regex(/^(0|[1-9][0-9]*)$/, "coin amount must be an unsigned decimal string")
  .refine(
    (value) => /^[0-9]+$/.test(value) && BigInt(value) <= (1n << 128n) - 1n,
    "coin amount exceeds u128",
  );
export type CoinString = z.infer<typeof CoinString>;

export function coins(value: number): CoinString {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("whole coin amount must be a nonnegative safe integer");
  return (BigInt(value) * COIN_SCALE).toString();
}

export function parseCoin(value: string): bigint {
  return BigInt(CoinString.parse(value));
}

export function formatCoins(value: string): string {
  const amount = parseCoin(value);
  const whole = amount / COIN_SCALE;
  const fraction = (amount % COIN_SCALE)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
