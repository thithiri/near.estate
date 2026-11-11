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
  type GameplayKeyStatus,
} from "./wallet-client.js";

test("Meteor wallet browser module and its SDK import cleanly", async () => {
  const [wallet] = await Promise.all([
    import("@near-wallet-selector/meteor-wallet"),
    import("@meteorwallet/sdk"),
  ]);
  assert.equal(typeof wallet.setupMeteorWallet, "function");
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
