import { expect, test } from "@playwright/test";

test("horse course is reachable and a spectator race leaves game coins alone", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/");
  const balance = await page.locator("#balance").textContent();
  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await page.locator('[data-site="npc-harbor-horse-course"]').click();
  await expect(
    page.getByRole("heading", { name: "Harbor Horse Course" }),
  ).toBeVisible();
  const raceCanvas = await page.locator("#horse-race-canvas").boundingBox();
  expect(raceCanvas).not.toBeNull();
  expect(raceCanvas!.y + raceCanvas!.height).toBeLessThanOrEqual(390);
  await page.locator("#horse-race-watch").click();
  await expect(page.locator("#horse-race-status")).toContainText("wins");
  await page.locator("#horse-race-watch").click();
  await expect(page.locator("#horse-race-watch")).toHaveText("Watch race");
  await page.locator("#horse-race-watch").click();
  await expect(page.locator("#horse-race-status")).toContainText("wins");
  expect(await page.locator("#balance").textContent()).toBe(balance);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(844);
});

test("local horse bet demo settles separately from parking coins", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?horse-betting-demo=1");
  const balance = await page.locator("#balance").textContent();
  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await page.locator('[data-site="npc-harbor-horse-course"]').click();
  await page.locator("#horse-demo-place").click();
  await expect(page.locator("#horse-demo-balance")).toContainText("99");
  await page.locator("#horse-race-watch").click();
  await expect(page.locator("#horse-bet-message")).toContainText("Winner!");
  await expect(page.locator("#horse-demo-balance")).toContainText("102.8");
  expect(await page.locator("#balance").textContent()).toBe(balance);
  await page.locator("#destination-back").click();
  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await page.locator('[data-site="npc-harbor-horse-course"]').click();
  await expect(page.locator("#horse-demo-balance")).toContainText("102.8");
});

test("practice course finishes, saves a best time and leaves parking resources alone", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.goto("/");
  const balance = await page.locator("#balance").textContent();
  const durability = await page.locator("#durability").textContent();
  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await page.locator('[data-site="npc-central-course"]').click();
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
  await page.locator('[data-site="npc-central-course"]').click();
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
  await page.locator('[data-site="npc-harbor-cinema"]').click();
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
