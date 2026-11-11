import { expect, test } from "@playwright/test";

test("practice course finishes, saves a best time and leaves parking resources alone", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.goto("/");
  const balance = await page.locator("#balance").textContent();
  const durability = await page.locator("#durability").textContent();
  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await page.getByRole("button", { name: "Practice Course" }).click();
  await page.locator("#practice-start").click();
  await page.keyboard.down("ArrowUp");
  await expect(page.locator("#practice-status")).toContainText("Finished!", {
    timeout: 25_000,
  });
  await page.keyboard.up("ArrowUp");
  await expect(page.locator("#practice-status")).toContainText(
    "3/3 checkpoints",
  );
  const best = await page.evaluate(() =>
    localStorage.getItem("near-estate-practice-best-v1:guest"),
  );
  expect(Number(best)).toBeGreaterThan(0);
  expect(await page.locator("#balance").textContent()).toBe(balance);
  expect(await page.locator("#durability").textContent()).toBe(durability);

  await page.reload();
  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await page.getByRole("button", { name: "Practice Course" }).click();
  await expect(page.locator("#practice-status")).toContainText(
    `Best ${Number(best).toFixed(2)}s`,
  );
});

test("cinema pauses, finishes and replays without changing parking resources", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.goto("/");
  const balance = await page.locator("#balance").textContent();
  const durability = await page.locator("#durability").textContent();
  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await page.getByRole("button", { name: "Harbor Cinema" }).click();
  const progress = () =>
    page
      .locator("#cinema-progress")
      .evaluate((element) => (element as HTMLProgressElement).value);
  await page.locator("#cinema-play").click();
  await expect(page.locator("#cinema-play")).toHaveText("Pause");
  await page.waitForTimeout(1_000);
  await page.locator("#cinema-play").click();
  const pausedAt = await progress();
  await page.waitForTimeout(400);
  expect(await progress()).toBe(pausedAt);
  await page.locator("#cinema-play").click();
  await expect(page.locator("#cinema-play")).toHaveText("Play again", {
    timeout: 25_000,
  });
  expect(await progress()).toBe(18);
  await expect(page.locator("#cinema-caption")).toContainText(
    "parking tower has room",
  );
  expect(await page.locator("#balance").textContent()).toBe(balance);
  expect(await page.locator("#durability").textContent()).toBe(durability);
  await page.locator("#cinema-restart").click();
  await expect(page.locator("#cinema-play")).toHaveText("Pause");
  expect(await progress()).toBeLessThan(1);
  await page.locator("#cinema-play").click();
});
