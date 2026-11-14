import { expect, test } from "@playwright/test";

test("public testnet city and advertiser stats load together", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Wallet and agents" }).click();
  await expect(page.getByRole("heading", { name: "Live city" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Near Garden · Plot 4" }),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await page.locator("#map-stats").click();
  const statsResponse = page.waitForResponse((response) =>
    response.url().includes("/api/stats/plots/plot-main-n-3"),
  );
  await page.locator("#stats-plot").selectOption("plot-main-n-3");
  const response = await statsResponse;
  expect(response.ok()).toBe(true);
  const stats = await response.json();
  expect(stats.plotId).toBe("plot-main-n-3");
  expect(stats.linkedHistory?.sourcePlotId).toBe("plot-main-n-2");
  expect(stats.freshness.indexedThroughHeight).toBeGreaterThan(0);
  if (process.env.ESTATE_BROWSER_SNAPSHOT !== "1")
    expect(stats.freshness.indexedThroughAt).toBeGreaterThan(
      Date.now() - 600_000,
    );
  await expect(page.locator(".owner-stats-grid")).toBeVisible();
  await expect(
    page.locator(".owner-stats-grid > div").nth(2).locator("strong"),
  ).toHaveText(String(stats.totals.parks));
  await expect(
    page.locator(".owner-stats-grid > div").nth(3).locator("strong"),
  ).toHaveText(String(stats.totals.tickets));
});

test("wallet chooser offers an active wallet", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Wallet and agents" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText("Meteor Wallet", { exact: true })).toBeVisible();
  await expect(page.getByText("MyNearWallet", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Intear Wallet", { exact: true })).toHaveCount(0);
});

test("experimental second wallet rejects a forged connection", async ({
  page,
}) => {
  test.skip(
    process.env.ESTATE_EXPERIMENTAL_INTEAR !== "1",
    "Run a Vite city server with VITE_EXPERIMENTAL_INTEAR=1",
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Wallet and agents" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByText("Intear Wallet", { exact: true }).click();
  const connection = page.frameLocator(
    'iframe[src^="https://wallet.intear.tech/"]',
  );
  await expect(
    connection.getByText("Choose your preferred wallet connection method"),
  ).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() =>
    window.postMessage(
      {
        type: "connected",
        accounts: [
          {
            accountId: "attacker.testnet",
            publicKey: "ed25519:11111111111111111111111111111111",
          },
        ],
        functionCallKeyAdded: true,
        logoutKey: "ed25519:11111111111111111111111111111111",
        useBridge: false,
        walletUrl: "https://wallet.intear.tech",
      },
      "*",
    ),
  );
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("_intear_wallet_connected_account"),
    ),
  ).toBeNull();
  await expect(
    connection.getByText("Choose your preferred wallet connection method"),
  ).toBeVisible();
  const popupPromise = page.context().waitForEvent("page");
  await connection.getByText("Web", { exact: true }).click();
  const popup = await popupPromise;
  await expect
    .poll(() => new URL(popup.url()).origin)
    .toBe("https://wallet.intear.tech");
});
