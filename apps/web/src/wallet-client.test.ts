import assert from "node:assert/strict";
import test from "node:test";
import {
  GAMEPLAY_KEY_ALLOWANCE,
  GAMEPLAY_METHODS,
  GameWalletClient,
  type GameplayKeyStatus,
} from "./wallet-client.js";

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
        reader: { contractId: "estate.testnet" },
        selector,
        provider: {
          viewAccessKeyList: async () => ({
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
