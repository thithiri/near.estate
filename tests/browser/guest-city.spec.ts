import { expect, test } from "@playwright/test";

test("guest can park, collect, repair and ticket", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#action")).toHaveText("Park here");
  await page.locator("#action").click();
  await expect(page.locator("#durability")).toContainText("98%");
  await expect(page.locator("#collect")).toBeVisible();

  await page.locator("#collect").click();
  await expect(page.locator("#collect")).toBeHidden();
  await page.getByRole("button", { name: "Cars", exact: true }).first().click();
  const balanceBeforeRepair = Number(
    await page.locator("#balance").textContent(),
  );
  await page.getByRole("button", { name: "Repair to full · 2 coins" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Repaired Hatchback by 2 points",
  );
  await expect(page.getByText("100% durability")).toBeVisible();
  const balanceAfterRepair = Number(
    await page.locator("#balance").textContent(),
  );
  expect(balanceBeforeRepair - balanceAfterRepair).toBeCloseTo(2, 6);

  await page.getByRole("button", { name: "Menu", exact: true }).first().click();
  await page.locator('[data-menu-go="My Plots"]').click();
  await page.locator("#visit-owned").click();
  await expect(page.locator("#action")).toHaveText("Ticket");
  await page.locator("#action").click();
  await expect(page.locator("#status")).toContainText("Ticketed visitor");
  await expect(page.locator("#action")).toHaveText("Your curb");
});

test("full curbs leave the parking tower and free city stops available", async ({
  page,
}) => {
  await page.goto("/?full-curbs");
  await expect(page.locator("#action")).toBeDisabled();
  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await page.getByRole("button", { name: /Main Parking Tower/ }).click();
  await expect(page.locator("#action")).toHaveText("Park in tower");
  await page.locator("#tower-floor").selectOption("2");
  await page.locator("#action").click();
  await expect(page.locator("#status")).toContainText("Parked on floor 3");

  const balanceWhileParked = await page.locator("#balance").textContent();
  const durabilityWhileParked = await page.locator("#durability").textContent();
  await page.getByRole("button", { name: "Map", exact: true }).first().click();
  await page.getByRole("button", { name: /Near & Far Burgers/ }).click();
  await page.locator("#destination-burger").click();
  await expect(page.locator("#burger-count")).toContainText("1 burger break");
  await expect(page.locator("#balance")).toHaveText(balanceWhileParked ?? "");

  await page.locator("#destination-back").click();
  await expect(page.locator("#durability")).toHaveText(
    durabilityWhileParked ?? "",
  );
  await expect(page.locator("#collect")).toBeVisible();
  await page.locator("#collect").click();
  await expect(page.locator("#status")).toContainText("Collected");
});
