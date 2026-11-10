import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "@near-js/accounts";
import { KeyPair } from "@near-js/crypto";
import type { ChainAppearanceReference } from "@estate/shared";
import { NearModeratorGateway } from "./moderator.js";

test("moderator signs only with its restricted role key and waits for final execution", async () => {
  const contractId = "city.testnet";
  const accountId = "moderator.testnet";
  const pair = KeyPair.fromRandom("ed25519");
  const methods = [
    "approve_appearance",
    "reject_appearance",
    "revoke_appearance",
    "approve_media",
    "reject_media",
    "revoke_media",
  ];
  let role = accountId;
  let permission: unknown = {
    FunctionCall: {
      receiver_id: contractId,
      method_names: methods,
      allowance: "500000000000000000000000",
    },
  };
  let keyMissing = false;
  let final = true;
  let transactionStatus: unknown = { SuccessValue: "" };
  const calls: Parameters<Account["callFunctionRaw"]>[0][] = [];
  const accountOverride = {
    callFunctionRaw: async (
      input: Parameters<Account["callFunctionRaw"]>[0],
    ) => {
      calls.push(input);
      return {
        final_execution_status: final ? "FINAL" : "EXECUTED",
        status: transactionStatus,
      } as Awaited<ReturnType<Account["callFunctionRaw"]>>;
    },
  } as Pick<Account, "callFunctionRaw">;
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      params: {
        request_type: string;
        public_key?: string;
        method_name?: string;
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
    assert.equal(request.params.method_name, "get_roles");
    return Response.json({
      result: {
        result: [
          ...Buffer.from(
            JSON.stringify([contractId, role, "inspector.testnet"]),
          ),
        ],
      },
    });
  };
  const gateway = new NearModeratorGateway(
    contractId,
    accountId,
    pair.toString(),
    "https://rpc.example.com",
    fetcher,
    accountOverride,
  );
  await gateway.checkAuthorization();
  const expected = {
    revision: 1,
    owner: "owner.testnet",
    building_type: "Cafe",
    level: 1,
    layout_revision: 1,
    manifest_hash: "a".repeat(64),
  } as ChainAppearanceReference;
  await gateway.approveAppearance("plot-main-n-0", expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.methodName, "approve_appearance");
  assert.equal(calls[0]?.waitUntil, "FINAL");
  assert.equal(calls[0]?.deposit, 0n);
  final = false;
  await assert.rejects(
    gateway.rejectAppearance("plot-main-n-0", expected, "No"),
    /did not finalize successfully/,
  );
  assert.equal(calls.length, 2);
  final = true;
  transactionStatus = null;
  await assert.rejects(
    gateway.approveAppearance("plot-main-n-0", expected),
    /did not finalize successfully/,
  );
  assert.equal(calls.length, 3);
  transactionStatus = { SuccessValue: "" };
  role = "other.testnet";
  await assert.rejects(
    gateway.checkAuthorization(),
    /not the contract moderator/,
  );
  role = accountId;
  permission = "FullAccess";
  await assert.rejects(
    gateway.checkAuthorization(),
    /moderation-only permission/,
  );
  for (const invalid of [
    [],
    ["approve_appearance"],
    [...methods, "buy_plot"],
  ]) {
    permission = {
      FunctionCall: {
        receiver_id: contractId,
        method_names: invalid,
        allowance: "500000000000000000000000",
      },
    };
    await assert.rejects(
      gateway.checkAuthorization(),
      /moderation-only permission/,
    );
  }
  permission = {
    FunctionCall: {
      receiver_id: "other.testnet",
      method_names: methods,
      allowance: "500000000000000000000000",
    },
  };
  await assert.rejects(
    gateway.checkAuthorization(),
    /moderation-only permission/,
  );
  for (const allowance of ["0", "500000000000000000000001"]) {
    permission = {
      FunctionCall: {
        receiver_id: contractId,
        method_names: methods,
        allowance,
      },
    };
    await assert.rejects(
      gateway.checkAuthorization(),
      /moderation-only permission/,
    );
  }
  keyMissing = true;
  await assert.rejects(
    gateway.checkAuthorization(),
    /access key is unavailable/,
  );
  assert.equal(calls.length, 3);
});
