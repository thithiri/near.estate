import { expect, test, type Page } from "@playwright/test";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 667, height: 375 },
});

async function holdTouch(
  page: Page,
  buttonId: string,
  durationMs: number,
  slide = false,
) {
  const button = page.locator(buttonId);
  await expect(button).toBeVisible();
  const bounds = await button.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width / 2;
  const y = bounds!.y + bounds!.height / 2;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4 }],
    });
    if (slide) {
      await page.waitForTimeout(250);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y - 50, id: 1, radiusX: 4, radiusY: 4 }],
      });
    }
    await page.waitForTimeout(durationMs);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await cdp.detach();
  }
}

test("holding phone drive controls moves and releasing stops the car", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#street-canvas canvas")).toBeVisible();
  await expect(page.locator("#plot-title")).toContainText("Plot 1");

  await holdTouch(page, "#right", 1_650, true);
  await expect(page.locator("#plot-title")).toContainText("Plot 2");
  await page.waitForTimeout(1_400);
  await expect(page.locator("#plot-title")).toContainText("Plot 2");

  await holdTouch(page, "#left", 1_900);
  await expect(page.locator("#plot-title")).toContainText("Plot 1");
  await expect(page.locator("#action")).toHaveText("Park here");
  await page.locator("#action").tap();
  await expect(page.locator("#collect")).toBeVisible();
});
