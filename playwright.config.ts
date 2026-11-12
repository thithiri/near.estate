import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";

const localURL = process.env.ESTATE_BROWSER_LOCAL_URL;
const cityFixture = process.env.ESTATE_BROWSER_CITY_FIXTURE === "1";
if (localURL && cityFixture)
  throw new Error("Choose a local URL or the managed city fixture, not both");
if (localURL) {
  const parsed = new URL(localURL);
  if (
    parsed.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  )
    throw new Error("Local browser tests require a loopback HTTP URL");
}
const baseURL =
  localURL ?? (cityFixture ? "http://127.0.0.1:5188" : "http://127.0.0.1:5187");
const cityContractId = cityFixture
  ? (
      JSON.parse(
        readFileSync(
          new URL("./deployments/testnet.json", import.meta.url),
          "utf8",
        ),
      ) as { contractId?: string }
    ).contractId
  : "";
if (cityFixture && !/^[a-z0-9.-]+\.testnet$/.test(cityContractId ?? ""))
  throw new Error(
    "City fixture requires a testnet contract ID in deployments/testnet.json",
  );

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
        command: `npm run build -w @estate/shared && npm run dev -w @estate/web -- --host 127.0.0.1 --port ${cityFixture ? 5188 : 5187} --strictPort`,
        env: { VITE_ESTATE_CONTRACT_ID: cityContractId },
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
