import { expect, test } from "@playwright/test";

const ownerReviewPage = `<!doctype html><html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/src/style.css">
  </head><body><main class="screen" style="padding:14px 14px 74px"><div id="host"></div></main>
  <script type="module">
    import { ChainScreen } from "/src/chain-screen.ts";
    const accountId = "alice.testnet";
    const level = new URLSearchParams(location.search).get("level") === "4" ? 4 : 2;
    const emptyMedia = { revision: 0, active: null, pending: null, last_decision: null, last_replacement_at: null };
    const building = { building_type: "Cafe", variant: 1, level, primary_color: "#F6C85F", name: "Cafe", approved_manifest_hash: null, approved_at: null, last_facade_approved_at: null, pending_appearance: null, last_appearance_decision: null, facade_exemption_level: null, appearance_revision: 1, layout_revision: 1 };
    const plot = { plot: { id: "plot-main-n-0", road_id: "main", side: "North", index: 0, corner: true, owner: accountId, rule: { kind: "Free" }, pending_rule: null, building, logo: emptyMedia, billboard: emptyMedia, ticket_cooldown_until: 0, reserved_storage_bytes: 4096, used_storage_bytes: 0 }, effective_rule: { kind: "Free" }, logo_eligible: false, billboard_eligible: false };
    const screen = new ChainScreen(document.querySelector("#host"), {}, () => ({ roadId: "main", side: "North" }), [], async () => ({}));
    Object.assign(screen, {
      visible: true,
      wallet: { accountId, hasPendingGameplayAction: () => false },
      player: { account_id: accountId, account: { balance: "100000000", active_session_id: null, last_emergency_repair_at: null }, cars: [], active_session: null },
      plots: [plot],
      ownerConfig: { version: 1, park_durability_cost: 5, max_durability: 100, repair_cost_per_point: "1000000", emergency_repair_cooldown_seconds: 3600, meter_rate_max_per_hour: "20000000", rule_delay_seconds: 3600, change_building_type_cost: "50000000", building_upgrade_costs: ["100000000", "200000000", "300000000"] },
      selectedOwnedPlotId: "plot-main-n-0",
      ownerDraft: { plotId: "plot-main-n-0", ruleKind: "Free", meterRate: "5", color: "Red", buildingType: "Cafe", variant: 1, palette: "#F6C85F", name: "Cafe" },
    });
    screen.render();
  </script></body></html>`;

for (const width of [320, 1280]) {
  test(`owner building types remain legible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.route("**/__owner_type_review", (route) =>
      route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
    );
    await page.goto("/__owner_type_review");
    const cards = page.locator(".owner-type-card");
    await expect(cards).toHaveCount(5);
    await expect(
      page.locator('[data-owner-building-type="Cafe"]'),
    ).toHaveAttribute("aria-pressed", "true");
    const imagesLoaded = await page
      .locator(".owner-type-card img")
      .evaluateAll(async (images) => {
        await Promise.all(
          images.map((image) => (image as HTMLImageElement).decode()),
        );
        return images.every(
          (image) => (image as HTMLImageElement).naturalWidth > 0,
        );
      });
    expect(imagesLoaded).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);

    if (width === 1280) {
      expect(
        await page
          .locator(".owner-type-grid")
          .evaluate(
            (grid) =>
              getComputedStyle(grid).gridTemplateColumns.split(" ").length,
          ),
      ).toBe(5);
    }

    await expect(page.locator(".owner-shape-card")).toHaveCount(2);
    await expect(page.locator(".owner-shape-label")).toHaveText([
      "Glasshouse",
      "Pergola",
    ]);
    const pergola = page.getByRole("button", {
      name: "Preview Cafe Pergola",
    });
    await pergola.click();
    await expect(pergola).toHaveAttribute("aria-pressed", "true");
    await expect(pergola).toBeFocused();
    await expect(page.locator(".owner-preview-label")).toHaveText(
      "Preview: Cafe · level 2 · Pergola",
    );
    await expect(page.locator(".owner-palette-choices button")).toHaveCount(4);
    const coral = page.getByRole("button", { name: "Coral colour" });
    await coral.click();
    await expect(coral).toHaveAttribute("aria-pressed", "true");
    await expect(coral).toBeFocused();
    await expect(
      page.locator(".owner-building-preview .studio-building-mask"),
    ).toHaveCSS("background-color", "rgb(239, 130, 112)");

    const office = page.locator('[data-owner-building-type="Office"]');
    await office.click();
    await expect(office).toHaveAttribute("aria-pressed", "true");
    await expect(office).toBeFocused();
    await expect(page.locator(".owner-shape-label")).toHaveText([
      "Glass block",
      "Studio",
    ]);
    await expect(
      page.getByRole("img", { name: "Office variant 2, level 2" }).last(),
    ).toBeVisible();
    await expect(page.locator(".owner-preview-label")).toHaveText(
      "Preview: Office · level 2 · Studio",
    );
    const glassBlock = page.getByRole("button", {
      name: "Preview Office Glass block",
    });
    await glassBlock.click();
    await expect(glassBlock).toHaveAttribute("aria-pressed", "true");
    await expect(glassBlock).toBeFocused();
    await expect(page.locator(".owner-preview-label")).toHaveText(
      "Preview: Office · level 2 · Glass block",
    );
    await expect(page.locator("#owner-change-type")).toHaveText(
      "Change to Office · 50 coins",
    );
    await expect(page.locator(".owner-palette-choices button")).toHaveCount(0);
    await expect(page.locator("#owner-building-name")).toHaveCount(0);
    await expect(
      page.locator(".owner-grid > .owner-section").last(),
    ).toContainText("This change keeps the current colour and name (Cafe)");
    await expect(
      page.locator(".owner-building-preview .studio-building-mask"),
    ).toHaveCSS("background-color", "rgb(246, 200, 95)");
    await expect(
      page.locator(".owner-grid > .owner-section").last(),
    ).toContainText("Current: Cafe · level 2");
    await page.locator('[data-owner-building-type="Cafe"]').click();
    await expect(page.locator("#owner-save-preset")).toBeVisible();
    await expect(coral).toHaveAttribute("aria-pressed", "true");
    if (width === 1280) {
      for (const [type, first, second] of [
        ["Retail", "Corner shop", "Market hall"],
        ["Cafe", "Glasshouse", "Pergola"],
        ["Restaurant", "Diner", "Bistro"],
        ["Office", "Glass block", "Studio"],
        ["Homes", "Terrace", "Townhouse"],
      ]) {
        await page.locator(`[data-owner-building-type="${type}"]`).click();
        await expect(page.locator(".owner-shape-label")).toHaveText([
          first,
          second,
        ]);
        const shapeImagesLoaded = await page
          .locator(".owner-shape-card img")
          .evaluateAll(async (images) => {
            await Promise.all(
              images.map((image) => (image as HTMLImageElement).decode()),
            );
            return images.every(
              (image) => (image as HTMLImageElement).naturalWidth > 0,
            );
          });
        expect(shapeImagesLoaded).toBe(true);
      }
    }
  });
}

test("level 4 shape cards fit a narrow owner editor", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("**/__owner_type_review**", (route) =>
    route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
  );
  await page.goto("/__owner_type_review?level=4");
  await expect(page.locator(".owner-shape-card")).toHaveCount(2);
  const shapesFit = await page
    .locator(".owner-shape-art")
    .evaluateAll((artFrames) =>
      artFrames.every((frame) => {
        const art = frame.getBoundingClientRect();
        const facade = frame
          .querySelector(".studio-building")!
          .getBoundingClientRect();
        return (
          facade.left >= art.left - 1 &&
          facade.right <= art.right + 1 &&
          facade.top >= art.top - 1 &&
          facade.bottom <= art.bottom + 1
        );
      }),
    );
  expect(shapesFit).toBe(true);
  await page.locator('[data-owner-building-type="Office"]').click();
  await page.locator('[data-owner-building-variant="2"]').click();
  await expect(
    page.getByRole("img", { name: "Office variant 2, level 4" }).last(),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});
