import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { KeyPair } from "@near-js/crypto";
import { baseEncode } from "@near-js/utils";
import {
  GAMEPLAY_KEY_ALLOWANCE,
  GAMEPLAY_METHODS,
  GameWalletClient,
  PARKING_AGENT_KEY_ALLOWANCE,
  PARKING_AGENT_METHODS,
  PLOT_AGENT_KEY_ALLOWANCE,
  PLOT_AGENT_METHODS,
  type GameplayKeyStatus,
  type MockGenerationJob,
} from "./wallet-client.js";

test("Meteor wallet browser module and its SDK import cleanly", async () => {
  const [wallet] = await Promise.all([
    import("@near-wallet-selector/meteor-wallet"),
    import("@meteorwallet/sdk"),
  ]);
  assert.equal(typeof wallet.setupMeteorWallet, "function");
});

test("plot agent setup grants exact methods and revokes grant before key", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
  const pair = KeyPair.fromRandom("ed25519");
  const publicKey = pair.getPublicKey().toString();
  const calls: string[] = [];
  let key: any = null;
  let grant: any = null;
  const client = Object.assign(Object.create(GameWalletClient.prototype), {
    reader: {
      contractId: "estate.testnet",
      accessKeyList: async () => ({ keys: key ? [key] : [] }),
      plotAgentStatus: async () => grant,
      plotAgentStorageQuote: async () => "10240000000000000000000",
      chainTimeSeconds: async () => 1_000,
    },
    selector: {
      store: {
        getState: () => ({
          contract: { contractId: "estate.testnet" },
          accounts: [{ accountId: "owner.testnet", active: true }],
        }),
      },
      wallet: async () => ({
        signAndSendTransaction: async ({
          receiverId,
          actions,
        }: {
          receiverId: string;
          actions: any[];
        }) => {
          const action = actions[0];
          calls.push(action.enum);
          if (action.enum === "addKey") {
            assert.equal(receiverId, "owner.testnet");
            const permission = action.addKey.accessKey.permission.functionCall;
            assert.deepEqual(permission.methodNames, [...PLOT_AGENT_METHODS]);
            assert.equal(permission.allowance, PLOT_AGENT_KEY_ALLOWANCE);
            key = {
              public_key: publicKey,
              access_key: {
                permission: {
                  FunctionCall: {
                    receiver_id: "estate.testnet",
                    method_names: [...PLOT_AGENT_METHODS],
                    allowance: PLOT_AGENT_KEY_ALLOWANCE.toString(),
                  },
                },
              },
            };
          } else if (action.enum === "functionCall") {
            assert.equal(receiverId, "estate.testnet");
            if (action.functionCall.methodName === "authorize_plot_agent") {
              grant = {
                grant: { public_key: publicKey },
                coins_remaining_today: "0",
                actions_remaining_today: 5,
              };
            } else if (action.functionCall.methodName === "revoke_plot_agent") {
              grant = null;
            } else assert.fail("unexpected plot agent contract method");
          } else if (action.enum === "deleteKey") {
            assert.equal(receiverId, "owner.testnet");
            assert.equal(grant, null, "grant must be gone before deleting key");
            key = null;
          } else assert.fail(`unexpected action ${action.enum}`);
        },
      }),
    },
  }) as GameWalletClient;
  try {
    assert.equal(
      (
        await client.authorizePlotAgent(
          publicKey,
          ["plot-main-n-0"],
          "0",
          5,
          false,
        )
      ).state,
      "ready",
    );
    assert.deepEqual(calls, ["addKey", "functionCall"]);
    assert.equal((await client.revokePlotAgent()).state, "none");
    assert.deepEqual(calls, [
      "addKey",
      "functionCall",
      "functionCall",
      "deleteKey",
    ]);
  } finally {
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("Meteor SDK popup dependencies support its actual call shapes", async () => {
  const meteorRequire = createRequire(
    import.meta.resolve("@meteorwallet/sdk/package.json"),
  );
  const queryString = meteorRequire("query-string") as {
    stringify: (values: Record<string, string>) => string;
  };
  const nanoid = (await import(
    pathToFileURL(meteorRequire.resolve("nanoid")).href
  )) as {
    nanoid: () => string;
  };
  assert.equal(typeof queryString.stringify, "function");
  assert.equal(
    queryString.stringify({
      source: "website_post_message",
      connectionUid: "abc-123",
      pageUri: encodeURIComponent(
        "https://game.example/street?plot=1&side=north",
      ),
    }),
    "connectionUid=abc-123&pageUri=https%253A%252F%252Fgame.example%252Fstreet%253Fplot%253D1%2526side%253Dnorth&source=website_post_message",
  );
  assert.match(nanoid.nanoid(), /^[A-Za-z0-9_-]{21}$/);
});

test("variable-width design choice uses the owner wallet and confirms chain state", async () => {
  let chosen = 0;
  let signed = 0;
  const client = Object.assign(Object.create(GameWalletClient.prototype), {
    reader: {
      contractId: "estate.testnet",
      plot: async () => ({
        plot: {
          owner: "owner.testnet",
          frontage_units: 3,
          design_choice: chosen,
        },
      }),
    },
    selector: {
      store: {
        getState: () => ({
          contract: { contractId: "estate.testnet" },
          accounts: [{ accountId: "owner.testnet", active: true }],
        }),
      },
      wallet: async () => ({
        signAndSendTransaction: async () => {
          signed++;
          chosen = 4;
        },
      }),
    },
  }) as GameWalletClient;
  await assert.rejects(
    client.chooseDesign("plot-main-n-9", 5),
    /five building/,
  );
  assert.equal(signed, 0);
  await client.chooseDesign("plot-main-n-9", 4);
  assert.equal(signed, 1);
  assert.equal(chosen, 4);
});

test("a restored version-2 design job cannot propose after the plot design changes", async () => {
  const originalFetch = globalThis.fetch;
  let ownerCalls = 0;
  const job = {
    id: "job-v2",
    accountId: "owner.testnet",
    plotId: "plot-main-n-0",
    buildingType: "Cafe",
    level: 2,
    layoutRevision: 7,
    appearanceRevision: 3,
    description: "Copper trim",
    promptSpec: {
      version: 5,
      frontageUnits: 1,
      designChoice: 0,
      buildingType: "Cafe",
      level: 2,
    },
    status: "ready",
    selectedCandidateId: null,
    proposalRevision: null,
    decidedAt: null,
    decisionReason: null,
    mode: "curated_mock",
    candidates: [
      {
        id: 1,
        variant: 1,
        palette: "#F6C85F",
        manifest: {
          schemaVersion: 2,
          frontageUnits: 1,
          designChoice: 0,
        },
        manifestHash: "a".repeat(64),
      },
    ],
  } as MockGenerationJob;
  const client = Object.assign(Object.create(GameWalletClient.prototype), {
    requiredAccount: () => "owner.testnet",
    artworkSession: async () => {},
    ownerPlot: async () => ({
      plot: {
        frontage_units: 1,
        design_choice: 1,
        building: {
          layout_revision: 7,
          appearance_revision: 3,
          building_type: "Cafe",
          level: 2,
        },
      },
    }),
    ownerCall: async () => {
      ownerCalls++;
    },
  }) as GameWalletClient;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        jobId: job.id,
        candidateId: 1,
        plotId: job.plotId,
        expectedRevision: 3,
        manifestHash: "a".repeat(64),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    await assert.rejects(
      client.submitMockGeneration(job, 1),
      /building changed/,
    );
    assert.equal(ownerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a reviewed version-2 image submits only its selected manifest through the owner wallet", async () => {
  const originalFetch = globalThis.fetch;
  const manifestHash = "b".repeat(64);
  const job = {
    id: "reviewed-v2-image",
    accountId: "owner.testnet",
    plotId: "plot-main-n-7",
    buildingType: "Retail",
    level: 2,
    layoutRevision: 5,
    appearanceRevision: 6,
    description: "Warm market windows",
    promptSpec: {
      version: 5,
      frontageUnits: 3,
      designChoice: 0,
      buildingType: "Retail",
      level: 2,
    },
    status: "ready",
    selectedCandidateId: null,
    proposalRevision: null,
    decidedAt: null,
    decisionReason: null,
    mode: "paid",
    candidates: [{ id: 1, manifestHash }],
  } as MockGenerationJob;
  const ownerCalls: Array<{
    method: string;
    args: unknown;
    accountId: string;
  }> = [];
  const client = Object.assign(Object.create(GameWalletClient.prototype), {
    requiredAccount: () => "owner.testnet",
    artworkSession: async () => {},
    ownerPlot: async () => ({
      plot: {
        owner: "owner.testnet",
        frontage_units: 3,
        design_choice: 0,
        building: {
          layout_revision: 5,
          appearance_revision: 6,
          building_type: "Retail",
          level: 2,
        },
      },
    }),
    ownerCall: async (method: string, args: unknown, accountId: string) => {
      ownerCalls.push({ method, args, accountId });
    },
    reconcileMockGeneration: async () => ({
      ...job,
      status: "submitted",
      proposalRevision: 7,
    }),
  }) as GameWalletClient;
  globalThis.fetch = async (input) => {
    assert.equal(input, `/api/generations/${job.id}/select`);
    return new Response(
      JSON.stringify({
        jobId: job.id,
        candidateId: 1,
        plotId: job.plotId,
        expectedRevision: 6,
        manifestHash,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await client.submitMockGeneration(job, 1);
    assert.equal(result.status, "submitted");
    assert.deepEqual(ownerCalls, [
      {
        method: "propose_appearance",
        args: {
          plot_id: "plot-main-n-7",
          expected_revision: 6,
          manifest_hash: manifestHash,
        },
        accountId: "owner.testnet",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uncertain gameplay submission retries only its original signed transaction", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const pair = KeyPair.fromRandom("ed25519");
  const keyName =
    "near-estate:testnet:estate.testnet:driver.testnet:gameplay-key";
  values.set(
    keyName,
    JSON.stringify({
      accountId: "driver.testnet",
      publicKey: pair.getPublicKey().toString(),
      secretKey: pair.toString(),
    }),
  );
  const signedBytes: string[] = [];
  let keyReads = 0;
  let statusReads = 0;
  const client = Object.assign(Object.create(GameWalletClient.prototype), {
    reader: {
      contractId: "estate.testnet",
      accessKey: async () => {
        keyReads++;
        return {
          nonce: 7n,
          blockHash: baseEncode(new Uint8Array(32).fill(8)),
          blockHeight: 100,
        };
      },
      transactionValidityPeriod: async () => 100,
      sendSignedTransaction: async (bytes: string) => {
        signedBytes.push(bytes);
        if (signedBytes.length === 1) throw new Error("network dropped reply");
        return "success";
      },
      transactionStatus: async () => {
        statusReads++;
        return "unknown";
      },
    },
    selector: {
      store: {
        getState: () => ({
          contract: { contractId: "estate.testnet" },
          accounts: [{ accountId: "driver.testnet", active: true }],
        }),
      },
    },
    lastCall: Promise.resolve(),
  }) as GameWalletClient;
  try {
    await assert.rejects(
      client.gameplayCall("park", { car_id: 7, plot_id: 2, slot: 0 }),
      /pending/,
    );
    const saved = JSON.parse(values.get(`${keyName}:action`) ?? "null") as {
      version: number;
      hash: string;
      signedTxBase64: string;
      signedAtBlockHeight: number;
      nonce: string;
    };
    assert.equal(saved.version, 2);
    assert.equal(saved.signedAtBlockHeight, 100);
    assert.equal(saved.nonce, "8");
    assert.match(saved.hash, /^[1-9A-HJ-NP-Za-km-z]+$/);
    assert.equal(saved.signedTxBase64, signedBytes[0]);
    await client.gameplayCall("park", { car_id: 7, plot_id: 2, slot: 0 });
    assert.equal(keyReads, 2);
    assert.equal(statusReads, 2);
    assert.deepEqual(signedBytes, [saved.signedTxBase64, saved.signedTxBase64]);
    assert.equal(values.has(`${keyName}:action`), false);
  } finally {
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("pending action checker keeps an in-flight transaction until final", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const pair = KeyPair.fromRandom("ed25519");
  const keyName =
    "near-estate:testnet:estate.testnet:driver.testnet:gameplay-key";
  values.set(
    keyName,
    JSON.stringify({
      accountId: "driver.testnet",
      publicKey: pair.getPublicKey().toString(),
      secretKey: pair.toString(),
    }),
  );
  const savedAction = JSON.stringify({
    version: 1,
    accountId: "driver.testnet",
    publicKey: pair.getPublicKey().toString(),
    method: "park",
    argsJson: '{"car_id":7}',
    hash: "1".repeat(44),
    signedTxBase64: "c2lnbmVk",
  });
  values.set(`${keyName}:action`, savedAction);
  let checks = 0;
  const client = Object.assign(Object.create(GameWalletClient.prototype), {
    reader: {
      contractId: "estate.testnet",
      transactionStatus: async () => (++checks === 1 ? "pending" : "success"),
      sendSignedTransaction: async () => {
        throw new Error("An included transaction must not be rebroadcast");
      },
    },
    selector: {
      store: {
        getState: () => ({
          contract: { contractId: "estate.testnet" },
          accounts: [{ accountId: "driver.testnet", active: true }],
        }),
      },
    },
  }) as GameWalletClient;
  try {
    assert.equal(client.hasPendingGameplayAction(), true);
    assert.equal(await client.checkPendingGameplayAction(), "pending");
    assert.equal(client.hasPendingGameplayAction(), true);
    assert.equal(await client.checkPendingGameplayAction(), "success");
    assert.equal(client.hasPendingGameplayAction(), false);
    assert.equal(checks, 2);
  } finally {
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("a failed gameplay action shows the contract's final error", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const pair = KeyPair.fromRandom("ed25519");
  const keyName =
    "near-estate:testnet:estate.testnet:driver.testnet:gameplay-key";
  values.set(
    keyName,
    JSON.stringify({
      accountId: "driver.testnet",
      publicKey: pair.getPublicKey().toString(),
      secretKey: pair.toString(),
    }),
  );
  const savedAction = JSON.stringify({
    version: 1,
    accountId: "driver.testnet",
    publicKey: pair.getPublicKey().toString(),
    method: "park",
    argsJson: '{"car_id":7}',
    hash: "1".repeat(44),
    signedTxBase64: "c2lnbmVk",
  });
  values.set(`${keyName}:action`, savedAction);
  const client = Object.assign(Object.create(GameWalletClient.prototype), {
    reader: {
      contractId: "estate.testnet",
      transactionStatus: async () => "failure",
      transactionFailureMessage: async () => "parking space is occupied",
      sendSignedTransaction: async () => {
        throw new Error("Final failed transaction must not be rebroadcast");
      },
    },
    selector: {
      store: {
        getState: () => ({
          contract: { contractId: "estate.testnet" },
          accounts: [{ accountId: "driver.testnet", active: true }],
        }),
      },
    },
    lastCall: Promise.resolve(),
  }) as GameWalletClient;
  try {
    await assert.rejects(
      client.gameplayCall("park", { car_id: 7 }),
      /parking space is occupied/,
    );
    assert.equal(values.has(`${keyName}:action`), false);
    values.set(`${keyName}:action`, savedAction);
    assert.equal(await client.checkPendingGameplayAction(), "failure");
    assert.equal(client.failedGameplayReason, "parking space is occupied");
    assert.equal(values.has(`${keyName}:action`), false);
  } finally {
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("expired pending action clears only when its nonce was never used", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const pair = KeyPair.fromRandom("ed25519");
  const keyName =
    "near-estate:testnet:estate.testnet:driver.testnet:gameplay-key";
  const actionName = `${keyName}:action`;
  values.set(
    keyName,
    JSON.stringify({
      accountId: "driver.testnet",
      publicKey: pair.getPublicKey().toString(),
      secretKey: pair.toString(),
    }),
  );
  const action = JSON.stringify({
    version: 2,
    accountId: "driver.testnet",
    publicKey: pair.getPublicKey().toString(),
    method: "park",
    argsJson: '{"car_id":7}',
    hash: "1".repeat(44),
    signedTxBase64: "c2lnbmVk",
    signedAtBlockHeight: 100,
    nonce: "8",
  });
  values.set(actionName, action);
  let chainNonce = 7n;
  let sends = 0;
  const client = Object.assign(Object.create(GameWalletClient.prototype), {
    reader: {
      contractId: "estate.testnet",
      transactionStatus: async () => "unknown",
      accessKey: async () => ({
        nonce: chainNonce,
        blockHash: "unused",
        blockHeight: 203,
      }),
      transactionValidityPeriod: async () => 100,
      sendSignedTransaction: async () => {
        sends++;
        return "pending";
      },
    },
    selector: {
      store: {
        getState: () => ({
          contract: { contractId: "estate.testnet" },
          accounts: [{ accountId: "driver.testnet", active: true }],
        }),
      },
    },
  }) as GameWalletClient;
  try {
    assert.equal(await client.checkPendingGameplayAction(), "expired");
    assert.equal(values.has(actionName), false);
    assert.equal(sends, 0);
    values.set(actionName, action);
    chainNonce = 8n;
    assert.equal(await client.checkPendingGameplayAction(), "pending");
    assert.equal(values.has(actionName), true);
    assert.equal(sends, 1);
  } finally {
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

function disconnectedClient(
  status: GameplayKeyStatus,
  revokeResult: "revoked" | "pending" = "revoked",
) {
  const calls: string[] = [];
  const client = Object.assign(Object.create(GameWalletClient.prototype), {
    reader: { contractId: "estate.testnet" },
    selector: {
      store: {
        getState: () => ({
          contract: { contractId: "estate.testnet" },
          accounts: [{ accountId: "driver.testnet", active: true }],
        }),
      },
      wallet: async () => ({
        signOut: async () => {
          calls.push("wallet");
        },
      }),
    },
  }) as GameWalletClient;
  client.resumePendingKey = async () => {
    calls.push("check-key");
    return status;
  };
  client.revokeGameplayKey = async () => {
    calls.push("revoke-key");
    return revokeResult;
  };
  return { client, calls };
}

test("disconnect revokes an active gameplay key before logging out", async () => {
  const originalFetch = globalThis.fetch;
  const { client, calls } = disconnectedClient("ready");
  globalThis.fetch = (async (input) => {
    assert.equal(input, "/api/auth/logout");
    calls.push("logout-api");
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await client.signOut();
    assert.deepEqual(calls, [
      "check-key",
      "revoke-key",
      "logout-api",
      "wallet",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disconnect keeps the wallet connected until key revocation is final", async () => {
  const originalFetch = globalThis.fetch;
  const { client, calls } = disconnectedClient("ready", "pending");
  globalThis.fetch = (async () => {
    calls.push("logout-api");
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(client.signOut(), /Wait for gameplay key revocation/);
    assert.deepEqual(calls, ["check-key", "revoke-key"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disconnect waits when the artwork session cannot be ended", async () => {
  const originalFetch = globalThis.fetch;
  const { client, calls } = disconnectedClient("none");
  globalThis.fetch = (async () => {
    calls.push("logout-api");
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  try {
    await assert.rejects(client.signOut(), /Could not end the artwork session/);
    assert.deepEqual(calls, ["check-key", "logout-api"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pending gameplay key survives a closed tab and recovers after chain confirmation", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  const selector = {
    store: {
      getState: () => ({
        contract: { contractId: "estate.testnet" },
        accounts: [{ accountId: "driver.testnet", active: true }],
      }),
    },
    wallet: async () => ({
      signAndSendTransaction: async () => {
        throw new Error("wallet redirect interrupted");
      },
    }),
  };
  const keyName =
    "near-estate:testnet:estate.testnet:driver.testnet:gameplay-key";
  try {
    const firstTab = Object.assign(Object.create(GameWalletClient.prototype), {
      reader: { contractId: "estate.testnet" },
      selector,
    }) as GameWalletClient;
    await assert.rejects(
      firstTab.addGameplayKey(),
      /wallet redirect interrupted/,
    );
    const pending = JSON.parse(values.get(`${keyName}:pending`) ?? "null") as {
      publicKey: string;
      secretKey: string;
      operation: string;
    };
    assert.equal(pending.operation, "add");
    assert.match(pending.secretKey, /^ed25519:/);

    const reopenedTab = Object.assign(
      Object.create(GameWalletClient.prototype),
      {
        reader: {
          contractId: "estate.testnet",
          accessKeyList: async () => ({
            block_hash: "test-final-block",
            keys: [
              {
                public_key: pending.publicKey,
                access_key: {
                  permission: {
                    FunctionCall: {
                      receiver_id: "estate.testnet",
                      method_names: [...GAMEPLAY_METHODS],
                      allowance: (GAMEPLAY_KEY_ALLOWANCE / 2n).toString(),
                    },
                  },
                },
              },
            ],
          }),
        },
        selector,
      },
    ) as GameWalletClient;
    assert.equal(await reopenedTab.resumePendingKey(), "ready");
    assert.equal(values.has(`${keyName}:pending`), false);
    assert.equal(
      JSON.parse(values.get(keyName) ?? "null").publicKey,
      pending.publicKey,
    );
  } finally {
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("parking agent key gets only parking methods and can be revoked", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
  const pair = KeyPair.fromRandom("ed25519");
  let addCount = 0;
  let onChain: {
    public_key: string;
    access_key: {
      permission: {
        FunctionCall: {
          receiver_id: string;
          method_names: string[];
          allowance: string;
        };
      };
    };
  } | null = null;
  const selector = {
    store: {
      getState: () => ({
        contract: { contractId: "estate.testnet" },
        accounts: [{ accountId: "driver.testnet", active: true }],
      }),
    },
    wallet: async () => ({
      signAndSendTransaction: async ({ actions }: { actions: any[] }) => {
        const action = actions[0];
        if (action.enum === "addKey") {
          addCount++;
          const permission = action.addKey.accessKey.permission.functionCall;
          assert.deepEqual(permission.methodNames, [...PARKING_AGENT_METHODS]);
          assert.equal(permission.receiverId, "estate.testnet");
          assert.equal(permission.allowance, PARKING_AGENT_KEY_ALLOWANCE);
          onChain = {
            public_key: pair.getPublicKey().toString(),
            access_key: {
              permission: {
                FunctionCall: {
                  receiver_id: permission.receiverId,
                  method_names: permission.methodNames,
                  allowance: permission.allowance.toString(),
                },
              },
            },
          };
        } else if (action.enum === "deleteKey") {
          assert.equal(
            action.deleteKey.publicKey.toString(),
            pair.getPublicKey().toString(),
          );
          onChain = null;
        } else {
          assert.fail(`Unexpected wallet action ${action.enum}`);
        }
      },
    }),
  };
  const client = Object.assign(Object.create(GameWalletClient.prototype), {
    reader: {
      contractId: "estate.testnet",
      accessKeyList: async () => ({ keys: onChain ? [onChain] : [] }),
    },
    selector,
  }) as GameWalletClient;
  try {
    assert.equal((await client.parkingAgentKeyStatus()).state, "none");
    assert.equal(
      (await client.addParkingAgentKey(pair.getPublicKey().toString())).state,
      "ready",
    );
    values.delete(
      "near-estate:testnet:estate.testnet:driver.testnet:parking-agent-key",
    );
    assert.equal((await client.parkingAgentKeyStatus()).state, "none");
    assert.equal(
      (await client.addParkingAgentKey(pair.getPublicKey().toString())).state,
      "ready",
    );
    assert.equal(addCount, 1);
    assert.equal((await client.revokeParkingAgentKey()).state, "none");
  } finally {
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
