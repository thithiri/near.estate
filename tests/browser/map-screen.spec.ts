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
  await expect(page.locator("[data-map-site]")).toHaveCount(5);
  await expect(page.locator("button[data-tower]")).toHaveCount(3);
  await expect(page.locator("button[data-site]")).toHaveCount(5);
  await expect(
    page.getByRole("region", { name: "Today's trip" }),
  ).toBeVisible();
  await expect(page.locator(".map-trip-stop")).toHaveCount(2);
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

test("trip card routes the player toward a nearby curb", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-screen="Map"]:visible').first().click();
  await page.locator(".map-trip-stop button").first().click();
  await expect(page.locator("#street-screen")).toBeVisible();
  await expect(page.locator("#other-screen")).toBeHidden();
  await expect(page.locator("#trip-street-card")).toContainText("TRIP");
});

test("parking near a trip stop stamps the visit without awarding coins", async ({
  page,
}) => {
  // Keep this one-click activity journey on the burger stop as daily routes rotate.
  await page.clock.setFixedTime(new Date("2026-11-16T12:00:00Z"));
  await page.goto("/");
  await page.locator('[data-screen="Map"]:visible').first().click();
  await page.locator(".map-trip-stop button").first().click();
  await page.locator("#action").click();
  const balanceAfterParking = await page.locator("#balance").textContent();
  await page.locator('[data-screen="Map"]:visible').first().click();
  await expect(page.locator(".map-trip-stop").first()).toContainText(
    "Parked nearby",
  );
  await page.locator(".map-trip-stop button").first().click();
  await expect(page.locator(".destination-trip-status")).toContainText(
    "finish an activity",
  );
  await page
    .locator(
      "#destination-burger, #cinema-play, #practice-start, #horse-race-watch, #destination-cars",
    )
    .first()
    .click();
  await page.locator('[data-screen="Map"]:visible').first().click();
  await expect(page.locator(".map-trip-progress")).toHaveText("0/2 complete");
  await expect(page.locator("#balance")).toHaveText(balanceAfterParking ?? "");
  await expect(page.locator(".map-trip-stop").first()).toContainText(
    "collect your car",
  );
  await page.locator(".map-trip-stop button").first().click();
  await expect(page.locator("#trip-street-card")).toContainText(
    "collect your car",
  );
  await page.locator("#trip-street-card").click();
  await page.locator('[data-screen="Map"]:visible').first().click();
  await expect(page.locator(".map-trip-progress")).toHaveText("1/2 complete");
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
