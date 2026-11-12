import { expect, test, type Page } from "@playwright/test";

type DriveView = {
  carX: number;
  roadId: string;
  side: "North" | "South";
  driveDirection: -1 | 1;
  moving: -1 | 0 | 1;
};

async function driveView(page: Page): Promise<DriveView> {
  return page.evaluate(() => {
    const read = (
      window as Window & {
        __nearEstateDriveView?: () => DriveView;
      }
    ).__nearEstateDriveView;
    if (!read) throw new Error("Development drive view unavailable");
    return read();
  });
}

test("Main's left exit enters Market facing inward on either curb", async ({
  page,
}) => {
  for (const [side, letter] of [
    ["North", "n"],
    ["South", "s"],
  ] as const) {
    await page.goto(`/?preview-plot=plot-main-${letter}-0`);
    await page.keyboard.down("ArrowLeft");
    await expect(page.locator("#street-name")).toHaveText("Market Street");
    await page.keyboard.up("ArrowLeft");
    const arrived = await driveView(page);
    expect(arrived).toMatchObject({
      roadId: "market",
      side,
      driveDirection: 1,
      moving: 0,
    });
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(700);
    await page.keyboard.up("ArrowRight");
    const inward = await driveView(page);
    expect(inward.roadId).toBe("market");
    expect(inward.carX).toBeGreaterThan(arrived.carX + 40);
  }
});

test("Market's right exit enters River facing inward on the same curb", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.goto("/?preview-plot=plot-market-s-9");
  await page.keyboard.down("ArrowRight");
  await expect(page.locator("#street-name")).toHaveText("River Street", {
    timeout: 25_000,
  });
  await page.keyboard.up("ArrowRight");
  const arrived = await driveView(page);
  expect(arrived).toMatchObject({
    roadId: "river",
    side: "South",
    driveDirection: -1,
    moving: 0,
  });
  await page.keyboard.down("ArrowLeft");
  await page.waitForTimeout(700);
  await page.keyboard.up("ArrowLeft");
  const inward = await driveView(page);
  expect(inward.roadId).toBe("river");
  expect(inward.carX).toBeLessThan(arrived.carX - 40);
});

test("the reverse end links also arrive facing into the next road", async ({
  page,
}) => {
  test.setTimeout(45_000);
  for (const route of [
    {
      start: "plot-market-s-0",
      key: "ArrowLeft",
      target: "Main Street",
      roadId: "main",
      facing: 1,
    },
    {
      start: "plot-river-s-9",
      key: "ArrowRight",
      target: "Market Street",
      roadId: "market",
      facing: -1,
    },
  ] as const) {
    await page.goto(`/?preview-plot=${route.start}`);
    await page.keyboard.down(route.key);
    await expect(page.locator("#street-name")).toHaveText(route.target, {
      timeout: 25_000,
    });
    await page.keyboard.up(route.key);
    expect(await driveView(page)).toMatchObject({
      roadId: route.roadId,
      side: "South",
      driveDirection: route.facing,
      moving: 0,
    });
  }
});

test("an unlinked road end stops the car on its current street", async ({
  page,
}) => {
  test.setTimeout(25_000);
  await page.goto("/?preview-plot=plot-main-n-9");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(10_000);
  const atEnd = await driveView(page);
  await page.waitForTimeout(350);
  const stillAtEnd = await driveView(page);
  await page.keyboard.up("ArrowRight");
  expect(atEnd.roadId).toBe("main");
  expect(stillAtEnd.roadId).toBe("main");
  expect(stillAtEnd.carX).toBe(atEnd.carX);
});
