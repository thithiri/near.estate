import { z } from "zod";

export const InspectorStatus = z.object({
  contractId: z.string().regex(/^[a-z0-9._-]+\.testnet$/),
  completedAt: z.number().int().nonnegative(),
  outcome: z.enum(["ok", "error"]),
  consecutiveFailures: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  attempted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export type InspectorStatus = z.infer<typeof InspectorStatus>;
