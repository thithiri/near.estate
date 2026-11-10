import type { ImageProviderConfig } from "./image-provider.js";

export type ImageGenerationSettings =
  | { enabled: false }
  | {
      enabled: true;
      provider: ImageProviderConfig;
      invites: ReadonlySet<string>;
      dailyBudgetUsdMicros: number;
      maxCostPerCallUsdMicros: number;
      maxCallsPerDay: number;
      maxAttemptsPerBatch: 4;
      maxConcurrentCalls: 2;
      maxBatchesPerAccountPerDay: 2;
      maxBatchesPerPlotPerDay: 1;
    };

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for paid generation`);
  return value;
}

function positiveSafeInteger(env: NodeJS.ProcessEnv, name: string): number {
  const raw = required(env, name);
  if (!/^[1-9][0-9]*$/.test(raw))
    throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    throw new Error(`${name} exceeds safe integer range`);
  return value;
}

export function readImageGenerationSettings(
  env: NodeJS.ProcessEnv,
): ImageGenerationSettings {
  const switchValue = env.IMAGE_GENERATION_ENABLED?.trim() ?? "false";
  if (switchValue === "false" || switchValue === "") return { enabled: false };
  if (switchValue !== "true")
    throw new Error("IMAGE_GENERATION_ENABLED must be true or false");
  const spikeVerified = env.IMAGE_GENERATION_SPIKE_VERIFIED?.trim() ?? "false";
  if (spikeVerified !== "true" && spikeVerified !== "false")
    throw new Error("IMAGE_GENERATION_SPIKE_VERIFIED must be true or false");
  const invites = new Set(
    required(env, "IMAGE_GENERATION_INVITES")
      .split(",")
      .map((account) => account.trim()),
  );
  if (
    [...invites].some(
      (account) => !/^[a-z0-9._-]{2,64}\.testnet$/.test(account),
    )
  )
    throw new Error(
      "IMAGE_GENERATION_INVITES contains an invalid testnet account",
    );
  const dailyBudgetUsdMicros = positiveSafeInteger(
    env,
    "IMAGE_GENERATION_DAILY_BUDGET_USD_MICROS",
  );
  const maxCostPerCallUsdMicros = positiveSafeInteger(
    env,
    "IMAGE_GENERATION_MAX_COST_PER_CALL_USD_MICROS",
  );
  if (maxCostPerCallUsdMicros > Math.floor(dailyBudgetUsdMicros / 4))
    throw new Error("Daily image budget cannot reserve one four-attempt batch");
  const provider = {
    apiKey: required(env, "OPENAI_API_KEY"),
    model: required(env, "OPENAI_IMAGE_MODEL"),
    timeoutMs: positiveSafeInteger(env, "IMAGE_GENERATION_TIMEOUT_MS"),
    safetySecret: required(env, "IMAGE_GENERATION_SAFETY_SECRET"),
  };
  return {
    enabled: true,
    provider,
    invites,
    dailyBudgetUsdMicros,
    maxCostPerCallUsdMicros,
    maxCallsPerDay: spikeVerified === "true" ? 60 : 6,
    maxAttemptsPerBatch: 4,
    maxConcurrentCalls: 2,
    maxBatchesPerAccountPerDay: 2,
    maxBatchesPerPlotPerDay: 1,
  };
}

export function requirePaidModeration(
  settings: ImageGenerationSettings,
  moderatorReady: boolean,
  reviewCredentialsReady: boolean,
): void {
  if (settings.enabled && (!moderatorReady || !reviewCredentialsReady))
    throw new Error(
      "Paid image generation requires a moderator signer and review credentials",
    );
}
