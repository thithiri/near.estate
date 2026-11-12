import { expect, test } from "@playwright/test";

test("drive all five guest streets on both sides and open the connected map", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const road of ["main", "market", "river", "central", "harbor"]) {
    for (const [side, letter] of [
      ["North", "n"],
      ["South", "s"],
    ] as const) {
      await page.goto(`/?preview-plot=plot-${road}-${letter}-0`);
      await expect(page.locator("#plot-title")).toContainText("Plot 1");
      const before = await page.locator("#plot-title").textContent();
      await page.keyboard.down("ArrowRight");
      await page.waitForTimeout(1_700);
      await page.keyboard.up("ArrowRight");
      await expect
        .poll(() => page.locator("#plot-title").textContent())
        .not.toBe(before);
      await page.locator("#cross-side").click();
      await expect(page.locator("#cross-side")).toHaveText("Cross road");
      const oppositeCurb =
        road === "central" || road === "harbor"
          ? side === "North"
            ? "East curb"
            : "West curb"
          : side === "North"
            ? "South curb"
            : "North curb";
      await expect(page.locator("#street-side")).toHaveText(oppositeCurb);
      await expect(page.locator("#mobile-street-name")).toContainText(
        oppositeCurb,
      );
      await page.goto(`/?preview-plot=plot-${road}-${letter}-9`);
      await expect(page.locator("#plot-title")).toContainText("Plot 10");
      const farEnd = await page.locator("#plot-title").textContent();
      await page.keyboard.down("ArrowLeft");
      await page.waitForTimeout(1_700);
      await page.keyboard.up("ArrowLeft");
      await expect
        .poll(() => page.locator("#plot-title").textContent())
        .not.toBe(farEnd);
    }
  }
  await page.goto("/?preview-plot=plot-main-n-0");
  await page.keyboard.down("ArrowLeft");
  await expect(page.locator("#mobile-street-name")).toContainText(
    "Market Street",
    { timeout: 5_000 },
  );
  await page.keyboard.up("ArrowLeft");
  await page.locator('.topbar [data-screen="Map"]').click();
  await expect(page.getByRole("heading", { name: "City map" })).toBeVisible();
  await expect(page.locator("button[data-road]")).toHaveCount(5);
  await expect(page.locator("button[data-tower]")).toHaveCount(3);
  await expect(page.locator("button[data-site]")).toHaveCount(4);
  await page.locator('button[data-road="main"]').click();
  await expect(page.locator("#mobile-street-name")).toContainText(
    "Main Street",
  );
  expect(errors).toEqual([]);
});
