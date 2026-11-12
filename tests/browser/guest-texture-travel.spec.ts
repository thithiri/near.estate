import { expect, test } from "@playwright/test";

type GuestTextureStats = {
  currentFacades: number;
  cachedImages: number;
  loadedImages: number;
  estimatedDecodedBytes: number;
};

async function textureStats(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const read = (
      window as Window & {
        __nearEstateGuestTextureStats?: () => GuestTextureStats;
      }
    ).__nearEstateGuestTextureStats;
    if (!read) throw new Error("Development texture diagnostics unavailable");
    return read();
  });
}

test("illustrated facades stay bounded while traveling through the city", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  const failedImages: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/guest-buildings/") && !response.ok())
      failedImages.push(`${response.status()} ${response.url()}`);
  });

  await page.goto("/");
  for (const [id, name] of [
    ["main", "Main Street"],
    ["market", "Market Street"],
    ["river", "River Street"],
    ["central", "Central Avenue"],
    ["harbor", "Harbor Avenue"],
    ["main", "Main Street"],
  ] as const) {
    await page.locator('[data-screen="Map"]:visible').first().click();
    await page.locator(`button[data-road="${id}"]`).click();
    await expect(page.locator("#mobile-street-name")).toContainText(name);
    await expect
      .poll(async () => (await textureStats(page)).loadedImages)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await textureStats(page)).cachedImages)
      .toBeLessThanOrEqual(32);
    const stats = await textureStats(page);
    expect(stats.currentFacades).toBe(10);
    expect(stats.estimatedDecodedBytes).toBeGreaterThan(0);
    await page.locator("#cross-side").click();
    await expect
      .poll(async () => (await textureStats(page)).loadedImages)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await textureStats(page)).cachedImages)
      .toBeLessThanOrEqual(32);
    expect((await textureStats(page)).currentFacades).toBe(10);
  }
  expect(failedImages).toEqual([]);
  expect(errors).toEqual([]);
});
