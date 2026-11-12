import assert from "node:assert/strict";
import test from "node:test";
import { ImpressionReporter, VisibilityRecorder } from "./impressions.js";

test("a full continuous second is required before an impression segment", () => {
  const recorder = new VisibilityRecorder();
  const logo = [{ plotId: "plot-main-n-0", surface: "Logo" as const }];
  assert.deepEqual(recorder.observe(1_000, logo), []);
  assert.deepEqual(recorder.drain(1_999), []);
  const first = recorder.drain(2_100);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.msVisible, 1_100);
  assert.equal(first[0]?.surface, "Logo");
  const tail = recorder.observe(2_350, []);
  assert.equal(tail.length, 1);
  assert.equal(tail[0]?.msVisible, 250);
  assert.deepEqual(recorder.drain(3_000), []);
  recorder.observe(3_000, logo);
  assert.deepEqual(recorder.observe(3_900, []), []);
});

test("a failed batch retries with the same event ID", async () => {
  const savedFetch = globalThis.fetch;
  const savedNow = Date.now;
  const savedStorage = Object.getOwnPropertyDescriptor(
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
    },
  });
  let now = 1_800_000_000;
  Date.now = () => now;
  const sent: string[] = [];
  let fail = true;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/session")) {
      assert.equal(init?.method, "POST");
      return new Response("{}", { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as {
      events: Array<{ eventId: string }>;
    };
    sent.push(body.events[0]!.eventId);
    if (fail) throw new Error("Network dropped the response");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const reporter = new ImpressionReporter();
    reporter.observe([{ plotId: "plot-main-n-0", surface: "Logo" }]);
    now += 1_100;
    reporter.pause();
    await reporter.flush();
    assert.equal(sent.length, 1);
    assert.ok(
      (values.get("near-estate-impression-queue-v1") ?? "").includes(sent[0]!),
    );
    fail = false;
    await reporter.flush();
    assert.deepEqual(sent, [sent[0], sent[0]]);
    assert.equal(values.get("near-estate-impression-queue-v1"), "[]");
  } finally {
    globalThis.fetch = savedFetch;
    Date.now = savedNow;
    if (savedStorage)
      Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("paused impression intake clears queued views before reopening", async () => {
  const savedFetch = globalThis.fetch;
  const savedNow = Date.now;
  const savedStorage = Object.getOwnPropertyDescriptor(
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
    },
  });
  let now = 1_800_000_000;
  Date.now = () => now;
  let paused = true;
  let sent = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/session"))
      return paused
        ? new Response(JSON.stringify({ code: "IMPRESSION_INTAKE_PAUSED" }), {
            status: 503,
          })
        : new Response("{}", { status: 200 });
    sent++;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const reporter = new ImpressionReporter();
    reporter.observe([{ plotId: "plot-main-n-0", surface: "Logo" }]);
    now += 1_100;
    reporter.pause();
    await reporter.flush();
    assert.equal(values.get("near-estate-impression-queue-v1"), "[]");
    assert.equal(sent, 0);

    paused = false;
    now += 1_000;
    reporter.observe([{ plotId: "plot-main-n-0", surface: "Logo" }]);
    now += 1_100;
    reporter.pause();
    await reporter.flush();
    assert.equal(sent, 1);
    assert.equal(values.get("near-estate-impression-queue-v1"), "[]");
  } finally {
    globalThis.fetch = savedFetch;
    Date.now = savedNow;
    if (savedStorage)
      Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("cutover rejection drops old views but sends newer queued views", async () => {
  const savedFetch = globalThis.fetch;
  const savedNow = Date.now;
  const savedStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const oldId = "11111111-1111-4111-8111-111111111111";
  const newId = "22222222-2222-4222-8222-222222222222";
  const queueKey = "near-estate-impression-queue-v1";
  const values = new Map([
    [
      queueKey,
      JSON.stringify(
        [
          { eventId: oldId, observedAt: 1_800_001_500 },
          { eventId: newId, observedAt: 1_800_003_000 },
        ].map((event) => ({
          ...event,
          plotId: "plot-main-n-0",
          surface: "Logo",
          msVisible: 1_100,
        })),
      ),
    ],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  });
  Date.now = () => 1_800_003_000;
  const sent: string[][] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/session"))
      return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init?.body)) as {
      events: Array<{ eventId: string }>;
    };
    sent.push(body.events.map((event) => event.eventId));
    return sent.length === 1
      ? new Response(
          JSON.stringify({
            code: "IMPRESSION_BEFORE_CUTOVER",
            acceptAfterMs: 1_800_001_000,
          }),
          { status: 409 },
        )
      : new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const reporter = new ImpressionReporter();
    await reporter.flush();
    assert.deepEqual(sent, [[oldId, newId], [newId]]);
    assert.equal(values.get(queueKey), "[]");
  } finally {
    globalThis.fetch = savedFetch;
    Date.now = savedNow;
    if (savedStorage)
      Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
