import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApiApp } from "./app.js";
import type { ChainGateway } from "./chain.js";
import { ApiStore } from "./store.js";

const ORIGIN = "http://localhost:8080";
const PLOT = "plot-main-n-0";

test("anonymous session records only approved surfaces and accepts a retry once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-impression-route-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  let calls = 0;
  const chain = {
    plot: async () => {
      calls++;
      return { logo_eligible: true, billboard_eligible: false };
    },
  } as unknown as ChainGateway;
  const now = 1_800_000;
  const app = createApiApp({
    store,
    chain,
    appOrigin: ORIGIN,
    clock: () => now,
  });
  try {
    const session = await app.request(`${ORIGIN}/impressions/session`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    assert.equal(session.status, 200);
    assert.equal(
      (await app.request(`${ORIGIN}/impressions/session`)).status,
      404,
    );
    const crossOrigin = await app.request(`${ORIGIN}/impressions/session`, {
      method: "POST",
      headers: { origin: "https://other.example" },
    });
    assert.equal(crossOrigin.status, 403);
    const cookie = session.headers.get("set-cookie")?.split(";")[0];
    if (!cookie?.startsWith("estate_impression="))
      throw new Error("Impression session cookie missing");
    const event = {
      eventId: randomUUID(),
      plotId: PLOT,
      surface: "Logo",
      observedAt: now * 1_000 - 2_000,
      msVisible: 1_200,
    };
    const request = (events: unknown[]) =>
      app.request(`${ORIGIN}/impressions`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ events }),
      });
    const first = await request([event]);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      stored: 1,
      duplicates: 0,
      impressions: 1,
      dwellMs: 1_200,
    });
    const retry = await request([event]);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).duplicates, 1);
    assert.equal(calls, 1, "a retry should not reread current ad approval");
    const wrongSurface = await request([
      { ...event, eventId: randomUUID(), surface: "Billboard" },
    ]);
    assert.equal(wrongSurface.status, 403);
    assert.equal((await wrongSurface.json()).code, "NO_APPROVED_AD");
    const beforeStale = calls;
    const stale = await request([
      {
        ...event,
        eventId: randomUUID(),
        observedAt: now * 1_000 - 301_000,
      },
    ]);
    assert.equal(stale.status, 400);
    assert.equal(
      calls,
      beforeStale,
      "stale data should fail before a chain read",
    );
    const daily = store.db
      .prepare(
        "SELECT impressions, dwell_ms FROM impression_daily_stats WHERE plot_id = ?",
      )
      .get(PLOT) as { impressions: number; dwell_ms: number };
    assert.equal(daily.impressions, 1);
    assert.equal(daily.dwell_ms, 1_200);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("anonymous session issuance is bounded across fresh browsers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "estate-impression-rate-"));
  const store = new ApiStore(":memory:", join(dir, "assets"));
  let now = 1_800_000;
  const app = createApiApp({
    store,
    chain: null,
    appOrigin: ORIGIN,
    clock: () => now,
  });
  try {
    const sessionRequest = (cookie?: string) =>
      app.request(`${ORIGIN}/impressions/session`, {
        method: "POST",
        headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      });
    let firstCookie = "";
    for (let index = 0; index < 600; index++) {
      const response = await sessionRequest();
      assert.equal(response.status, 200, `session ${index}`);
      if (index === 0)
        firstCookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    }
    assert.equal((await sessionRequest()).status, 429);
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM impression_sessions")
          .get() as { count: number }
      ).count,
      600,
    );
    assert.equal(
      (await sessionRequest(firstCookie)).status,
      200,
      "an existing session remains usable at the issuance limit",
    );
    now += 86_400;
    assert.equal((await sessionRequest()).status, 200);
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM impression_sessions")
          .get() as { count: number }
      ).count,
      1,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
