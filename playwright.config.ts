import { defineConfig } from "@playwright/test";

const localURL = process.env.ESTATE_BROWSER_LOCAL_URL;
if (localURL) {
  const parsed = new URL(localURL);
  if (
    parsed.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  )
    throw new Error("Local browser tests require a loopback HTTP URL");
}
const baseURL = localURL ?? "http://127.0.0.1:5187";

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
  webServer: localURL
    ? undefined
    : {
        command:
          "npm run build -w @estate/shared && VITE_ESTATE_CONTRACT_ID= npm run dev -w @estate/web -- --host 127.0.0.1 --port 5187 --strictPort",
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
