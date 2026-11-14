import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ChainPlotV2, validateAssetManifestV2 } from "@estate/shared";
import sharp from "sharp";

const root = new URL("../../", import.meta.url);
const seed = JSON.parse(
  readFileSync(new URL("contracts/estate/seed-v2.json", root), "utf8"),
);
const rehearsal = JSON.parse(
  readFileSync(
    new URL(
      "deployments/variable-city-contract-media-fixture-2026-11-12.json",
      root,
    ),
    "utf8",
  ),
) as { plotId: string; logoHash: string; logoApprovedPlot: unknown };
const fixture = JSON.parse(
  readFileSync(
    new URL("tests/fixtures/variable-city-media/fixture.json", root),
    "utf8",
  ),
) as {
  manifest: unknown;
  manifestHash: string;
  spriteHash: string;
  logoHash: string;
};

test.skip(
  !process.env.ESTATE_BROWSER_LOCAL_URL &&
    process.env.ESTATE_BROWSER_CITY_FIXTURE !== "1",
  "Run with npm run test:browser:city or a configured local Vite URL",
);

test("sandbox-approved three-unit facade and logo render on the playable street", async ({
  page,
}) => {
  const approved = ChainPlotV2.parse(rehearsal.logoApprovedPlot);
  const manifest = validateAssetManifestV2(fixture.manifest);
  expect(approved.plot.id).toBe(rehearsal.plotId);
  expect(approved.plot.building.approved_manifest_hash).toBe(
    fixture.manifestHash,
  );
  expect(approved.plot.logo.active?.content.asset_hash).toBe(fixture.logoHash);
  expect(rehearsal.logoHash).toBe(fixture.logoHash);
  expect(approved.logo_eligible).toBe(true);
  const assets = new Map(
    [fixture.spriteHash, fixture.logoHash].map((hash) => {
      const bytes = readFileSync(
        new URL(`tests/fixtures/variable-city-media/${hash}.png`, root),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
      return [hash, bytes] as const;
    }),
  );
  const loadedAssets: string[] = [];
  await page.route("**/api/assets/*", (route) => {
    const hash = route.request().url().split("/").at(-1)!;
    const bytes = assets.get(hash);
    if (!bytes) return route.fulfill({ status: 404 });
    loadedAssets.push(hash);
    return route.fulfill({ contentType: "image/png", body: bytes });
  });
  await page.route("**/api/manifests/*", (route) => {
    expect(route.request().url()).toContain(fixture.manifestHash);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(manifest),
    });
  });
  const widths: number[] = seed.streets[0].frontageUnits.North.slice(0, 10);
  const street = {
    road_id: "main",
    side: "North",
    plots: widths.map((width, index) => {
      const plot = structuredClone(approved);
      if (index !== approved.plot.index) {
        plot.plot.id = `plot-main-n-${index}`;
        plot.plot.index = index;
        plot.plot.frontage_units = width as 1 | 2 | 3;
        plot.plot.owner = null;
        plot.plot.building.level = 1;
        plot.plot.building.approved_manifest_hash = null;
        plot.plot.logo.active = null;
        plot.logo_eligible = false;
      }
      return {
        plot,
        slots: Array(width).fill(null),
        car_appearances: Array(width).fill(null),
      };
    }),
  };
  expect(widths[approved.plot.index]).toBe(3);
  const calls: string[] = [];
  await page.route("https://test.rpc.fastnear.com/**", (route) => {
    const request = route.request().postDataJSON();
    if (
      request?.method !== "query" ||
      request.params?.request_type !== "call_function"
    )
      return route.fulfill({ status: 500, body: "Unexpected RPC request" });
    const method = request.params.method_name as string;
    calls.push(method);
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
          block_hash: "sandbox-fixture-block",
        },
      }),
    });
  });
  await page.goto(`/?preview-plot=${rehearsal.plotId}`);
  const modeButton = page.getByRole("button", {
    name: "Testnet",
    exact: true,
  });
  await expect(
    modeButton,
    "Start Vite with VITE_ESTATE_CONTRACT_ID for this live-street fixture",
  ).toBeVisible();
  await modeButton.click();
  await expect.poll(() => calls.includes("get_street_side")).toBe(true);
  await expect.poll(() => loadedAssets.includes(fixture.spriteHash)).toBe(true);
  await expect.poll(() => loadedAssets.includes(fixture.logoHash)).toBe(true);
  await expect(page.locator("#street-canvas canvas")).toBeVisible();
  await expect(page.locator("#plot-title")).toContainText("Harbor Studio");
  const screenshot = await page.screenshot({
    path: "test-results/sandbox-approved-street.png",
  });
  const logoCenter = await sharp(assets.get(fixture.logoHash)!)
    .extract({ left: 128, top: 128, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  const streetLogoCenter = await sharp(screenshot)
    .extract({ left: 282, top: 213, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  expect(streetLogoCenter).toEqual(logoCenter);
});
