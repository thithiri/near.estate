import { expect, test } from "@playwright/test";

test("a guest can choose a fitting design and see it on the playable street", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.locator('.topbar [data-screen="Menu"]').click();
  await page.locator('[data-menu-go="My Plots"]').click();
  await page.getByRole("button", { name: "Choose street design" }).click();
  await expect(
    page.getByRole("heading", { name: "Choose a 2-unit building" }),
  ).toBeVisible();
  await expect(page.locator(".guest-design-card")).toHaveCount(5);
  await page.getByRole("button", { name: "Level 4 · 160px" }).click();
  await expect(
    page.getByRole("button", { name: "Level 4 · 160px" }),
  ).toHaveAttribute("aria-pressed", "true");
  const beforeLogo = await page
    .getByRole("button", { name: "Use Arcade on plot 4" })
    .locator("canvas")
    .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  const logo = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 24;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#e6b746";
    context.fillRect(0, 0, 24, 24);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page
    .getByLabel("Preview your logo on the building choices")
    .setInputFiles({
      name: "mark.png",
      mimeType: "image/png",
      buffer: Buffer.from(logo, "base64"),
    });
  await expect(page.getByRole("status")).toContainText(
    "Previewing mark.png locally",
  );
  const afterLogo = await page
    .getByRole("button", { name: "Use Arcade on plot 4" })
    .locator("canvas")
    .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  expect(afterLogo).not.toBe(beforeLogo);
  await page.getByRole("button", { name: "Use Arcade on plot 4" }).click();
  await expect(page.locator("#plot-title")).toContainText(
    "Arcade · Plot 4 · 2 units · Level 4",
  );
  await expect(page.locator("#plot-spaces")).toContainText("of 2 spaces free");
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.locator("#panel-design")).toBeVisible();
  await page.locator("#panel-design").click();
  await expect(
    page.getByRole("button", { name: "Use Arcade on plot 4" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Level 4 · 160px" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});

test("portrait picker shows a building choice above the bottom navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator('.mobile-bottom-nav [data-screen="My Plots"]').click();
  await page.getByRole("button", { name: "Choose street design" }).click();
  await page.getByRole("button", { name: "Level 4 · 160px" }).click();
  const firstCard = await page
    .locator(".guest-design-card")
    .first()
    .boundingBox();
  const navigation = await page.locator(".mobile-bottom-nav").boundingBox();
  expect(firstCard).not.toBeNull();
  expect(navigation).not.toBeNull();
  expect(firstCard!.y).toBeLessThan(navigation!.y);
});

test("building picker releases older previews while cycling through four levels", async ({
  page,
}) => {
  const failedImages: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/guest-buildings/") && !response.ok())
      failedImages.push(`${response.status()} ${response.url()}`);
  });
  const previewStats = () =>
    page.evaluate(async () => {
      const { guestPreviewImageStats } = await import(
        "/src/guest-illustration.ts"
      );
      return guestPreviewImageStats();
    });
  await page.goto("/");
  await page.locator('.topbar [data-screen="Menu"]').click();
  await page.locator('[data-menu-go="My Plots"]').click();
  await page.getByRole("button", { name: "Choose street design" }).click();
  for (const [level, expected] of [
    [1, 5],
    [2, 10],
    [3, 15],
    [4, 15],
    [1, 15],
  ] as const) {
    await page
      .getByRole("button", {
        name: `Level ${level} · ${[70, 100, 130, 160][level - 1]}px`,
      })
      .click();
    await expect
      .poll(async () => {
        const stats = await previewStats();
        return stats.loadedImages === stats.cachedImages
          ? stats.loadedImages
          : 0;
      })
      .toBe(expected);
    expect((await previewStats()).cachedImages).toBeLessThanOrEqual(15);
  }
  expect((await previewStats()).maxImages).toBe(15);
  expect(failedImages).toEqual([]);
});

test("building picker retries a failed illustration without losing its fallback", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('.topbar [data-screen="Menu"]').click();
  await page.locator('[data-menu-go="My Plots"]').click();
  await page.getByRole("button", { name: "Choose street design" }).click();
  let attempts = 0;
  await page.route("**/guest-buildings/diner-l4.png", async (route) => {
    attempts++;
    if (attempts === 1)
      await route.fulfill({ status: 503, body: "Temporary image outage" });
    else await route.continue();
  });
  const diner = page.getByRole("button", { name: "Use Diner on plot 4" });
  const canvasImage = () =>
    diner
      .locator("canvas")
      .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  await page.getByRole("button", { name: "Level 4 · 160px" }).click();
  await expect.poll(() => attempts).toBe(1);
  const fallback = await canvasImage();
  await page.getByRole("button", { name: "Level 4 · 160px" }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect.poll(canvasImage).not.toBe(fallback);
});

test("a local ad image fills an eligible billboard in the building picker", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('.topbar [data-screen="Menu"]').click();
  await page.locator('[data-menu-go="My Plots"]').click();
  await page.getByRole("button", { name: "Choose street design" }).click();
  await page.getByRole("button", { name: "Level 3 · 130px" }).click();
  const diner = page.getByRole("button", { name: "Use Diner on plot 4" });
  const before = await diner
    .locator("canvas")
    .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ed465a";
    context.fillRect(0, 0, 80, 40);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.getByLabel("Preview an ad on billboard designs").setInputFiles({
    name: "my-ad.png",
    mimeType: "image/png",
    buffer: Buffer.from(image, "base64"),
  });
  await expect(
    page.getByText("Previewing my-ad.png locally", { exact: false }),
  ).toBeVisible();
  const after = await diner
    .locator("canvas")
    .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  expect(after).not.toBe(before);
  await diner.click();
  await expect(page.locator("#plot-title")).toContainText("Diner");
});

for (const [plotId, units] of [
  ["plot-main-n-1", 1],
  ["plot-main-n-7", 3],
] as const) {
  test(`${units}-unit guest plot shows its real parking capacity`, async ({
    page,
  }) => {
    await page.goto(`/?preview-plot=${plotId}`);
    await expect(page.locator("#plot-spaces")).toContainText(
      `${units} of ${units} ${units === 1 ? "space" : "spaces"} free`,
    );
    await page.locator("#action").click();
    await expect(page.locator("#plot-spaces")).toContainText(
      `${units - 1} of ${units} ${units === 1 ? "space" : "spaces"} free`,
    );
    await expect(page.locator("#collect")).toBeVisible();
  });
}
