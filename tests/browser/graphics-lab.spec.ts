import { expect, test } from "@playwright/test";

test("mixed plot graphics and a local owner logo preview", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/graphics-lab.html");
  await expect(page.locator(".choice-card")).toHaveCount(15);
  await page
    .getByRole("combobox", { name: "Building level" })
    .selectOption("4");
  await expect(page.locator("#selection-detail")).toContainText("Level 4");
  await expect(page.locator("#selection-label")).toContainText(
    "2 units · 2 spaces",
  );

  await page.getByRole("button", { name: "Preview Garden bistro" }).click();
  await expect(page.locator("#selection-label")).toContainText(
    "3 units · 3 spaces",
  );
  await expect(
    page.getByRole("button", { name: "Preview Garden bistro" }),
  ).toHaveAttribute("aria-pressed", "true");
  const originalCard = await page
    .getByRole("button", { name: "Preview Garden bistro" })
    .locator("canvas")
    .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());

  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#284a95";
    context.fillRect(0, 0, 16, 16);
    context.fillStyle = "white";
    context.font = "bold 13px Arial";
    context.fillText("N", 3, 13);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.locator("#logo-file").setInputFiles({
    name: "my-mark.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await expect(page.locator("#logo-status")).toContainText(
    "Previewing my-mark.png locally",
  );
  const brandedCard = await page
    .getByRole("button", { name: "Preview Garden bistro" })
    .locator("canvas")
    .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  expect(brandedCard).not.toBe(originalCard);
  await page.getByRole("button", { name: "Clear logo" }).click();
  await expect(page.locator("#logo-status")).toContainText(
    "Images are not saved",
  );
  const restoredCard = await page
    .getByRole("button", { name: "Preview Garden bistro" })
    .locator("canvas")
    .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  expect(restoredCard).toBe(originalCard);

  await page.getByRole("button", { name: /North side/ }).click();
  await expect(page.locator("#selection-detail")).toContainText("South side");
  await page.getByRole("combobox", { name: "Street" }).selectOption("central");
  await expect(page.locator("#selection-detail")).toContainText(
    "Central Avenue",
  );
  expect(errors).toEqual([]);
});
