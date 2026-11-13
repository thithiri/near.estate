import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("guest playtest log requires opt-in and downloads only action timing", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#action").click();
  await page.locator("#collect").click();
  await page.locator('.topbar [data-screen="Menu"]').click();
  await expect(page.getByText("Recording is off")).toBeVisible();
  await page.locator("#menu-playtest-toggle").click();
  await page.locator('[data-menu-go="Street"]').click();
  await page.locator("#action").click();
  await page.locator("#collect").click();
  await page.locator('.topbar [data-screen="Menu"]').click();
  await expect(page.getByText("Recording · 2 events")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#menu-playtest-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("near-estate-playtest.json");
  const path = await download.path();
  expect(path).not.toBeNull();
  const content = await readFile(path!, "utf8");
  const data = JSON.parse(content) as {
    schema: number;
    source: string;
    events: Array<{ name: string; minute: number }>;
  };
  expect(data.schema).toBe(1);
  expect(data.source).toBe("guest");
  expect(data.events.map((event) => event.name)).toEqual([
    "park_legal",
    "collect",
  ]);
  expect(content).not.toMatch(/accountId|plotId|locationId|secretKey/);
  await page.locator("#menu-playtest-clear").click();
  await expect(page.getByText("Recording is off")).toBeVisible();
});
