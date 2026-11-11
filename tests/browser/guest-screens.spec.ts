import { expect, test, type Page } from "@playwright/test";

async function noHorizontalOverflow(page: Page): Promise<void> {
  const sizes = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 720, navigation: "Main navigation" },
  {
    name: "phone landscape",
    width: 667,
    height: 375,
    navigation: "Main navigation",
  },
  {
    name: "phone portrait",
    width: 390,
    height: 844,
    navigation: "Phone navigation",
  },
] as const) {
  test(`guest screens remain reachable at ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto("/");

    const navigation = page.getByRole("navigation", {
      name: viewport.navigation,
    });
    if (viewport.name === "phone portrait") {
      await expect(
        page.getByRole("heading", { name: "Rotate to drive" }),
      ).toBeVisible();
      await expect(page.locator("#street-canvas")).toBeHidden();
    } else {
      await expect(page.locator("#street-canvas canvas")).toBeVisible();
    }
    if (viewport.name === "phone landscape") {
      await page.locator("#context-details").click();
      await expect(page.locator("#plot-panel")).toHaveClass(/mobile-open/);
      await expect(page.locator("#panel-action")).toBeHidden();
      await page.locator("#close-panel").click();
      await expect(page.locator("#plot-panel")).not.toHaveClass(/mobile-open/);
    }
    await noHorizontalOverflow(page);

    await navigation.getByRole("button", { name: "Map" }).click();
    await expect(page.getByRole("heading", { name: "City map" })).toBeVisible();
    await expect(page.locator("[data-road]")).toHaveCount(5);
    await noHorizontalOverflow(page);
    await page.locator('[data-road="market"]').click();
    await expect(page.locator("#street-name")).toHaveText("Market Street");

    await navigation.getByRole("button", { name: "Cars" }).click();
    await expect(page.getByRole("heading", { name: "My cars" })).toBeVisible();
    await expect(page.getByText("100% durability")).toBeVisible();
    await noHorizontalOverflow(page);

    if (viewport.name === "phone landscape") {
      await navigation.getByRole("button", { name: "Menu" }).click();
      await page.locator('[data-menu-go="My Plots"]').click();
    } else {
      await navigation
        .getByRole("button", { name: /^(My Plots|Plots)$/ })
        .click();
    }
    await expect(page.getByRole("heading", { name: "My plots" })).toBeVisible();
    await page.locator("#open-studio").click();
    await expect(
      page.getByRole("heading", { name: "Build your place" }),
    ).toBeVisible();
    if (viewport.name === "desktop") {
      for (const type of ["Retail", "Cafe", "Restaurant", "Office", "Homes"]) {
        await page.locator("#studio-type").selectOption(type);
        await expect(
          page.getByRole("img", {
            name: `${type} illustrated level 2 style study`,
          }),
        ).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator(".studio-art-direction img")
              .evaluate((image) =>
                image instanceof HTMLImageElement ? image.naturalWidth : 0,
              ),
          )
          .toBeGreaterThan(0);
      }
    }
    await page.locator("#studio-type").selectOption("Cafe");
    await expect(
      page.getByRole("img", { name: "Cafe illustrated level 2 style study" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".studio-art-direction img")
          .evaluate((image) =>
            image instanceof HTMLImageElement ? image.naturalWidth : 0,
          ),
      )
      .toBeGreaterThan(0);
    await page.locator("#studio-level").selectOption("4");
    await page.locator("#explore-presets").click();
    await expect(page.locator(".candidate-grid [data-candidate]")).toHaveCount(
      3,
    );
    await expect(page.locator(".studio-screen")).toHaveAttribute(
      "data-step",
      "Choose",
    );
    const choice =
      viewport.width <= 700
        ? page.locator('.candidate-thumbnails [data-candidate="1"]')
        : page.locator('.candidate-grid [data-candidate="1"]');
    await choice.click();
    await expect(page.locator(".studio-screen")).toHaveAttribute(
      "data-step",
      "Preview",
    );
    await expect(
      page.locator(".studio-neighbour .studio-building"),
    ).toHaveCount(2);
    for (const neighbour of await page
      .locator(".studio-neighbour .studio-building")
      .all())
      await expect(neighbour).toBeVisible();
    await noHorizontalOverflow(page);
    await page.locator("#studio-back").click();
    await page.locator("#open-stats").click();
    await expect(
      page.getByRole("heading", { name: "Advertiser stats" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Guest preview" }),
    ).toBeVisible();
    await noHorizontalOverflow(page);

    await navigation.getByRole("button", { name: "Map" }).click();
    await page.getByRole("button", { name: "Harbor Cinema" }).click();
    await expect(
      page.getByRole("heading", { name: "Harbor Cinema" }),
    ).toBeVisible();
    await page.locator("#cinema-play").click();
    await expect(page.locator("#cinema-play")).toHaveText("Pause");
    await noHorizontalOverflow(page);

    await navigation.getByRole("button", { name: "Map" }).click();
    await page.getByRole("button", { name: "Practice Course" }).click();
    await expect(
      page.getByRole("heading", { name: "Practice Course", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#practice-start")).toBeVisible();
    await noHorizontalOverflow(page);
    expect(pageErrors).toEqual([]);
  });
}
