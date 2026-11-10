import { z } from "zod";

export const IMPRESSION_RULES = {
  visibleThresholdMs: 1_000,
  flushIntervalMs: 10_000,
  maxBatchEvents: 20,
  maxEventMs: 60_000,
  maxDwellPerPlotMinuteMs: 60_000,
  sessionTtlSeconds: 86_400,
  maxEventAgeMs: 300_000,
  maxFutureSkewMs: 30_000,
  maxEventsPerSessionMinute: 60,
  maxEventsPerSessionDay: 5_000,
} as const;

export const ImpressionEvent = z.object({
  eventId: z.uuid(),
  plotId: z.string().min(1).max(80),
  surface: z.enum(["Logo", "Billboard"]),
  observedAt: z.number().int().nonnegative(),
  msVisible: z.number().int().min(1).max(IMPRESSION_RULES.maxEventMs),
});
export type ImpressionEvent = z.infer<typeof ImpressionEvent>;

export const ImpressionBatch = z.object({
  events: z.array(ImpressionEvent).min(1).max(IMPRESSION_RULES.maxBatchEvents),
});
export type ImpressionBatch = z.infer<typeof ImpressionBatch>;
