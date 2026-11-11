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
      for (const [type, shapes] of [
        ["Retail", ["Corner shop", "Market hall"]],
        ["Cafe", ["Glasshouse", "Pergola"]],
        ["Restaurant", ["Diner", "Bistro"]],
        ["Office", ["Glass block", "Studio"]],
        ["Homes", ["Terrace", "Townhouse"]],
      ] as const) {
        await page.locator("#studio-type").selectOption(type);
        for (const shape of shapes)
          await expect(
            page.getByRole("img", {
              name: `${type} ${shape} illustrated level 2 style study`,
            }),
          ).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator(".studio-art-direction img")
              .evaluateAll(
                (images) =>
                  images.filter(
                    (image) =>
                      image instanceof HTMLImageElement &&
                      image.naturalWidth > 0,
                  ).length,
              ),
          )
          .toBe(2);
      }
    }
    await page.locator("#studio-type").selectOption("Cafe");
    await expect(
      page.getByRole("img", {
        name: "Cafe Glasshouse illustrated level 2 style study",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", {
        name: "Cafe Pergola illustrated level 2 style study",
      }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".studio-art-direction img")
          .evaluateAll(
            (images) =>
              images.filter(
                (image) =>
                  image instanceof HTMLImageElement && image.naturalWidth > 0,
              ).length,
          ),
      )
      .toBe(2);
    await page.locator("#studio-level").selectOption("4");
    await page
      .locator(
        viewport.name === "phone portrait"
          ? "#explore-presets-mobile"
          : "#explore-presets",
      )
      .click();
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
      "Choose",
    );
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Next design" }).click();
    await expect(choice).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#studio-next-design")).toBeFocused();
    await page.getByRole("button", { name: "Previous design" }).click();
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#studio-previous-design")).toBeFocused();
    await page.locator("#studio-open-preview").click();
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
    if (viewport.name === "desktop") {
      await page.locator("#studio-type").selectOption("Homes");
      await expect(page.locator(".studio-screen")).toHaveAttribute(
        "data-step",
        "Describe",
      );
      await expect(page.locator('[data-studio-step="Preview"]')).toBeDisabled();
    }
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

test("narrow phone studio keeps its next action above navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Phone navigation" })
    .getByRole("button", { name: "Plots" })
    .click();
  await page.locator("#open-studio").click();
  const action = page.locator("#explore-presets-mobile");
  const navigation = page.getByRole("navigation", {
    name: "Phone navigation",
  });
  await expect(action).toBeVisible();
  await expect(action).toHaveText("See 3 level 1 designs →");
  await expect(page.locator('[data-studio-step="Choose"]')).toBeDisabled();
  await expect(page.locator('[data-studio-step="Preview"]')).toBeDisabled();
  const actionBox = await action.boundingBox();
  const navigationBox = await navigation.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(
    navigationBox!.y,
  );
  await page.locator("#studio-description").fill("A rooftop garden cafe");
  const ideaBox = await page.locator("#studio-description").boundingBox();
  const scrolledActionBox = await action.boundingBox();
  expect(ideaBox).not.toBeNull();
  expect(scrolledActionBox).not.toBeNull();
  expect(ideaBox!.y + ideaBox!.height).toBeLessThanOrEqual(
    scrolledActionBox!.y,
  );
  await page.locator("#studio-level").selectOption("2");
  await expect(action).toHaveText("See 3 level 2 designs →");
  await expect(action).toBeVisible();
  await action.click();
  await expect(page.locator(".studio-screen")).toHaveAttribute(
    "data-step",
    "Choose",
  );
  await expect(action).toBeHidden();
  await expect(page.locator('[data-studio-step="Preview"]')).toBeEnabled();
  await page.locator("#studio-previous-design").click();
  await expect(
    page.locator('.candidate-thumbnails [data-candidate="2"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await page.locator("#studio-next-design").click();
  await expect(
    page.locator('.candidate-thumbnails [data-candidate="0"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-studio-step="Describe"]').click();
  await page.locator("#studio-type").selectOption("Cafe");
  await expect(page.locator('[data-studio-step="Choose"]')).toBeDisabled();
  await expect(page.locator('[data-studio-step="Preview"]')).toBeDisabled();
  await expect(action).toBeVisible();
  await noHorizontalOverflow(page);
});
