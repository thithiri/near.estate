import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KeyPair } from "@near-js/crypto";
import { InspectorStatus, type ChainStreetSide } from "@estate/shared";
import {
  InspectorPatrol,
  NearInspectorGateway,
  type InspectorGateway,
} from "./inspector-patrol.js";
import {
  InspectorStatusTracker,
  readInspectorStatus,
  writeInspectorStatus,
} from "./inspector-status.js";

function street(): ChainStreetSide {
  return {
    road_id: "main",
    side: "North",
    plots: Array.from({ length: 4 }, (_, index) => {
      const plotId = `plot-main-n-${index}`;
      return {
        plot: { plot: { id: plotId } },
        slots: [0, 1].map((slot) => ({
          id: index * 2 + slot + 1,
          location_id: plotId,
          slot,
          facility: "Curb",
          legal: false,
          inspector_attempted: false,
          started_at: 100,
          expires_at: 900,
        })),
      };
    }),
  } as unknown as ChainStreetSide;
}

test("patrol chooses one random side and attempts only a bounded fraction", async () => {
  const attempts: Array<[string, number, number]> = [];
  const gateway: InspectorGateway = {
    readRules: async () => ({
      minAgeSeconds: 300,
      maxAttempts: 8,
      nowSeconds: 500,
    }),
    streetSide: async () => street(),
    inspect: async (plotId, slot, sessionId) => {
      attempts.push([plotId, slot, sessionId]);
    },
  };
  const result = await new InspectorPatrol(
    gateway,
    ["main"],
    () => 0,
  ).runOnce();
  assert.deepEqual(result, {
    roadId: "main",
    side: "North",
    eligible: 8,
    attempted: 2,
    failed: 0,
  });
  assert.deepEqual(attempts, [
    ["plot-main-n-0", 0, 1],
    ["plot-main-n-0", 1, 2],
  ]);
});

test("patrol excludes ineligible sessions and obeys a tighter chain limit", async () => {
  const snapshot = street();
  snapshot.plots[0]!.slots[0]!.legal = true;
  snapshot.plots[0]!.slots[1]!.inspector_attempted = true;
  snapshot.plots[1]!.slots[0]!.started_at = 300;
  snapshot.plots[1]!.slots[1]!.expires_at = 500;
  let calls = 0;
  const gateway: InspectorGateway = {
    readRules: async () => ({
      minAgeSeconds: 300,
      maxAttempts: 1,
      nowSeconds: 500,
    }),
    streetSide: async () => snapshot,
    inspect: async () => {
      calls++;
    },
  };
  const result = await new InspectorPatrol(
    gateway,
    ["main"],
    () => 0,
  ).runOnce();
  assert.equal(result.eligible, 4);
  assert.equal(result.attempted, 1);
  assert.equal(calls, 1);
});

test("inspector status records repeated failures and recovers without exposing a key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "estate-patrol-status-"));
  const path = join(directory, "patrol.json");
  try {
    const tracker = new InspectorStatusTracker("city.testnet");
    const failedRun = {
      roadId: "main",
      side: "North" as const,
      eligible: 2,
      attempted: 2,
      failed: 2,
    };
    assert.equal(tracker.completed(failedRun, 100).consecutiveFailures, 1);
    assert.equal(tracker.failed(200).consecutiveFailures, 2);
    const third = tracker.completed(failedRun, 300);
    assert.equal(third.consecutiveFailures, 3);
    await writeInspectorStatus(path, third);
    assert.deepEqual(
      InspectorStatus.parse(JSON.parse(await readFile(path, "utf8"))),
      third,
    );
    assert.equal(
      readInspectorStatus(path, "city.testnet")?.consecutiveFailures,
      3,
    );
    assert.equal(readInspectorStatus(path, "other.testnet"), null);
    const restarted = new InspectorStatusTracker(
      "city.testnet",
      readInspectorStatus(path, "city.testnet")?.consecutiveFailures,
    );
    assert.equal(restarted.completed(failedRun, 350).consecutiveFailures, 4);
    assert.equal(
      tracker.completed({ ...failedRun, attempted: 0, failed: 0 }, 400)
        .consecutiveFailures,
      3,
    );
    assert.equal(
      tracker.completed({ ...failedRun, attempted: 1, failed: 0 }, 500)
        .consecutiveFailures,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspector checks its on-chain role and inspect-only access key before a quiet patrol", async () => {
  const contractId = "city.testnet";
  const accountId = "inspector.testnet";
  const pair = KeyPair.fromRandom("ed25519");
  let permission: unknown = {
    FunctionCall: {
      receiver_id: contractId,
      method_names: ["inspect"],
      allowance: "250000000000000000000000",
    },
  };
  let inspectorRole = accountId;
  let keyMissing = false;
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      params: {
        request_type: string;
        method_name?: string;
        public_key?: string;
        finality: string;
      };
    };
    assert.equal(request.params.finality, "final");
    if (request.params.request_type === "view_access_key") {
      assert.equal(request.params.public_key, pair.getPublicKey().toString());
      return Response.json(
        keyMissing
          ? { error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } }
          : { result: { permission, block_hash: "finalized-block" } },
      );
    }
    const value =
      request.params.method_name === "get_config"
        ? {
            inspector_min_age_seconds: 300,
            inspector_max_attempts_per_window: 8,
          }
        : request.params.method_name === "get_roles"
          ? [contractId, "moderator.testnet", inspectorRole]
          : 500;
    return Response.json({
      result: { result: [...Buffer.from(JSON.stringify(value))] },
    });
  };
  const gateway = new NearInspectorGateway(
    contractId,
    accountId,
    pair.toString(),
    "https://rpc.example.com",
    fetcher,
  );
  assert.deepEqual(await gateway.readRules(), {
    minAgeSeconds: 300,
    maxAttempts: 8,
    nowSeconds: 500,
  });
  inspectorRole = "other.testnet";
  await assert.rejects(gateway.readRules(), /not the contract inspector/);
  inspectorRole = accountId;
  permission = "FullAccess";
  await assert.rejects(gateway.readRules(), /inspect-only allowance/);
  permission = {
    FunctionCall: {
      receiver_id: contractId,
      method_names: [],
      allowance: "250000000000000000000000",
    },
  };
  await assert.rejects(gateway.readRules(), /inspect-only allowance/);
  permission = {
    FunctionCall: {
      receiver_id: contractId,
      method_names: ["inspect"],
      allowance: "250000000000000000000001",
    },
  };
  await assert.rejects(gateway.readRules(), /inspect-only allowance/);
  permission = {
    FunctionCall: {
      receiver_id: contractId,
      method_names: ["inspect"],
      allowance: "0",
    },
  };
  await assert.rejects(gateway.readRules(), /inspect-only allowance/);
  permission = {
    FunctionCall: {
      receiver_id: "other.testnet",
      method_names: ["inspect"],
      allowance: "250000000000000000000000",
    },
  };
  await assert.rejects(gateway.readRules(), /inspect-only allowance/);
  keyMissing = true;
  await assert.rejects(gateway.readRules(), /access key is unavailable/);
});
