import assert from "node:assert/strict";
import test from "node:test";
import {
  GameEvent,
  GameEventName,
  GameEventPayloads,
  parseGameEventLog,
} from "./events.js";

const plot_id = "plot-main-n-0";
const location_id = plot_id;
const account_id = "driver.testnet";
const owner = "owner.testnet";
const manifest_hash = "a".repeat(64);
const asset_hash = "b".repeat(64);

const samples = {
  player_registered: { account_id, starter_car_id: 1, grant: "100000000" },
  car_minted: { car_id: 1, owner, source: "starter", cost: "0" },
  car_repaired: { car_id: 1, points: 2, cost: "2000000" },
  car_upgraded: { car_id: 1, tier: 2, cost: "200000000" },
  cosmetic_bought: { account_id, cosmetic: "burger_decal", cost: "30000000" },
  plot_seeded: { plot_id },
  npc_site_seeded: { site_id: "npc-main-tower", role: "game_owned" },
  plot_bought: { plot_id, owner, price_yocto: "1000000000000000000000000" },
  ticket_reward_policy_set: { daily_owner_cap: "15000000" },
  plot_agent_authorized: {
    owner,
    public_key: "ed25519:agentkey",
    expires_at: 7_200,
  },
  plot_agent_revoked: { owner },
  plot_agent_action: {
    owner,
    public_key: "ed25519:agentkey",
    plot_id,
    kind: "Design",
    at: 7_200,
    coin_cost: "0",
  },
  destination_heart: {
    owner,
    car_id: 1,
    site_id: "npc-harbor-cinema",
    session_id: 1,
    hearts: 1,
  },
  visit_bonus_paid: { owner, car_id: 1, session_id: 1, amount: "2000000" },
  heart_policy_set: {
    max_hearts_per_car: 2,
    claims_per_day: 2,
    bonuses_per_day: 2,
    bonus_coins: "2000000",
    min_park_seconds: 600,
    nearby_plots: 2,
  },
  parked: {
    session_id: 1,
    car_id: 1,
    driver: account_id,
    location_id,
    slot: 0,
    facility: "Curb",
    legal: true,
    expires_at: 1_800,
  },
  collected: {
    session_id: 1,
    location_id,
    slot: 0,
    facility: "Curb",
    gross: "5000000",
    driver_payout: "2500000",
    recipient_payout: "2500000",
    forfeited: "0",
  },
  expired: {
    session_id: 1,
    location_id,
    slot: 0,
    facility: "Curb",
    gross: "5000000",
    driver_payout: "5000000",
    recipient_payout: "0",
    forfeited: "0",
  },
  ticketed: {
    session_id: 1,
    location_id,
    slot: 0,
    facility: "Curb",
    gross: "5000000",
    driver_payout: "0",
    recipient_payout: "3500000",
    forfeited: "1500000",
  },
  inspection_attempted: { session_id: 1, success: false },
  rule_scheduled: { plot_id, effective_at: 1_300 },
  building_updated: { plot_id, revision: 2, change: "preset" },
  appearance_proposed: { plot_id, revision: 2, manifest_hash },
  appearance_approved: { plot_id, revision: 2, manifest_hash },
  appearance_rejected: { plot_id, revision: 2, manifest_hash },
  appearance_revoked: { plot_id, revision: 2, manifest_hash },
  media_proposed: { plot_id, kind: "Logo", revision: 1, asset_hash },
  media_approved: { plot_id, kind: "Logo", revision: 1, asset_hash },
  media_rejected: { plot_id, kind: "Logo", revision: 1, asset_hash },
  media_removed: { plot_id, kind: "Logo", revision: 1 },
  media_revoked: { plot_id, kind: "Logo", revision: 1, asset_hash },
  config_updated: { version: 2 },
};

function envelope(event: string, data: object) {
  return { standard: "near_estate", version: "1.0.0", event, data: [data] };
}

test("every declared contract event has a payload schema", () => {
  assert.deepEqual(
    Object.keys(GameEventPayloads).sort(),
    [...GameEventName.options].sort(),
  );
  assert.deepEqual(
    Object.keys(samples).sort(),
    [...GameEventName.options].sort(),
  );
  for (const [event, data] of Object.entries(samples)) {
    assert.equal(
      GameEvent.safeParse(envelope(event, data)).success,
      true,
      event,
    );
  }
});

test("event validation rejects malformed economic and moderation records", () => {
  assert.equal(
    GameEvent.safeParse(
      envelope("parked", { ...samples.parked, session_id: "1" }),
    ).success,
    false,
  );
  assert.equal(
    GameEvent.safeParse(
      envelope("collected", { ...samples.collected, gross: 5_000_000 }),
    ).success,
    false,
  );
  assert.equal(
    GameEvent.safeParse(
      envelope("collected", { ...samples.collected, gross: "not-a-coin" }),
    ).success,
    false,
  );
  assert.equal(
    GameEvent.safeParse(
      envelope("media_approved", {
        ...samples.media_approved,
        asset_hash: "bad",
      }),
    ).success,
    false,
  );
  assert.equal(
    GameEvent.safeParse(
      envelope("inspection_attempted", {
        ...samples.inspection_attempted,
        extra: true,
      }),
    ).success,
    false,
  );
  assert.equal(
    GameEvent.safeParse({
      ...envelope("config_updated", samples.config_updated),
      version: "2.0.0",
    }).success,
    false,
  );
});

test("payload variants accept paid building changes and emergency repair", () => {
  assert.equal(
    GameEvent.safeParse(
      envelope("building_updated", {
        plot_id,
        revision: 3,
        change: "design",
        design_choice: 4,
      }),
    ).success,
    true,
  );
  assert.equal(
    GameEvent.safeParse(
      envelope("building_updated", {
        plot_id,
        revision: 3,
        change: "level",
        level: 2,
        cost: "200000000",
      }),
    ).success,
    true,
  );
  assert.equal(
    GameEvent.safeParse(
      envelope("car_repaired", { car_id: 1, points: 2, emergency: true }),
    ).success,
    true,
  );
});

test("ticket owner and treasury split must reconcile to recipient payout", () => {
  const ticket = {
    ...samples.ticketed,
    owner_payout: "1500000",
    treasury_payout: "2000000",
    owner_account: owner,
  };
  assert.equal(GameEvent.safeParse(envelope("ticketed", ticket)).success, true);
  assert.equal(
    GameEvent.safeParse(
      envelope("ticketed", { ...ticket, treasury_payout: "1000000" }),
    ).success,
    false,
  );
  assert.equal(
    GameEvent.safeParse(
      envelope("ticketed", { ...ticket, owner_account: null }),
    ).success,
    false,
  );
});

test("variable-width curb events accept slot 2 and reject slots beyond it", () => {
  assert.equal(
    GameEvent.safeParse(envelope("parked", { ...samples.parked, slot: 2 }))
      .success,
    true,
  );
  assert.equal(
    GameEvent.safeParse(
      envelope("collected", { ...samples.collected, slot: 2 }),
    ).success,
    true,
  );
  assert.equal(
    GameEvent.safeParse(envelope("parked", { ...samples.parked, slot: 3 }))
      .success,
    false,
  );
});

test("new coin events record spending while historical records remain readable", () => {
  for (const [event, payload] of [
    ["player_registered", { account_id, starter_car_id: 1 }],
    ["car_minted", { car_id: 1, owner }],
    ["cosmetic_bought", { account_id, cosmetic: "burger_decal" }],
  ] as const) {
    assert.equal(GameEvent.safeParse(envelope(event, payload)).success, true);
  }
  assert.equal(
    GameEvent.safeParse(
      envelope("car_minted", {
        car_id: 2,
        owner,
        source: "purchase",
        cost: "150000000",
      }),
    ).success,
    true,
  );
  assert.equal(
    GameEvent.safeParse(
      envelope("car_minted", {
        car_id: 1,
        owner,
        source: "starter",
        cost: "1",
      }),
    ).success,
    false,
  );
});

test("event log parser separates ordinary logs from validated game events", () => {
  assert.equal(parseGameEventLog("ordinary contract log"), null);
  assert.deepEqual(
    parseGameEventLog(
      `EVENT_JSON:${JSON.stringify(envelope("config_updated", { version: 2 }))}`,
    ),
    envelope("config_updated", { version: 2 }),
  );
  assert.throws(() => parseGameEventLog("EVENT_JSON:{not json}"));
  assert.throws(() =>
    parseGameEventLog(
      `EVENT_JSON:${JSON.stringify(envelope("parked", { ...samples.parked, slot: 3 }))}`,
    ),
  );
});

test("settlement events conserve gross and match their outcome", () => {
  assert.equal(
    GameEvent.safeParse(
      envelope("ticketed", {
        ...samples.ticketed,
        recipient_payout: "3500001",
      }),
    ).success,
    false,
  );
  assert.equal(
    GameEvent.safeParse(
      envelope("ticketed", {
        ...samples.ticketed,
        driver_payout: "1",
        forfeited: "1499999",
      }),
    ).success,
    false,
  );
  assert.equal(
    GameEvent.safeParse(
      envelope("collected", {
        ...samples.collected,
        forfeited: "1",
        driver_payout: "2499999",
      }),
    ).success,
    false,
  );
});
