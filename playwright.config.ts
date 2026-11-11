import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:5187";

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  outputDir: "test-results",
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 844, height: 390 },
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "npm run build -w @estate/shared && VITE_ESTATE_CONTRACT_ID= npm run dev -w @estate/web -- --host 127.0.0.1 --port 5187 --strictPort",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
