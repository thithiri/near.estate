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

test("holding the game HUD does not select its text", async ({ page }) => {
  await page.goto("/");
  for (const selector of [
    "#balance",
    "#mobile-street-name",
    "#action",
    "#left span",
  ]) {
    await expect(page.locator(selector)).toHaveCSS("user-select", "none");
  }
  await holdTouch(page, "#balance", 800);
  expect(
    await page.evaluate(() => window.getSelection()?.toString() ?? ""),
  ).toBe("");
});

test("landscape phone HUD keeps dark text on light controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/");
  for (const selector of [
    "#balance",
    ".topbar nav button[data-screen='Map']",
    "#durability",
  ]) {
    await expect(page.locator(selector)).toHaveCSS("color", "rgb(25, 43, 69)");
  }
});

test("holding phone drive controls moves and releasing stops the car", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#street-canvas canvas")).toBeVisible();
  await expect(
    page.locator("#street-canvas .street-gamepad #left"),
  ).toBeVisible();
  await expect(
    page.locator("#street-canvas .street-gamepad #right"),
  ).toBeVisible();
  await expect(
    page.locator("#street-canvas .street-gamepad #cross-side"),
  ).toBeVisible();
  await expect(
    page.locator("#street-canvas .street-gamepad #action"),
  ).toBeVisible();
  await expect(page.locator("#cross-side")).toHaveAttribute("data-glyph", "↑");
  await expect(page.locator("#action")).toHaveAttribute("data-glyph", "P");
  await expect(page.locator("#action")).toHaveAttribute(
    "aria-label",
    "Park here",
  );
  await expect(page.locator(".controlbar #left")).toHaveCount(0);
  const bounds = await Promise.all(
    ["#left", "#right", "#cross-side", "#action"].map((selector) =>
      page.locator(selector).boundingBox(),
    ),
  );
  for (const box of bounds) expect(box).not.toBeNull();
  const [left, right, cross, park] = bounds.map((box) => box!);
  expect(left.x).toBeLessThan(cross.x);
  expect(right.x).toBeGreaterThan(cross.x);
  expect(cross.y).toBeLessThan(left.y);
  expect(park.y).toBe(left.y);
  expect(right.x + right.width).toBeLessThanOrEqual(667);
  await expect(page.locator("#plot-title")).toContainText("Plot 1");

  await holdTouch(page, "#right", 1_650, true);
  await expect(page.locator("#plot-title")).toContainText("Plot 3");
  await page.waitForTimeout(1_400);
  await expect(page.locator("#plot-title")).toContainText("Plot 3");

  await holdTouch(page, "#left", 1_900);
  await expect(page.locator("#plot-title")).toContainText("Plot 1");
  await expect(page.locator("#action")).toHaveText("Park here");
  await page.locator("#action").tap();
  await expect(page.locator("#collect")).toBeVisible();
});

test("releasing left drive does not shift the street or car", async ({
  page,
}) => {
  await page.goto("/");
  await holdTouch(page, "#right", 3_600);
  const left = await page.locator("#left").boundingBox();
  expect(left).not.toBeNull();
  const touch = {
    x: left!.x + left!.width / 2,
    y: left!.y + left!.height / 2,
    id: 1,
    radiusX: 4,
    radiusY: 4,
  };
  const readView = () =>
    page.evaluate(() => {
      const read = (
        window as Window & {
          __nearEstateDriveView?: () => {
            carX: number;
            worldX: number;
            worldScale: number;
            moving: number;
            cameraAnchor: number;
          };
        }
      ).__nearEstateDriveView;
      if (!read) throw new Error("Development drive view unavailable");
      return read();
    });
  const cdp = await page.context().newCDPSession(page);
  let touchActive = false;
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touch],
    });
    touchActive = true;
    await page.waitForTimeout(800);
    const before = await readView();
    expect(before.moving).toBe(-1);
    expect(before.cameraAnchor).toBeGreaterThan(0.55);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    touchActive = false;
    await page.waitForTimeout(150);
    const after = await readView();
    expect(after.moving).toBe(0);
    const roadJump = Math.abs(
      after.worldX -
        before.worldX +
        (after.carX - before.carX) * after.worldScale,
    );
    expect(roadJump).toBeLessThan(4);
    expect(Math.abs(after.cameraAnchor - before.cameraAnchor)).toBeLessThan(
      0.01,
    );
  } finally {
    if (touchActive)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    await cdp.detach();
  }
});

test("a quick tap nudges the car across a plot boundary", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#plot-title")).toContainText("Plot 1");
  for (let tap = 0; tap < 5; tap++) await page.locator("#right").tap();
  await expect(page.locator("#plot-title")).toContainText("Plot 2");
  await page.locator("#left").tap();
  await expect(page.locator("#plot-title")).toContainText("Plot 1");
});

test("tapping the second empty stall parks there without an instruction row", async ({
  page,
}) => {
  for (const width of [844, 667]) {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 375 });
    await page.goto("/");
    await expect(page.locator("footer#status")).toHaveCount(0);
    await expect(page.locator("#status")).toBeEmpty();
    const canvas = await page.locator("#street-canvas canvas").boundingBox();
    expect(canvas).not.toBeNull();
    const scale = Math.max(0.5, canvas!.height / 300);
    await page.touchscreen.tap(
      canvas!.x + 127 * scale,
      canvas!.y + 224 * scale,
    );
    await expect(page.locator("#status")).toContainText("Parked in space 2");
    await expect(page.locator("#collect")).toBeVisible();
    const feedback = await page.locator("#status").boundingBox();
    const controls = await page.locator(".controlbar").boundingBox();
    expect(feedback).not.toBeNull();
    expect(controls).not.toBeNull();
    expect(feedback!.x + feedback!.width + 8).toBeLessThanOrEqual(controls!.x);
  }
});

test("releasing one road corner keeps the other held direction active", async ({
  page,
}) => {
  await page.goto("/");
  const right = await page.locator("#right").boundingBox();
  const left = await page.locator("#left").boundingBox();
  expect(right).not.toBeNull();
  expect(left).not.toBeNull();
  const rightTouch = {
    x: right!.x + right!.width / 2,
    y: right!.y + right!.height / 2,
    id: 1,
    radiusX: 4,
    radiusY: 4,
  };
  const leftTouch = {
    x: left!.x + left!.width / 2,
    y: left!.y + left!.height / 2,
    id: 2,
    radiusX: 4,
    radiusY: 4,
  };
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [rightTouch],
    });
    await expect(page.locator("#plot-title")).toContainText("Plot 2", {
      timeout: 3_000,
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [rightTouch, leftTouch],
    });
    await page.waitForTimeout(300);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [leftTouch],
    });
    await expect(page.locator("#plot-title")).toContainText("Plot 3", {
      timeout: 3_000,
    });
  } finally {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
  }
});

test("junction and end street signs open their connected roads", async ({
  page,
}) => {
  await page.goto("/?preview-plot=plot-main-n-0");
  const canvas = await page.locator("#street-canvas").boundingBox();
  expect(canvas).not.toBeNull();
  const scale = canvas!.height / 300;
  await page.mouse.click(canvas!.x + 550 * scale, canvas!.y + 184 * scale);
  await expect(page.locator("#mobile-street-name")).toHaveText(
    "Central Avenue · West curb",
  );

  await page.goto("/?preview-plot=plot-main-n-0");
  const reopened = await page.locator("#street-canvas").boundingBox();
  expect(reopened).not.toBeNull();
  const reopenedScale = reopened!.height / 300;
  await page.mouse.click(
    reopened!.x + 53 * reopenedScale,
    reopened!.y + 197 * reopenedScale,
  );
  await expect(page.locator("#mobile-street-name")).toContainText(
    "Market Street",
  );
});
