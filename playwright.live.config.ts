import { defineConfig } from "@playwright/test";

const baseURL = process.env.ESTATE_BROWSER_LIVE_URL;
if (!baseURL)
  throw new Error(
    "Set ESTATE_BROWSER_LIVE_URL to the running Live city URL before testing",
  );

export default defineConfig({
  testDir: "./tests/browser-live",
  workers: 1,
  timeout: 45_000,
  reporter: "list",
  outputDir: "test-results/live",
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 844, height: 390 },
    trace: "retain-on-failure",
  },
});
