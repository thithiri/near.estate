import { expect, test } from "@playwright/test";

test("phone map shows a clear location and all city destinations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator('[data-screen="Map"]:visible').first().click();

  await expect(page.getByRole("heading", { name: "City map" })).toBeVisible();
  await expect(page.locator(".map-position-label")).toHaveText("YOU");
  await expect(page.locator("button[data-road]")).toHaveCount(5);
  await expect(page.locator("[data-map-tower]")).toHaveCount(3);
  await expect(page.locator("[data-map-site]")).toHaveCount(4);
  await expect(page.locator("button[data-tower]")).toHaveCount(3);
  await expect(page.locator("button[data-site]")).toHaveCount(4);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 320, height: 568 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);

  const mainLabel = await page
    .locator(".map-road-label")
    .filter({ hasText: "Main Street" })
    .boundingBox();
  const mainTower = await page
    .locator('[data-map-tower="npc-main-tower"]')
    .boundingBox();
  expect(mainLabel).not.toBeNull();
  expect(mainTower).not.toBeNull();
  expect(mainLabel!.x + mainLabel!.width < mainTower!.x).toBe(true);
});

test("map road and tower pins travel to their destinations", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('[data-screen="Map"]:visible').first().click();
  await page.locator('[data-map-road="market"]').click();
  await expect(page.locator("#mobile-street-name")).toContainText(
    "Market Street",
  );

  await page.locator('[data-screen="Map"]:visible').first().click();
  await page.locator('[data-map-road="river"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#mobile-street-name")).toContainText(
    "River Street",
  );

  await page.locator('[data-screen="Map"]:visible').first().click();
  await page.locator('[data-map-tower="npc-main-tower"]').click();
  await expect(page.locator("#mobile-street-name")).toContainText(
    "Main Street",
  );
  await expect(page.locator("#street-screen")).toBeVisible();

  await page.locator('[data-screen="Map"]:visible').first().click();
  await page.locator('[data-map-site="npc-harbor-cinema"]').click();
  await expect(
    page.getByRole("heading", { name: "Harbor Cinema" }),
  ).toBeVisible();
});

test("parked car remains marked while other roads become view choices", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#action").click();
  await page.locator('[data-screen="Map"]:visible').first().click();

  await expect(page.locator(".map-position-label")).toHaveText("PARKED");
  await expect(page.locator('button[data-road="main"]')).toContainText(
    "Car parked here",
  );
  await expect(page.locator('button[data-road="market"]')).toContainText(
    "View street",
  );
});
