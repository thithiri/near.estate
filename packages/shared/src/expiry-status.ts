import { z } from "zod";

export const ExpiryStatus = z.object({
  contractId: z.string().regex(/^[a-z0-9._-]+\.testnet$/),
  completedAt: z.number().int().nonnegative(),
  outcome: z.enum(["ok", "error"]),
  consecutiveFailures: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  attempted: z.number().int().nonnegative(),
  settled: z.number().int().nonnegative(),
  raced: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export type ExpiryStatus = z.infer<typeof ExpiryStatus>;
