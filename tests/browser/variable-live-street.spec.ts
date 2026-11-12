import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  canonicalJson,
  validateAssetManifestV2,
  variableFrontageMediaLayout,
} from "@estate/shared";
import sharp from "sharp";

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

test("version-2 street displays approved logo and billboard in its canvas", async ({
  page,
}) => {
  const logo = await sharp({
    create: { width: 256, height: 256, channels: 4, background: "#ee3010" },
  })
    .png()
    .toBuffer();
  const billboard = await sharp({
    create: { width: 512, height: 256, channels: 4, background: "#1234ef" },
  })
    .png()
    .toBuffer();
  const logoHash = createHash("sha256").update(logo).digest("hex");
  const billboardHash = createHash("sha256").update(billboard).digest("hex");
  const customArt = await sharp({
    create: { width: 656, height: 640, channels: 4, background: "#ae6350" },
  })
    .png()
    .toBuffer();
  const customSprite = await sharp({
    create: {
      width: 680,
      height: 760,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: customArt, left: 12, top: 120 }])
    .png()
    .toBuffer();
  const customThumbnail = await sharp(customSprite)
    .resize(170, 190)
    .png()
    .toBuffer();
  const customHash = createHash("sha256").update(customSprite).digest("hex");
  const layout = variableFrontageMediaLayout(2, 1, 4);
  const customManifest = validateAssetManifestV2({
    schemaVersion: 2,
    renderProfileVersion: 2,
    frontageUnits: 2,
    designChoice: 1,
    buildingType: "Retail",
    level: 4,
    spriteHash: customHash,
    thumbnailHash: createHash("sha256").update(customThumbnail).digest("hex"),
    alphaBounds: { x: 3, y: 30, width: 164, height: 160 },
    logoRect: layout.logo,
    billboardRect: layout.billboard,
  });
  const customManifestHash = createHash("sha256")
    .update(canonicalJson(customManifest))
    .digest("hex");
  const assets = new Map([
    [logoHash, logo],
    [billboardHash, billboard],
    [customHash, customSprite],
  ]);
  const loadedAssets: string[] = [];
  await page.route("**/api/assets/*", (route) => {
    const hash = route.request().url().split("/").at(-1)!;
    const bytes = assets.get(hash);
    if (!bytes) return route.fulfill({ status: 404 });
    loadedAssets.push(hash);
    return route.fulfill({ contentType: "image/png", body: bytes });
  });
  await page.route("**/api/manifests/*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(customManifest),
    }),
  );
  const media = (hash: string) => ({
    revision: 1,
    active: {
      content: { asset_hash: hash, link: null },
      approved_layout_revision: 1,
      approved_at: 1,
    },
    pending: null,
    last_decision: null,
    last_replacement_at: 1,
  });
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
          design_choice: index === 0 ? 1 : 0,
          corner: index === 0 || index === 9,
          owner: index === 0 ? "owner.testnet" : null,
          rule: { kind: "Free" },
          pending_rule: null,
          building: {
            building_type: "Retail",
            variant: 1,
            level: index === 0 ? 4 : 1,
            primary_color: "#F6C85F",
            name: index === 0 ? "Diner" : `Plot ${index + 1}`,
            approved_manifest_hash: index === 0 ? customManifestHash : null,
            approved_at: null,
            last_facade_approved_at: null,
            pending_appearance: null,
            last_appearance_decision: null,
            facade_exemption_level: null,
            appearance_revision: 1,
            layout_revision: 1,
          },
          logo: index === 0 ? media(logoHash) : emptyMedia,
          billboard: index === 0 ? media(billboardHash) : emptyMedia,
          ticket_cooldown_until: 0,
          reserved_storage_bytes: 4096,
          used_storage_bytes: 0,
        },
        effective_rule: { kind: "Free" },
        logo_eligible: index === 0,
        billboard_eligible: index === 0,
      },
      slots: Array(width).fill(null),
      car_appearances: Array(width).fill(null),
    })),
  };
  const calls: string[] = [];
  await page.route("https://test.rpc.fastnear.com/**", async (route) => {
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
          block_hash: "test-final-block",
        },
      }),
    });
  });
  await page.goto("/");
  const modeButton = page.getByRole("button", {
    name: "Switch between guest and testnet street",
  });
  await expect(
    modeButton,
    "Start Vite with VITE_ESTATE_CONTRACT_ID for this live-street fixture",
  ).toBeVisible();
  await modeButton.click();
  await expect.poll(() => calls.includes("get_street_side")).toBe(true);
  await expect.poll(() => loadedAssets.includes(logoHash)).toBe(true);
  await expect.poll(() => loadedAssets.includes(billboardHash)).toBe(true);
  await expect.poll(() => loadedAssets.includes(customHash)).toBe(true);
  await expect(page.locator("#street-canvas canvas")).toBeVisible();
  await expect
    .poll(async () => {
      const { data, info } = await sharp(await page.screenshot())
        .raw()
        .toBuffer({ resolveWithObject: true });
      const rgb = (x: number, y: number) => {
        const offset = (y * info.width + x) * info.channels;
        return [...data.subarray(offset, offset + 3)];
      };
      return {
        facade: rgb(80, 145),
        billboard: rgb(80, 120),
        logo: rgb(60, 210),
      };
    })
    .toEqual({
      facade: [174, 99, 80],
      billboard: [18, 52, 239],
      logo: [238, 48, 16],
    });
  await page.screenshot({ path: "test-results/variable-live-street.png" });
});
