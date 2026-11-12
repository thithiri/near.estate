import { expect, test } from "@playwright/test";

test("crossing shows a short transition at the same street position", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?preview-plot=plot-main-n-0");
  const plotBefore = await page.locator("#plot-title").textContent();
  expect(plotBefore).toContain("Plot 1");
  await page.locator('.topbar [data-screen="Map"]').click();
  const xBefore = Number(
    await page.locator(".map-position").getAttribute("cx"),
  );
  const yBefore = Number(
    await page.locator(".map-position").getAttribute("cy"),
  );
  await page.locator('.topbar [data-screen="Street"]').click();
  await expect(page.locator("#street-side")).toHaveText("North curb");
  await page.locator("#cross-side").click();
  await expect(page.locator("#cross-side")).toBeDisabled();
  await expect(page.locator("#status")).toContainText(
    "Crossing to the south curb",
  );
  await expect(page.locator("#street-side")).toHaveText("South curb");
  await expect(page.locator("#cross-side")).toBeEnabled();
  await expect(page.locator("#status")).toContainText(
    "Now on the south curb · directly across",
  );
  const plotAfter = await page.locator("#plot-title").textContent();
  expect(plotAfter).toContain("Plot 2");
  expect(plotAfter).not.toBe(plotBefore);
  await page.locator('.topbar [data-screen="Map"]').click();
  expect(Number(await page.locator(".map-position").getAttribute("cx"))).toBe(
    xBefore,
  );
  expect(Number(await page.locator(".map-position").getAttribute("cy"))).toBe(
    yBefore + 20,
  );
});

test("reduced motion switches curbs without animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?preview-plot=plot-central-n-3");
  await expect(page.locator("#street-side")).toHaveText("West curb");
  await page.locator("#cross-side").click();
  await expect(page.locator("#street-side")).toHaveText("East curb");
  await expect(page.locator("#cross-side")).toBeEnabled();
  await expect(page.locator("#status")).toContainText(
    "Now on the east curb · directly across",
  );
});

test("a parked car stays put while viewing the opposite curb", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#action").click();
  await expect(page.locator("#cross-side")).toHaveText("View other curb");
  await expect(page.locator("#street-side")).toHaveText("North curb");
  await page.locator("#cross-side").click();
  await expect(page.locator("#street-side")).toHaveText("South curb");
  await expect(page.locator("#cross-side")).toBeEnabled();
  await expect(page.locator("#status")).toContainText("car still parked");
  await expect(page.locator("#collect")).toBeVisible();
});
