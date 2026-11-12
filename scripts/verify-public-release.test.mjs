import assert from "node:assert/strict";
import test from "node:test";
import { baseEncode } from "@near-js/utils";
import { verifyPublicRelease } from "./verify-public-release.mjs";

const origin = "https://game.example.com";
const contractId = "dev-20261110121817-59798568433631.testnet";
const sourceRevision = "a".repeat(40);
const nowMs = Date.parse("2026-11-13T05:00:00Z");
const codeSha256 =
  "ad148df441a41d1f7263974fb1db6821b70b7754a3a46c8c594b759e0822b887";
const blockHash = "final-block";

function responses(changes = {}) {
  const bodies = {
    "/api/health": {
      status: "ok",
      service: "api",
      schemaVersion: 1,
      contractId,
      sourceRevision,
    },
    "/api/city": {
      version: 2,
      streets: Array(5).fill({}),
      plots: Array(100).fill({}),
      npcSites: Array(7).fill({}),
    },
    "/api/stats/economy": {
      indexedThroughHeight: 277418599,
      indexedThroughAt: nowMs - 60_000,
    },
    "/api/paid-generations/status": { enabled: false },
    ...changes,
  };
  const fetcher = async (input, options) => {
    assert.equal(options.redirect, "error");
    if (new URL(input).hostname === "test.rpc.fastnear.com") {
      const request = JSON.parse(options.body);
      assert.equal(request.method, "query");
      assert.equal(request.params.account_id, contractId);
      if (request.params.request_type === "view_account") {
        assert.equal(request.params.finality, "final");
        return Response.json({
          result: {
            block_hash: blockHash,
            block_height: 277420636,
            code_hash: baseEncode(
              Buffer.from(changes.liveCodeSha256 ?? codeSha256, "hex"),
            ),
          },
        });
      }
      assert.equal(request.params.request_type, "call_function");
      assert.equal(request.params.block_id, blockHash);
      assert.equal(request.params.method_name, "is_paused");
      return Response.json({
        result: {
          block_hash: changes.pauseBlockHash ?? blockHash,
          result: [...Buffer.from(JSON.stringify(changes.paused ?? false))],
        },
      });
    }
    const path = new URL(input).pathname;
    if (path === "/")
      return new Response(
        `<html><meta name="estate-contract-id" content="${changes.webContractId ?? contractId}" /><meta
          name="estate-source-revision"
          content="${changes.webSourceRevision ?? sourceRevision}"
        /></html>`,
        {
          headers: {
            "content-type": "text/html",
            "content-security-policy":
              "object-src 'none'; frame-ancestors 'none'",
            "x-content-type-options": "nosniff",
          },
        },
      );
    return Response.json(bodies[path]);
  };
  return fetcher;
}

test("public release probe accepts a fresh curated city over strict HTTPS", async () => {
  const result = await verifyPublicRelease(origin, {
    fetcher: responses(),
    nowMs,
    sourceRevision,
  });
  assert.equal(result.contractId, contractId);
  assert.equal(result.indexerAgeSeconds, 60);
  assert.equal(result.imageGenerationEnabled, false);
  assert.equal(result.codeSha256, codeSha256);
  assert.equal(result.paused, false);
  assert.equal(result.finalizedBlockHeight, 277420636);
});

test("public release probe rejects the wrong release, stale indexing and paid art", async () => {
  const options = { nowMs, sourceRevision };
  await assert.rejects(
    verifyPublicRelease(origin, {
      ...options,
      fetcher: responses({ webContractId: "other.testnet" }),
    }),
    /web bundle.*wrong contract/,
  );
  await assert.rejects(
    verifyPublicRelease(origin, {
      ...options,
      fetcher: responses({ webSourceRevision: "b".repeat(40) }),
    }),
    /web bundle.*wrong source revision/,
  );
  await assert.rejects(
    verifyPublicRelease(origin, {
      ...options,
      fetcher: responses({
        "/api/health": {
          status: "ok",
          service: "api",
          schemaVersion: 1,
          contractId: "other.testnet",
          sourceRevision,
        },
      }),
    }),
    /wrong contract/,
  );
  await assert.rejects(
    verifyPublicRelease(origin, {
      ...options,
      fetcher: responses({
        "/api/stats/economy": {
          indexedThroughHeight: 1,
          indexedThroughAt: nowMs - 901_000,
        },
      }),
    }),
    /stale/,
  );
  await assert.rejects(
    verifyPublicRelease(origin, {
      ...options,
      fetcher: responses({ "/api/paid-generations/status": { enabled: true } }),
    }),
    /enabled/,
  );
  await assert.rejects(
    verifyPublicRelease(origin, {
      ...options,
      fetcher: responses({ liveCodeSha256: "0".repeat(64) }),
    }),
    /Live contract code differs/,
  );
  await assert.rejects(
    verifyPublicRelease(origin, {
      ...options,
      fetcher: responses({ paused: true }),
    }),
    /Live contract is paused/,
  );
  await assert.rejects(
    verifyPublicRelease(origin, {
      ...options,
      fetcher: responses({ pauseBlockHash: "different-block" }),
    }),
    /did not match the finalized block/,
  );
});

test("public release probe refuses non-public or insecure origins", async () => {
  await assert.rejects(verifyPublicRelease("http://game.example.com"), /HTTPS/);
  await assert.rejects(
    verifyPublicRelease("https://localhost"),
    /public hostname/,
  );
  await assert.rejects(
    verifyPublicRelease("https://127.0.0.1"),
    /public hostname/,
  );
  await assert.rejects(
    verifyPublicRelease("https://game.example.com:8443"),
    /HTTPS origin/,
  );
});
