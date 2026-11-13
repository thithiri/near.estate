import assert from "node:assert/strict";
import test from "node:test";
import { PlaytestRecorder } from "./playtest-log.js";

test("playtest events stay local until opt-in and export has no account or location", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  let now = new Date("2026-11-13T10:00:00Z");
  const recorder = new PlaytestRecorder(storage, () => now);
  recorder.record("park_legal");
  assert.equal(recorder.read(), null);
  recorder.setEnabled(true);
  now = new Date("2026-11-13T10:02:00Z");
  recorder.record("park_legal");
  now = new Date("2026-11-13T10:05:00Z");
  recorder.record("collect");
  assert.deepEqual(recorder.export(), {
    schema: 1,
    source: "guest",
    events: [
      { name: "park_legal", minute: 2, day: 0 },
      { name: "collect", minute: 5, day: 0 },
    ],
  });
  recorder.setEnabled(false);
  recorder.record("repair");
  assert.equal(recorder.export().events.length, 2);
  recorder.clear();
  assert.equal(recorder.read(), null);
});

test("a return on another UTC day is counted once", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  let now = new Date("2026-11-13T10:00:00Z");
  const recorder = new PlaytestRecorder(storage, () => now);
  recorder.setEnabled(true);
  now = new Date("2026-11-14T10:00:00Z");
  recorder.noteVisit();
  recorder.noteVisit();
  assert.deepEqual(recorder.export().events, [
    { name: "return_day", minute: 1440, day: 1 },
  ]);
});

test("a session left open records the return before its next action", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  let now = new Date("2026-11-13T23:59:00Z");
  const recorder = new PlaytestRecorder(storage, () => now);
  recorder.setEnabled(true);
  now = new Date("2026-11-14T00:01:00Z");
  recorder.record("park_legal");
  assert.deepEqual(recorder.export().events, [
    { name: "return_day", minute: 2, day: 0 },
    { name: "park_legal", minute: 2, day: 0 },
  ]);
});
