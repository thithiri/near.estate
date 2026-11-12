import { z } from "zod";

const count = z.number().int().nonnegative();
const timestamp = z.number().int().nonnegative().nullable();
export const PlotDayStats = z.object({
  day: z.iso.date(),
  impressions: count,
  dwellMs: count,
  averageVisibleMs: count,
  parks: count,
  tickets: count,
});
const PlotTotals = PlotDayStats.omit({ day: true });
export const PlotStats = z.object({
  plotId: z.string().min(1),
  days: z.array(PlotDayStats).length(7),
  totals: PlotTotals,
  linkedHistory: z
    .object({
      sourcePlotId: z.string().min(1),
      cutoverHeight: count,
      cutoverAtMs: count,
      days: z.array(PlotDayStats).length(7),
      totals: PlotTotals,
    })
    .optional(),
  freshness: z.object({
    impressionReceivedAt: timestamp,
    indexedThroughHeight: count.nullable(),
    indexedThroughAt: timestamp,
    indexerCheckedAt: timestamp,
  }),
});
export type PlotStats = z.infer<typeof PlotStats>;
