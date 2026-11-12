import assert from "node:assert/strict";
import test from "node:test";
import { verifyPublicRelease } from "./verify-public-release.mjs";

const origin = "https://game.example.com";
const contractId = "dev-20261110121817-59798568433631.testnet";
const sourceRevision = "a".repeat(40);
const nowMs = Date.parse("2026-11-13T05:00:00Z");

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
    const path = new URL(input).pathname;
    if (path === "/")
      return new Response("<html>near.estate</html>", {
        headers: {
          "content-type": "text/html",
          "content-security-policy":
            "object-src 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        },
      });
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
});

test("public release probe rejects the wrong release, stale indexing and paid art", async () => {
  const options = { nowMs, sourceRevision };
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
