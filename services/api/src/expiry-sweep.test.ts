import assert from "node:assert/strict";
import test from "node:test";
import { KeyPair } from "@near-js/crypto";
import type { ChainSession, ChainStreetSide } from "@estate/shared";
import {
  ExpirySweeper,
  NearExpiryGateway,
  type ExpiryGateway,
} from "./expiry-sweep.js";

function session(
  id: number,
  locationId: string,
  slot: number,
  expiresAt: number,
  facility: "Curb" | "Tower",
): ChainSession {
  return {
    id,
    location_id: locationId,
    slot,
    expires_at: expiresAt,
    facility,
  } as ChainSession;
}

function street(sessions: (ChainSession | null)[]): ChainStreetSide {
  return {
    road_id: "main",
    side: "North",
    plots: [
      {
        plot: { plot: { id: "plot-main-n-0" } },
        slots: sessions,
      },
    ],
  } as unknown as ChainStreetSide;
}

test("expiry sweep selects oldest expired curb and tower sessions with a transaction cap", async () => {
  const settled: number[] = [];
  const north = street([
    session(1, "plot-main-n-0", 0, 100, "Curb"),
    session(2, "plot-main-n-0", 1, 101, "Curb"),
  ]);
  const south = {
    road_id: "main",
    side: "South",
    plots: [],
  } as ChainStreetSide;
  const tower = [
    session(3, "npc-main-tower", 0, 99, "Tower"),
    session(4, "npc-main-tower", 1, 102, "Tower"),
    session(5, "npc-main-tower", 2, 103, "Tower"),
    null,
    null,
    null,
    null,
    null,
  ];
  const gateway: ExpiryGateway = {
    chainTime: async () => 102,
    streetSide: async (_road, side) => (side === "North" ? north : south),
    towerFloor: async () => tower,
    settleExpired: async (id) => {
      settled.push(id);
    },
    session: async () => null,
  };
  const result = await new ExpirySweeper(
    gateway,
    ["main"],
    [{ id: "npc-main-tower", capacity: 8 }],
    2,
  ).runOnce();
  assert.deepEqual(settled, [3, 1]);
  assert.deepEqual(result, {
    scanned: 5,
    eligible: 4,
    attempted: 2,
    settled: 2,
    raced: 0,
    failed: 0,
  });
});

test("expiry sweep treats a concurrent settlement as a race and leaves uncertain calls for later", async () => {
  const north = street([
    session(10, "plot-main-n-0", 0, 100, "Curb"),
    session(11, "plot-main-n-0", 1, 100, "Curb"),
  ]);
  const gateway: ExpiryGateway = {
    chainTime: async () => 100,
    streetSide: async (_road, side) =>
      side === "North"
        ? north
        : ({ road_id: "main", side: "South", plots: [] } as ChainStreetSide),
    towerFloor: async () => [],
    settleExpired: async () => {
      throw new Error("reply lost");
    },
    session: async (id) =>
      id === 10 ? null : session(11, "plot-main-n-0", 1, 100, "Curb"),
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await new ExpirySweeper(gateway, ["main"], []).runOnce();
    assert.equal(result.raced, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.settled, 0);
  } finally {
    console.error = originalError;
  }
});

test("expiry gateway requires an exact finite settle-only key before scanning", async () => {
  const pair = KeyPair.fromRandom("ed25519");
  let permission: unknown = {
    FunctionCall: {
      receiver_id: "city.testnet",
      method_names: ["settle_expired"],
      allowance: "5000000000000000000000000",
    },
  };
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      params: {
        request_type: string;
        method_name?: string;
        public_key?: string;
      };
    };
    if (request.params.request_type === "view_access_key") {
      assert.equal(request.params.public_key, pair.getPublicKey().toString());
      return Response.json({ result: { permission } });
    }
    assert.equal(request.params.method_name, "chain_time_seconds");
    return Response.json({
      result: { result: [...Buffer.from(JSON.stringify(123))] },
    });
  };
  const gateway = new NearExpiryGateway(
    "city.testnet",
    "sweeper.testnet",
    pair.toString(),
    "https://rpc.example.com",
    fetcher,
  );
  assert.equal(await gateway.chainTime(), 123);
  permission = {
    FunctionCall: {
      receiver_id: "city.testnet",
      method_names: ["settle_expired", "inspect"],
      allowance: "5000000000000000000000000",
    },
  };
  await assert.rejects(gateway.chainTime(), /settle_expired-only/);
  permission = "FullAccess";
  await assert.rejects(gateway.chainTime(), /settle_expired-only/);
});
