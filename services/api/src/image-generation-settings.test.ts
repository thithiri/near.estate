import assert from "node:assert/strict";
import test from "node:test";
import {
  readImageGenerationSettings,
  requirePaidModeration,
} from "./image-generation-settings.js";

const enabledEnv = {
  IMAGE_GENERATION_ENABLED: "true",
  IMAGE_GENERATION_INVITES: "owner.testnet,other.testnet",
  IMAGE_GENERATION_DAILY_BUDGET_USD_MICROS: "10000000",
  IMAGE_GENERATION_MAX_COST_PER_CALL_USD_MICROS: "1000000",
  IMAGE_GENERATION_TIMEOUT_MS: "120000",
  IMAGE_GENERATION_SAFETY_SECRET: "test-secret-with-at-least-thirty-two-bytes",
  OPENAI_API_KEY: "test-api-key",
  OPENAI_IMAGE_MODEL: "gpt-image-2.5-flare-2026-09-08",
};

test("paid generation is off unless explicitly enabled", () => {
  assert.deepEqual(readImageGenerationSettings({}), { enabled: false });
  assert.deepEqual(
    readImageGenerationSettings({ IMAGE_GENERATION_ENABLED: "false" }),
    { enabled: false },
  );
});

test("paid generation requires invites, credentials and a four-call reserve", () => {
  const settings = readImageGenerationSettings(enabledEnv);
  assert.equal(settings.enabled, true);
  if (!settings.enabled) return;
  assert.equal(settings.invites.has("owner.testnet"), true);
  assert.equal(settings.maxCallsPerDay, 6);
  const verified = readImageGenerationSettings({
    ...enabledEnv,
    IMAGE_GENERATION_SPIKE_VERIFIED: "true",
  });
  assert.equal(verified.enabled, true);
  if (verified.enabled) assert.equal(verified.maxCallsPerDay, 60);
  assert.equal(settings.maxAttemptsPerBatch, 4);
  assert.equal(settings.maxConcurrentCalls, 2);
  assert.throws(() =>
    readImageGenerationSettings({
      ...enabledEnv,
      IMAGE_GENERATION_INVITES: "",
    }),
  );
  assert.throws(() =>
    readImageGenerationSettings({
      ...enabledEnv,
      IMAGE_GENERATION_DAILY_BUDGET_USD_MICROS: "3999999",
    }),
  );
  assert.throws(() =>
    readImageGenerationSettings({ ...enabledEnv, OPENAI_API_KEY: "" }),
  );
  assert.throws(() =>
    readImageGenerationSettings({
      ...enabledEnv,
      IMAGE_GENERATION_ENABLED: "yes",
    }),
  );
});

test("paid generation cannot start without a working review path", () => {
  const enabled = readImageGenerationSettings(enabledEnv);
  assert.throws(() => requirePaidModeration(enabled, false, true));
  assert.throws(() => requirePaidModeration(enabled, true, false));
  assert.doesNotThrow(() => requirePaidModeration(enabled, true, true));
  assert.doesNotThrow(() =>
    requirePaidModeration({ enabled: false }, false, false),
  );
});
