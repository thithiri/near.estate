import assert from "node:assert/strict";
import test from "node:test";
import { ChainReader } from "./chain-reader.js";

const emptyMediaSlot = {
  revision: 0,
  active: null,
  pending: null,
  last_decision: null,
  last_replacement_at: null,
};

function result(value: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: "near-estate-view",
    result: {
      result: [...new TextEncoder().encode(JSON.stringify(value))],
      block_hash: "test-final-block",
    },
  });
}

function missingMethod(): Response {
  return Response.json({
    jsonrpc: "2.0",
    result: {
      block_hash: "test-final-block",
      error:
        "wasm execution failed with error: MethodResolveError(MethodNotFound)",
    },
  });
}

test("loads a finalized player snapshot and encodes JSON arguments", async () => {
  const requested: string[] = [];
  const reader = new ChainReader(
    "estate-game.testnet",
    "https://rpc.testnet.near.org",
    (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.params.method_name === "get_account")
        assert.equal(request.params.finality, "final");
      else assert.equal(request.params.block_id, "test-final-block");
      assert.equal(request.params.account_id, "estate-game.testnet");
      const args = JSON.parse(
        Buffer.from(request.params.args_base64, "base64").toString("utf8"),
      );
      requested.push(request.params.method_name);
      if (request.params.method_name === "get_account") {
        assert.equal(args.account_id, "driver.testnet");
        return result({
          balance: "100000000",
          car_ids: [7],
          starter_car_id: 7,
          active_session_id: 12,
          last_emergency_repair_at: null,
          burger_decal: false,
          reserved_storage_bytes: 4096,
          used_storage_bytes: 100,
        });
      }
      if (request.params.method_name === "get_cars") {
        assert.equal(args.account_id, "driver.testnet");
        return result([
          {
            id: 7,
            owner: "driver.testnet",
            body: "Hatchback",
            color: "Red",
            tier: 1,
            durability: 98,
            parked_session_id: 12,
          },
        ]);
      }
      assert.deepEqual(args, { session_id: 12 });
      return result({
        id: 12,
        car_id: 7,
        driver: "driver.testnet",
        location_id: "plot-main-n-0",
        slot: 0,
        facility: "Curb",
        started_at: 100,
        earn_until: 1900,
        expires_at: 2020,
        legal: true,
        inspector_attempted: false,
        terms: {
          config_version: 1,
          base_rate_per_hour: "60000000",
          tier_multiplier_bps: 10000,
          legality_multiplier_bps: 10000,
          facility_multiplier_bps: 10000,
          meter_rate_per_hour: "0",
          earn_cap_seconds: 1800,
          ticket_recipient_bps: 7000,
          meter_recipient: null,
        },
      });
    }) as typeof fetch,
  );
  const snapshot = await reader.player("driver.testnet");
  assert.deepEqual(requested.sort(), [
    "get_account",
    "get_cars",
    "get_session",
  ]);
  assert.equal(snapshot.account?.balance, "100000000");
  assert.equal(snapshot.active_session?.id, 12);
});

test("reads the current on-chain burger decal price before purchase", async () => {
  const reader = new ChainReader("estate-game.testnet", undefined, (async (
    _url,
    init,
  ) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.params.method_name, "get_config");
    return result({ burger_decal_cost: "30000000" });
  }) as typeof fetch);
  assert.equal(await reader.burgerDecalCost(), "30000000");
});

test("rejects a mixed snapshot after ownership changes", async () => {
  const reader = new ChainReader("estate-game.testnet", undefined, (async (
    _url,
    init,
  ) => {
    const method = JSON.parse(String(init?.body)).params.method_name;
    if (method === "get_account") {
      return result({
        balance: "0",
        car_ids: [7],
        starter_car_id: 7,
        active_session_id: null,
        last_emergency_repair_at: null,
        burger_decal: false,
        reserved_storage_bytes: 4096,
        used_storage_bytes: 100,
      });
    }
    return result([
      {
        id: 7,
        owner: "other.testnet",
        body: "Sedan",
        color: "Blue",
        tier: 1,
        durability: 100,
        parked_session_id: null,
      },
    ]);
  }) as typeof fetch);
  await assert.rejects(
    reader.player("driver.testnet"),
    /changed while loading/,
  );
});

test("reports RPC errors and malformed chain results", async () => {
  const rejected = new ChainReader(
    "estate-game.testnet",
    undefined,
    (async () =>
      Response.json({
        jsonrpc: "2.0",
        error: { message: "No such contract" },
      })) as typeof fetch,
  );
  await assert.rejects(rejected.registrationQuote(), /No such contract/);

  const missingCode = new ChainReader(
    "estate-game.testnet",
    undefined,
    (async () =>
      Response.json({
        jsonrpc: "2.0",
        result: {
          block_hash: "final-block",
          error:
            'wasm execution failed: CodeDoesNotExist { account_id: "estate-game.testnet" }',
        },
      })) as typeof fetch,
  );
  await assert.rejects(
    missingCode.registrationQuote(),
    /No game contract is deployed/,
  );

  const malformed = new ChainReader(
    "estate-game.testnet",
    undefined,
    (async () => result("not-a-yocto-amount")) as typeof fetch,
  );
  await assert.rejects(malformed.registrationQuote());
});

test("reads tower floors and rejects a space outside the chosen floor", async () => {
  const reader = new ChainReader("estate-game.testnet", undefined, (async (
    _url,
    init,
  ) => {
    const params = JSON.parse(String(init?.body)).params;
    const args = JSON.parse(
      Buffer.from(params.args_base64, "base64").toString("utf8"),
    );
    assert.equal(args.site_id, "npc-main-tower");
    if (params.method_name === "get_tower_floor_availability")
      return result([0, 7, 8, 8]);
    assert.equal(params.method_name, "get_tower_open_space_on_floor");
    assert.equal(args.floor, 1);
    return result(9);
  }) as typeof fetch);
  assert.deepEqual(
    await reader.towerFloorAvailability("npc-main-tower"),
    [0, 7, 8, 8],
  );
  assert.equal(await reader.towerOpenSpaceOnFloor("npc-main-tower", 1), 9);
  await assert.rejects(
    reader.towerOpenSpaceOnFloor("npc-main-tower", 4),
    /Invalid/,
  );

  const malformed = new ChainReader(
    "estate-game.testnet",
    undefined,
    (async () => result(16)) as typeof fetch,
  );
  await assert.rejects(
    malformed.towerOpenSpaceOnFloor("npc-main-tower", 1),
    /validation|invalid|number/i,
  );

  const legacy = new ChainReader("estate-game.testnet", undefined, (async (
    _url,
    init,
  ) => {
    const method = JSON.parse(String(init?.body)).params.method_name;
    return method === "get_tower_floor_availability"
      ? Response.json({
          jsonrpc: "2.0",
          result: {
            block_hash: "test-final-block",
            error:
              "wasm execution failed with error: MethodResolveError(MethodNotFound)",
          },
        })
      : result(31);
  }) as typeof fetch);
  assert.deepEqual(await legacy.towerState("npc-main-tower"), {
    floors: null,
    available: 31,
  });
});

test("loads a tower floor from one finalized block and checks space identity", async () => {
  const requested: number[] = [];
  let batchRequests = 0;
  const session = {
    id: 42,
    car_id: 7,
    driver: "driver.testnet",
    location_id: "npc-main-tower",
    slot: 17,
    facility: "Tower",
    started_at: 100,
    earn_until: 1900,
    expires_at: 2020,
    legal: true,
    inspector_attempted: false,
    terms: {
      config_version: 1,
      base_rate_per_hour: "60000000",
      tier_multiplier_bps: 10000,
      legality_multiplier_bps: 10000,
      facility_multiplier_bps: 5000,
      meter_rate_per_hour: "0",
      earn_cap_seconds: 1800,
      ticket_recipient_bps: 7000,
      meter_recipient: null,
    },
  };
  let batchedCalls = 0;
  const batchReader = new ChainReader("estate-game.testnet", undefined, (async (
    _url,
    init,
  ) => {
    const params = JSON.parse(String(init?.body)).params;
    assert.equal(params.method_name, "get_tower_floor_sessions");
    assert.equal(params.finality, "final");
    assert.deepEqual(
      JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8")),
      { site_id: "npc-main-tower", floor: 2 },
    );
    batchedCalls++;
    return result([null, session, null, null, null, null, null, null]);
  }) as typeof fetch);
  assert.equal(
    (await batchReader.towerFloorSessions("npc-main-tower", 2))[1]?.id,
    42,
  );
  assert.equal(batchedCalls, 1);

  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const params = JSON.parse(String(init.body)).params;
    const args = JSON.parse(
      Buffer.from(params.args_base64, "base64").toString("utf8"),
    );
    if (params.method_name === "get_tower_floor_sessions") {
      batchRequests++;
      assert.equal(args.floor, 2);
      return missingMethod();
    }
    assert.equal(params.method_name, "get_tower_space_session");
    assert.equal(args.site_id, "npc-main-tower");
    if (args.space === 16) assert.equal(params.finality, "final");
    else assert.equal(params.block_id, "test-final-block");
    requested.push(args.space);
    return result(args.space === 17 ? session : null);
  }) as typeof fetch;
  const reader = new ChainReader("estate-game.testnet", undefined, fetcher);
  const spaces = await reader.towerFloorSessions("npc-main-tower", 2);
  assert.deepEqual(
    requested.sort((a, b) => a - b),
    [16, 17, 18, 19, 20, 21, 22, 23],
  );
  assert.equal(batchRequests, 1);
  assert.equal(spaces.length, 8);
  assert.equal(spaces[1]?.driver, "driver.testnet");
  assert.equal(spaces[0], null);
  await assert.rejects(
    reader.towerFloorSessions("npc-main-tower", 4),
    /Invalid/,
  );

  const mismatched = new ChainReader("estate-game.testnet", undefined, (async (
    _url,
    init,
  ) => {
    const params = JSON.parse(String(init?.body)).params;
    if (params.method_name === "get_tower_floor_sessions")
      return missingMethod();
    const args = JSON.parse(
      Buffer.from(params.args_base64, "base64").toString("utf8"),
    );
    return result(args.space === 17 ? { ...session, slot: 18 } : null);
  }) as typeof fetch);
  await assert.rejects(
    mismatched.towerFloorSessions("npc-main-tower", 2),
    /space 18 changed/,
  );

  const changedBlock = new ChainReader(
    "estate-game.testnet",
    undefined,
    (async (_url, init) => {
      const params = JSON.parse(String(init?.body)).params;
      if (params.method_name === "get_tower_floor_sessions")
        return missingMethod();
      const args = JSON.parse(
        Buffer.from(params.args_base64, "base64").toString("utf8"),
      );
      return Response.json({
        jsonrpc: "2.0",
        result: {
          result: [...new TextEncoder().encode("null")],
          block_hash:
            args.space === 16 ? "test-final-block" : "different-block",
        },
      });
    }) as typeof fetch,
  );
  await assert.rejects(
    changedBlock.towerFloorSessions("npc-main-tower", 2),
    /different block/,
  );
});

test("loads one street side and rejects misplaced occupancy", async () => {
  const plots = Array.from({ length: 8 }, (_, index) => ({
    plot: {
      plot: {
        id: `plot-main-n-${index}`,
        road_id: "main",
        side: "North",
        index,
        corner: index === 0 || index === 7,
        owner: null,
        rule: { kind: "Free" },
        pending_rule: null,
        building: {
          building_type: "Retail",
          variant: 1,
          level: 1,
          primary_color: "#F6C85F",
          name: `Plot ${index + 1}`,
          approved_manifest_hash: null,
          approved_at: null,
          last_facade_approved_at: null,
          pending_appearance: null,
          last_appearance_decision: null,
          facade_exemption_level: null,
          appearance_revision: 1,
          layout_revision: 1,
        },
        logo: emptyMediaSlot,
        billboard: emptyMediaSlot,
        ticket_cooldown_until: 0,
        reserved_storage_bytes: 4096,
        used_storage_bytes: 0,
      },
      effective_rule: { kind: "Free" },
      logo_eligible: false,
      billboard_eligible: false,
    },
    slots: [null, null],
  }));
  const street = { road_id: "main", side: "North", plots };
  const reader = new ChainReader("estate-game.testnet", undefined, (async () =>
    result(street)) as typeof fetch);
  // The deployed pre-upgrade contract omits car appearances; its street still loads.
  assert.equal((await reader.streetSide("main", "North")).plots.length, 8);

  const occupied: any = structuredClone(street);
  occupied.plots[0].slots[0] = {
    id: 42,
    car_id: 7,
    driver: "other.testnet",
    location_id: "plot-main-n-0",
    slot: 0,
    facility: "Curb",
    started_at: 100,
    earn_until: 1900,
    expires_at: 2020,
    legal: true,
    inspector_attempted: false,
    terms: {
      config_version: 1,
      base_rate_per_hour: "60000000",
      tier_multiplier_bps: 10000,
      legality_multiplier_bps: 10000,
      facility_multiplier_bps: 10000,
      meter_rate_per_hour: "0",
      earn_cap_seconds: 1800,
      ticket_recipient_bps: 7000,
      meter_recipient: null,
    },
  };
  occupied.plots[0].car_appearances = [
    { id: 7, body: "SportsCoupe", color: "Green" },
    null,
  ];
  const occupiedReader = new ChainReader(
    "estate-game.testnet",
    undefined,
    (async () => result(occupied)) as typeof fetch,
  );
  assert.deepEqual(
    (await occupiedReader.streetSide("main", "North")).plots[0]
      ?.car_appearances?.[0],
    { id: 7, body: "SportsCoupe", color: "Green" },
  );
  occupied.plots[0].car_appearances[0].id = 8;
  await assert.rejects(
    occupiedReader.streetSide("main", "North"),
    /parked car does not match/,
  );
  occupied.plots[0].car_appearances[0] = null;
  await assert.rejects(
    occupiedReader.streetSide("main", "North"),
    /parked car does not match/,
  );

  street.plots[0]!.plot.plot.id = "plot-main-n-1";
  await assert.rejects(
    reader.streetSide("main", "North"),
    /plot order changed/,
  );
});

test("loads paged owner data at one finalized block and validates purchase amounts", async () => {
  const ids = ["main", "market", "river", "central", "harbor"]
    .flatMap((road) =>
      ["North", "South"].flatMap((side) =>
        Array.from({ length: 8 }, (_, index) => ({ road, side, index })),
      ),
    )
    .slice(0, 51);
  const plots = ids.map(({ road, side, index }) => ({
    plot: {
      id: `plot-${road}-${side === "North" ? "n" : "s"}-${index}`,
      road_id: road,
      side,
      index,
      corner: index === 0 || index === 7,
      owner: index === 0 ? "owner.testnet" : null,
      rule: { kind: "Free" },
      pending_rule: null,
      building: {
        building_type: "Retail",
        variant: 1,
        level: 1,
        primary_color: "#F6C85F",
        name: `Plot ${index + 1}`,
        approved_manifest_hash: null,
        approved_at: null,
        last_facade_approved_at: null,
        pending_appearance: null,
        last_appearance_decision: null,
        facade_exemption_level: null,
        appearance_revision: 1,
        layout_revision: 1,
      },
      logo: emptyMediaSlot,
      billboard: emptyMediaSlot,
      ticket_cooldown_until: 0,
      reserved_storage_bytes: 4096,
      used_storage_bytes: 0,
    },
    effective_rule: { kind: "Free" },
    logo_eligible: false,
    billboard_eligible: false,
  }));
  const requests: Array<{ method: string; blockId?: string }> = [];
  const reader = new ChainReader("estate-game.testnet", undefined, (async (
    _url,
    init,
  ) => {
    const params = JSON.parse(String(init?.body)).params;
    const method = params.method_name as string;
    requests.push({ method, blockId: params.block_id });
    const args = JSON.parse(
      Buffer.from(params.args_base64, "base64").toString("utf8"),
    );
    if (method === "plot_count") return result(51);
    if (method === "get_plots") {
      assert.equal(params.block_id, "test-final-block");
      return result(plots.slice(args.from_index, args.from_index + args.limit));
    }
    if (method === "plot_purchase_breakdown")
      return result({
        price_yocto: "1000000000000000000000000",
        storage_reserve_yocto: "40000000000000000000000",
        total_yocto: "1040000000000000000000000",
      });
    if (method === "get_config")
      return result({
        version: 1,
        base_rate_per_hour: "60000000",
        tier_multiplier_bps: [10000, 15000, 22000],
        illegal_multiplier_bps: 15000,
        tower_multiplier_bps: 5000,
        earn_cap_seconds: 1800,
        meter_rate_max_per_hour: "30000000",
        rule_delay_seconds: 300,
        change_building_type_cost: "100000000",
        building_upgrade_costs: ["200000000", "600000000", "1500000000"],
      });
    if (method === "chain_time_seconds") return result(1_000_000);
    throw new Error(`Unexpected ${method}`);
  }) as typeof fetch);
  assert.equal((await reader.plots()).length, 51);
  assert.deepEqual(
    requests
      .filter((entry) => entry.method === "get_plots")
      .map((entry) => entry.blockId),
    ["test-final-block", "test-final-block"],
  );
  assert.equal(
    (await reader.plotPurchaseBreakdown(plots[0]!.plot.id)).total_yocto,
    "1040000000000000000000000",
  );
  assert.equal((await reader.ownerConfig()).rule_delay_seconds, 300);
  assert.equal((await reader.streetEconomyConfig()).earn_cap_seconds, 1800);
  assert.equal(await reader.chainTimeSeconds(), 1_000_000);
});
