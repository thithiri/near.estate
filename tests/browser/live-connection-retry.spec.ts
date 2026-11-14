import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const seed = JSON.parse(
  readFileSync(
    new URL("../../contracts/estate/seed-v2.json", import.meta.url),
    "utf8",
  ),
);

test.skip(
  !process.env.ESTATE_BROWSER_LOCAL_URL &&
    process.env.ESTATE_BROWSER_CITY_FIXTURE !== "1",
  "Run with npm run test:browser:city or a configured local Vite URL",
);

test("a failed initial testnet read offers a retry and recovers the street", async ({
  page,
}) => {
  await page.setViewportSize({ width: 667, height: 375 });
  const emptyMedia = {
    revision: 0,
    active: null,
    pending: null,
    last_decision: null,
    last_replacement_at: null,
  };
  const widths: number[] = seed.streets[0].frontageUnits.North.slice(0, 10);
  const street = {
    road_id: "main",
    side: "North",
    plots: widths.map((width, index) => ({
      plot: {
        plot: {
          id: `plot-main-n-${index}`,
          road_id: "main",
          side: "North",
          index,
          frontage_units: width,
          design_choice: 0,
          corner: index === 0 || index === widths.length - 1,
          owner: null,
          rule: { kind: "Free" },
          pending_rule: null,
          building: {
            building_type: "Retail",
            variant: 1,
            level: 1,
            primary_color: "#F6C85F",
            name: `Plot ${index + 1}`,
            approved_manifest_hash: null,
            approved_at: null,
            last_facade_approved_at: null,
            pending_appearance: null,
            last_appearance_decision: null,
            facade_exemption_level: null,
            appearance_revision: 1,
            layout_revision: 1,
          },
          logo: emptyMedia,
          billboard: emptyMedia,
          ticket_cooldown_until: 0,
          reserved_storage_bytes: 4096,
          used_storage_bytes: 0,
        },
        effective_rule: { kind: "Free" },
        logo_eligible: false,
        billboard_eligible: false,
      },
      slots: Array(width).fill(null),
      car_appearances: Array(width).fill(null),
    })),
  };
  let versionReads = 0;
  let holdNextRead = false;
  let heldReadStarted = false;
  let releaseStaleRead: (() => void) | null = null;
  await page.route("https://test.rpc.fastnear.com/**", async (route) => {
    const request = route.request().postDataJSON();
    const method = request?.params?.method_name as string;
    if (method === "city_version") {
      versionReads++;
      if (versionReads === 1)
        return route.fulfill({ status: 503, body: "Temporary RPC outage" });
      if (holdNextRead) {
        holdNextRead = false;
        heldReadStarted = true;
        await new Promise<void>((resolve) => {
          releaseStaleRead = resolve;
        });
        return route.fulfill({ status: 503, body: "Old RPC outage" });
      }
    }
    const value =
      method === "city_version"
        ? 2
        : method === "get_street_side"
          ? street
          : method === "get_tower_floor_availability"
            ? [4, 4, 4, 4]
            : method === "get_config"
              ? {}
              : undefined;
    if (value === undefined)
      return route.fulfill({ status: 500, body: `Unexpected ${method}` });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          result: [...new TextEncoder().encode(JSON.stringify(value))],
          block_hash: "test-final-block",
        },
      }),
    });
  });
  await page.goto("/");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#cross-side").click();
  await page.locator("#cross-side").click();
  await expect(page.locator("#status")).toHaveClass(/curb-feedback/);
  const mode = page.getByRole("button", { name: "Testnet", exact: true });
  const guestMode = page.getByRole("button", { name: "Guest", exact: true });
  await mode.click();
  const retry = page.getByRole("button", { name: "Retry connection" });
  await expect(retry).toBeVisible();
  await expect(page.locator("#status")).not.toHaveClass(/curb-feedback/);
  await expect(page.locator("#status")).toContainText("RPC");
  await retry.click();
  await expect.poll(() => versionReads).toBe(2);
  await expect(retry).toHaveCount(0);
  await expect(page.locator("#status")).toHaveText(
    "Viewing shared testnet street.",
  );
  await expect(page.locator("#plot-panel small")).toContainText(
    "Shared testnet state",
  );
  holdNextRead = true;
  await guestMode.click();
  await mode.click();
  await expect.poll(() => heldReadStarted).toBe(true);
  await guestMode.click();
  await mode.click();
  await expect(page.locator("#status")).toHaveText(
    "Viewing shared testnet street.",
  );
  const staleResponse = page.waitForResponse(
    (response) =>
      response.status() === 503 &&
      response.request().postDataJSON()?.params?.method_name === "city_version",
  );
  releaseStaleRead?.();
  await staleResponse;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(retry).toHaveCount(0);
  await expect(page.locator("#status")).toHaveText(
    "Viewing shared testnet street.",
  );
});
