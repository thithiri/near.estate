import { z } from "zod";
import { CoinString } from "./money.js";
import { ParkingSpaceId } from "./world.js";

export const GameEventName = z.enum([
  "player_registered",
  "car_minted",
  "car_repaired",
  "car_upgraded",
  "cosmetic_bought",
  "plot_seeded",
  "npc_site_seeded",
  "plot_bought",
  "parked",
  "collected",
  "expired",
  "ticketed",
  "inspection_attempted",
  "rule_scheduled",
  "building_updated",
  "appearance_proposed",
  "appearance_approved",
  "appearance_rejected",
  "appearance_revoked",
  "media_proposed",
  "media_approved",
  "media_rejected",
  "media_removed",
  "media_revoked",
  "config_updated",
]);

const eventId = z.number().int().positive().max(9_000_000_000_000_000);
const revision = z.number().int().nonnegative();
const timestamp = z.number().int().nonnegative();
const accountId = z.string().min(2);
const locationId = z.string().min(1);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const mediaKind = z.enum(["Logo", "Billboard"]);
const facility = z.enum(["Curb", "Tower"]);

const appearance = z
  .object({ plot_id: locationId, revision, manifest_hash: hash })
  .strict();
const media = z
  .object({ plot_id: locationId, kind: mediaKind, revision, asset_hash: hash })
  .strict();
const settlement = z
  .object({
    session_id: eventId,
    location_id: locationId,
    slot: z.number().int().min(0).max(31),
    facility,
    gross: CoinString,
    driver_payout: CoinString,
    recipient_payout: CoinString,
    forfeited: CoinString,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      [
        value.gross,
        value.driver_payout,
        value.recipient_payout,
        value.forfeited,
      ].some((amount) => !/^[0-9]+$/.test(amount))
    ) {
      return;
    }
    const total =
      BigInt(value.driver_payout) +
      BigInt(value.recipient_payout) +
      BigInt(value.forfeited);
    if (total !== BigInt(value.gross)) {
      context.addIssue({
        code: "custom",
        path: ["gross"],
        message: "settlement payouts must add up to gross",
      });
    }
  });

export const GameEventPayloads = {
  player_registered: z
    .object({
      account_id: accountId,
      starter_car_id: eventId,
      grant: CoinString.optional(),
    })
    .strict(),
  car_minted: z.union([
    z.object({ car_id: eventId, owner: accountId }).strict(),
    z
      .object({
        car_id: eventId,
        owner: accountId,
        source: z.enum(["starter", "purchase"]),
        cost: CoinString,
      })
      .strict()
      .refine((value) => value.source !== "starter" || value.cost === "0", {
        message: "starter cars must be free",
      }),
  ]),
  car_repaired: z.union([
    z
      .object({
        car_id: eventId,
        points: z.number().int().min(1).max(100),
        cost: CoinString,
      })
      .strict(),
    z
      .object({
        car_id: eventId,
        points: z.literal(2),
        emergency: z.literal(true),
      })
      .strict(),
  ]),
  car_upgraded: z
    .object({
      car_id: eventId,
      tier: z.number().int().min(2).max(3),
      cost: CoinString,
    })
    .strict(),
  cosmetic_bought: z
    .object({
      account_id: accountId,
      cosmetic: z.literal("burger_decal"),
      cost: CoinString.optional(),
    })
    .strict(),
  plot_seeded: z.object({ plot_id: locationId }).strict(),
  npc_site_seeded: z
    .object({ site_id: locationId, role: z.literal("game_owned") })
    .strict(),
  plot_bought: z
    .object({ plot_id: locationId, owner: accountId, price_yocto: CoinString })
    .strict(),
  parked: z
    .object({
      session_id: eventId,
      car_id: eventId,
      driver: accountId,
      location_id: locationId,
      slot: z.number().int().min(0).max(31),
      facility,
      legal: z.boolean(),
      expires_at: timestamp,
    })
    .strict(),
  collected: settlement,
  expired: settlement,
  ticketed: settlement,
  inspection_attempted: z
    .object({ session_id: eventId, success: z.boolean() })
    .strict(),
  rule_scheduled: z
    .object({ plot_id: locationId, effective_at: timestamp })
    .strict(),
  building_updated: z.discriminatedUnion("change", [
    z
      .object({ plot_id: locationId, revision, change: z.literal("preset") })
      .strict(),
    z
      .object({
        plot_id: locationId,
        revision,
        change: z.literal("type"),
        cost: CoinString,
      })
      .strict(),
    z
      .object({
        plot_id: locationId,
        revision,
        change: z.literal("level"),
        level: z.number().int().min(2).max(4),
        cost: CoinString,
      })
      .strict(),
  ]),
  appearance_proposed: appearance,
  appearance_approved: appearance,
  appearance_rejected: appearance,
  appearance_revoked: appearance,
  media_proposed: media,
  media_approved: media,
  media_rejected: media,
  media_removed: z
    .object({ plot_id: locationId, kind: mediaKind, revision })
    .strict(),
  media_revoked: media,
  config_updated: z.object({ version: z.number().int().positive() }).strict(),
} satisfies Record<z.infer<typeof GameEventName>, z.ZodType>;

export const GameEvent = z
  .object({
    standard: z.literal("near_estate"),
    version: z.literal("1.0.0"),
    event: GameEventName,
    data: z.array(z.record(z.string(), z.unknown())).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const payloadSchema = GameEventPayloads[value.event];
    value.data.forEach((payload, index) => {
      const result = payloadSchema.safeParse(payload);
      if (!result.success) {
        for (const issue of result.error.issues) {
          context.addIssue({
            code: "custom",
            path: ["data", index, ...issue.path],
            message: issue.message,
          });
        }
      } else {
        if (
          (value.event === "parked" ||
            value.event === "collected" ||
            value.event === "expired" ||
            value.event === "ticketed") &&
          payload.facility === "Curb" &&
          typeof payload.slot === "number" &&
          payload.slot > 1
        ) {
          context.addIssue({
            code: "custom",
            path: ["data", index, "slot"],
            message: "curb slot must be 0 or 1",
          });
        }
        if (value.event === "ticketed" && payload.driver_payout !== "0") {
          context.addIssue({
            code: "custom",
            path: ["data", index, "driver_payout"],
            message: "ticketed drivers receive no payout",
          });
        }
        if (
          (value.event === "collected" || value.event === "expired") &&
          payload.forfeited !== "0"
        ) {
          context.addIssue({
            code: "custom",
            path: ["data", index, "forfeited"],
            message: "ordinary settlement cannot forfeit coins",
          });
        }
      }
    });
  });
export type GameEvent = z.infer<typeof GameEvent>;

/** Ignores ordinary logs and rejects malformed logs that claim to be game events. */
export function parseGameEventLog(log: string): GameEvent | null {
  const prefix = "EVENT_JSON:";
  if (!log.startsWith(prefix)) return null;
  return GameEvent.parse(JSON.parse(log.slice(prefix.length)));
}

export const PageRequest = z.object({
  fromIndex: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(25),
});
export const Page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextIndex: z.number().int().nonnegative().nullable(),
    total: z.number().int().nonnegative(),
  });
export const ApiError = z.object({
  code: z.string().regex(/^[A-Z_]+$/),
  message: z.string(),
  requestId: z.string().optional(),
});
export const ParkRequest = z.object({
  carId: z.string().min(1),
  space: ParkingSpaceId,
});
export const ParkResponse = z.object({
  sessionId: z.string().min(1),
  earnUntil: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  legal: z.boolean(),
});
export const SettlementResponse = z.object({
  sessionId: z.string(),
  gross: CoinString,
  driverPayout: CoinString,
  recipientPayout: CoinString,
  forfeited: CoinString,
});
