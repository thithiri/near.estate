import { expect, test } from "@playwright/test";

test("public testnet city and advertiser stats load together", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open live testnet city" }).click();
  await expect(page.getByRole("heading", { name: "Live city" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Near Garden · Plot 3" }),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await page.locator("#map-stats").click();
  const statsResponse = page.waitForResponse((response) =>
    response.url().includes("/api/stats/plots/plot-main-n-2"),
  );
  await page.locator("#stats-plot").selectOption("plot-main-n-2");
  const response = await statsResponse;
  expect(response.ok()).toBe(true);
  const stats = await response.json();
  expect(stats.plotId).toBe("plot-main-n-2");
  expect(stats.freshness.indexedThroughHeight).toBeGreaterThan(0);
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
  await page.getByRole("button", { name: "Open live testnet city" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText("Meteor Wallet", { exact: true })).toBeVisible();
  await expect(page.getByText("MyNearWallet", { exact: true })).toHaveCount(0);
});
