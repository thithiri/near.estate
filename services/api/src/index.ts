import { join } from "node:path";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApiApp } from "./app.js";
import { NearChainGateway } from "./chain.js";
import { NearModeratorGateway } from "./moderator.js";
import { ApiStore } from "./store.js";
import {
  readImageGenerationSettings,
  requirePaidModeration,
} from "./image-generation-settings.js";
import { OpenAiImageProvider } from "./image-provider.js";
import { PaidGenerationLedger } from "./paid-generation-ledger.js";
import { PaidImageWorker } from "./paid-image-worker.js";
import { AssetRetentionWorker } from "./asset-retention.js";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:8080";
const imageGenerationSettings = readImageGenerationSettings(process.env);
const dataDir = process.env.API_DATA_DIR ?? join(process.cwd(), "data");
const store = new ApiStore(
  join(dataDir, "estate.sqlite"),
  join(dataDir, "assets"),
);
const contractId = process.env.ESTATE_CONTRACT_ID?.trim();
const chain = contractId
  ? new NearChainGateway(contractId, process.env.NEAR_RPC_URL)
  : null;
if (imageGenerationSettings.enabled && !chain)
  throw new Error("Paid image generation requires ESTATE_CONTRACT_ID");
const paidLedger = imageGenerationSettings.enabled
  ? new PaidGenerationLedger(store.db, imageGenerationSettings)
  : null;
const paidProvider = imageGenerationSettings.enabled
  ? new OpenAiImageProvider(imageGenerationSettings.provider)
  : null;
const moderatorAccountId = process.env.MODERATOR_ACCOUNT_ID?.trim();
const moderatorKeyFile = process.env.MODERATOR_KEY_FILE?.trim();
const adminUser = process.env.MODERATION_USER?.trim();
const adminPassword = process.env.MODERATION_PASSWORD;
const anyModerationSetting = Boolean(
  moderatorAccountId || moderatorKeyFile || adminUser || adminPassword,
);
if (
  anyModerationSetting &&
  (!contractId ||
    !moderatorAccountId ||
    !moderatorKeyFile ||
    !adminUser ||
    !adminPassword)
)
  throw new Error(
    "Moderation needs contract, account, key file, user and password",
  );
let moderator: NearModeratorGateway | null = null;
if (contractId && moderatorAccountId && moderatorKeyFile) {
  const credentials = JSON.parse(readFileSync(moderatorKeyFile, "utf8")) as {
    account_id?: string;
    private_key?: string;
    secret_key?: string;
  };
  if (credentials.account_id !== moderatorAccountId)
    throw new Error(
      "Moderator key account does not match MODERATOR_ACCOUNT_ID",
    );
  const secretKey = credentials.private_key ?? credentials.secret_key;
  if (!secretKey) throw new Error("Moderator key file lacks a private key");
  moderator = new NearModeratorGateway(
    contractId,
    moderatorAccountId,
    secretKey,
    process.env.NEAR_RPC_URL,
  );
}
requirePaidModeration(
  imageGenerationSettings,
  Boolean(moderator),
  Boolean(adminUser && adminPassword),
);
const app = createApiApp({
  store,
  chain,
  appOrigin,
  moderator,
  adminCredentials:
    adminUser && adminPassword
      ? { user: adminUser, password: adminPassword }
      : null,
  paidLedger,
});
const paidWorker =
  paidLedger && paidProvider && chain
    ? new PaidImageWorker({
        ledger: paidLedger,
        store,
        chain,
        provider: paidProvider,
        assetDir: store.assetDir,
      })
    : null;
const server = serve({ fetch: app.fetch, port });
paidWorker?.start();
const assetRetentionWorker = new AssetRetentionWorker(store, chain);
assetRetentionWorker.start();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void Promise.allSettled([
      paidWorker?.stop(),
      assetRetentionWorker.stop(),
    ]).then(() => store.close());
  });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
