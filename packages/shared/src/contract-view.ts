import { z } from "zod";
import { CoinString } from "./money.js";
import {
  BuildingType,
  CarBody,
  CarColor,
  ParkingRule,
  RoadId,
  Side,
} from "./world.js";

const ChainId = z.number().int().safe().nonnegative();
const ChainTime = z.number().int().safe().nonnegative();
const AccountId = z.string().min(2).max(64);
const ContentHash = z.string().regex(/^[0-9a-f]{64}$/);
const PlotId = z
  .string()
  .regex(/^plot-(main|market|river|central|harbor)-(n|s)-[0-7]$/);

export const ChainAppearanceReference = z.object({
  revision: ChainId,
  owner: AccountId,
  building_type: BuildingType,
  level: z.number().int().min(1).max(4),
  manifest_hash: ContentHash,
});
export type ChainAppearanceReference = z.infer<typeof ChainAppearanceReference>;

export const ChainAppearanceDecision = z.object({
  reference: ChainAppearanceReference,
  status: z.enum(["Approved", "Rejected", "Revoked"]),
  decided_at: ChainTime,
  reason: z.string().max(500).nullable(),
});
export type ChainAppearanceDecision = z.infer<typeof ChainAppearanceDecision>;

export const ChainMediaIdentity = z.object({
  asset_hash: ContentHash,
  link: z.string().url().nullable(),
});
export type ChainMediaIdentity = z.infer<typeof ChainMediaIdentity>;
export const ChainMediaProposal = z.object({
  revision: ChainId,
  owner: AccountId,
  building_type: BuildingType,
  level: z.number().int().min(1).max(4),
  layout_revision: ChainId,
  content: ChainMediaIdentity,
});
export type ChainMediaProposal = z.infer<typeof ChainMediaProposal>;
export const ChainMediaSlot = z.object({
  revision: ChainId,
  active: z
    .object({
      content: ChainMediaIdentity,
      approved_layout_revision: ChainId,
      approved_at: ChainTime,
    })
    .nullable(),
  pending: ChainMediaProposal.nullable(),
  last_decision: z
    .object({
      proposal: ChainMediaProposal,
      status: z.enum(["Approved", "Rejected", "Revoked"]),
      decided_at: ChainTime,
      reason: z.string().max(500).nullable(),
    })
    .nullable(),
  last_replacement_at: ChainTime.nullable(),
});
export type ChainMediaSlot = z.infer<typeof ChainMediaSlot>;

export const ChainAccount = z.object({
  balance: CoinString,
  car_ids: z.array(ChainId).max(3),
  starter_car_id: ChainId,
  active_session_id: ChainId.nullable(),
  last_emergency_repair_at: ChainTime.nullable(),
  burger_decal: z.boolean(),
  reserved_storage_bytes: z.number().int().nonnegative(),
  used_storage_bytes: z.number().int().nonnegative(),
});
export type ChainAccount = z.infer<typeof ChainAccount>;

export const ChainCar = z.object({
  id: ChainId,
  owner: AccountId,
  body: CarBody,
  color: CarColor,
  tier: z.number().int().min(1).max(3),
  durability: z.number().int().min(0).max(100),
  parked_session_id: ChainId.nullable(),
});
export type ChainCar = z.infer<typeof ChainCar>;

export const ChainParkedCarAppearance = ChainCar.pick({
  id: true,
  body: true,
  color: true,
});

export const ChainSession = z.object({
  id: ChainId,
  car_id: ChainId,
  driver: AccountId,
  location_id: z.string().min(1),
  slot: z.number().int().min(0).max(31),
  facility: z.enum(["Curb", "Tower"]),
  started_at: ChainTime,
  earn_until: ChainTime,
  expires_at: ChainTime,
  legal: z.boolean(),
  inspector_attempted: z.boolean(),
  terms: z.object({
    config_version: z.number().int().positive(),
    base_rate_per_hour: CoinString,
    tier_multiplier_bps: z.number().int().nonnegative(),
    legality_multiplier_bps: z.number().int().nonnegative(),
    facility_multiplier_bps: z.number().int().nonnegative(),
    meter_rate_per_hour: CoinString,
    earn_cap_seconds: z.number().int().positive(),
    ticket_recipient_bps: z.number().int().min(0).max(10_000),
    meter_recipient: AccountId.nullable(),
  }),
});
export type ChainSession = z.infer<typeof ChainSession>;

export const ChainPlot = z.object({
  plot: z.object({
    id: PlotId,
    road_id: RoadId,
    side: Side,
    index: z.number().int().min(0).max(7),
    corner: z.boolean(),
    owner: AccountId.nullable(),
    rule: ParkingRule,
    pending_rule: z
      .object({ rule: ParkingRule, effective_at: ChainTime })
      .nullable(),
    building: z.object({
      building_type: BuildingType,
      variant: z.number().int().min(1).max(2),
      level: z.number().int().min(1).max(4),
      primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
      name: z.string().max(24),
      approved_manifest_hash: ContentHash.nullable(),
      approved_at: ChainTime.nullable(),
      last_facade_approved_at: ChainTime.nullable(),
      pending_appearance: ChainAppearanceReference.nullable(),
      last_appearance_decision: ChainAppearanceDecision.nullable(),
      facade_exemption_level: z.number().int().min(1).max(4).nullable(),
      appearance_revision: ChainId,
      layout_revision: ChainId,
    }),
    logo: ChainMediaSlot,
    billboard: ChainMediaSlot,
    ticket_cooldown_until: ChainTime,
    reserved_storage_bytes: z.number().int().nonnegative(),
    used_storage_bytes: z.number().int().nonnegative(),
  }),
  effective_rule: ParkingRule,
  logo_eligible: z.boolean(),
  billboard_eligible: z.boolean(),
});
export type ChainPlot = z.infer<typeof ChainPlot>;

export const ChainStreetSide = z.object({
  road_id: RoadId,
  side: Side,
  plots: z
    .array(
      z.object({
        plot: ChainPlot,
        slots: z.tuple([ChainSession.nullable(), ChainSession.nullable()]),
        car_appearances: z
          .tuple([
            ChainParkedCarAppearance.nullable(),
            ChainParkedCarAppearance.nullable(),
          ])
          .optional(),
      }),
    )
    .max(8),
});
export type ChainStreetSide = z.infer<typeof ChainStreetSide>;

export const ChainPlayerSnapshot = z.object({
  account_id: AccountId,
  account: ChainAccount.nullable(),
  cars: z.array(ChainCar).max(3),
  active_session: ChainSession.nullable(),
});
export type ChainPlayerSnapshot = z.infer<typeof ChainPlayerSnapshot>;

export const YoctoNearString = CoinString;

export const ChainPlotPurchaseBreakdown = z.object({
  price_yocto: YoctoNearString,
  storage_reserve_yocto: YoctoNearString,
  total_yocto: YoctoNearString,
});
export type ChainPlotPurchaseBreakdown = z.infer<
  typeof ChainPlotPurchaseBreakdown
>;

export const ChainOwnerConfig = z.object({
  version: z.number().int().positive(),
  meter_rate_max_per_hour: CoinString,
  rule_delay_seconds: z.number().int().nonnegative(),
  change_building_type_cost: CoinString,
  building_upgrade_costs: z.tuple([CoinString, CoinString, CoinString]),
});
export type ChainOwnerConfig = z.infer<typeof ChainOwnerConfig>;

export const ChainStreetEconomyConfig = z.object({
  base_rate_per_hour: CoinString,
  tier_multiplier_bps: z.tuple([
    z.number().int().min(10_000).max(30_000),
    z.number().int().min(10_000).max(30_000),
    z.number().int().min(10_000).max(30_000),
  ]),
  illegal_multiplier_bps: z.number().int().min(10_000).max(20_000),
  tower_multiplier_bps: z.number().int().min(1_000).max(10_000),
  earn_cap_seconds: z.number().int().min(60).max(86_400),
});
export type ChainStreetEconomyConfig = z.infer<typeof ChainStreetEconomyConfig>;
