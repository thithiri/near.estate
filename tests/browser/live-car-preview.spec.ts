import { expect, test } from "@playwright/test";

const fixture = `<!doctype html><html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/src/style.css">
  </head><body><main class="screen" style="padding:14px"><div id="host"></div></main>
  <script type="module">
    import { ChainScreen } from "/src/chain-screen.ts";
    const starter = new URLSearchParams(location.search).has("starter");
    const screen = new ChainScreen(document.querySelector("#host"), {}, () => ({ roadId: "main", side: "North" }), [], async () => ({}));
    Object.assign(screen, {
      visible: true,
      wallet: { accountId: "driver.testnet", hasPendingGameplayAction: () => false },
      player: {
        account_id: "driver.testnet",
        account: starter ? null : { balance: "100000000", active_session_id: null, last_emergency_repair_at: null },
        cars: starter ? [] : [{ id: 1, body: "Hatchback", color: "Red", tier: 1, durability: 100, parked_session_id: null }],
        active_session: null,
      },
      selectedCarId: starter ? null : 1,
    });
    screen.render();
  </script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.route("**/__live_car_preview*", (route) =>
    route.fulfill({ contentType: "text/html", body: fixture }),
  );
});

test("starter choice shows its illustrated car", async ({ page }) => {
  await page.goto("/__live_car_preview?starter");
  await page.locator("#starter-body").selectOption("Pickup");
  await page.locator("#starter-color").selectOption("Blue");
  const preview = page.locator("#starter-preview");
  await expect(preview).toHaveAttribute(
    "alt",
    "Blue Pickup starter car preview",
  );
  await expect(preview).toHaveAttribute(
    "src",
    /world\/guest-pickup-blue\.png$/,
  );
  expect(
    await preview.evaluate((image: HTMLImageElement) =>
      image.decode().then(() => image.naturalWidth),
    ),
  ).toBe(256);
});

test("owned and purchase cars show illustrated previews", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__live_car_preview");
  const selected = page.locator('img[alt="Red Hatchback selected car"]');
  expect(
    await selected.evaluate((image: HTMLImageElement) =>
      image.decode().then(() => image.naturalWidth),
    ),
  ).toBe(256);
  await page.locator("#chain-buy-body").selectOption("SUV");
  await page.locator("#chain-buy-color").selectOption("Green");
  const preview = page.locator("#chain-buy-preview");
  await expect(preview).toHaveAttribute("alt", "Green SUV purchase preview");
  await expect(preview).toHaveAttribute("src", /world\/guest-suv-green\.png$/);
  expect(
    await preview.evaluate((image: HTMLImageElement) =>
      image.decode().then(() => image.naturalWidth),
    ),
  ).toBe(256);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
