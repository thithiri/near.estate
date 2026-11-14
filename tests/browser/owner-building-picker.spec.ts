import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson, validateAssetManifest } from "@estate/shared";
import sharp from "sharp";
import { normalizedImage } from "../../services/api/src/image-upload.js";

const illustratedCatalog = JSON.parse(
  readFileSync("apps/web/src/illustrated-catalog.json", "utf8"),
) as {
  facades: Array<{
    type: string;
    variant: number;
    level: number;
    sprite: string;
    alphaBounds: { x: number; y: number; width: number; height: number };
  }>;
};

const ownerReviewPage = `<!doctype html><html><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/src/style.css">
  </head><body><main class="screen" style="padding:14px 14px 74px"><div id="host"></div></main>
  <script type="module">
    import { ChainScreen } from "/src/chain-screen.ts";
    import { choices } from "/src/frontage-art.ts";
    import { guestBuildingUrl } from "/src/guest-illustration.ts";
    const accountId = "alice.testnet";
    const query = new URLSearchParams(location.search);
    const level = query.get("level") === "4" ? 4 : 2;
    const emptyMedia = { revision: 0, active: null, pending: null, last_decision: null, last_replacement_at: null };
    const building = { building_type: "Cafe", variant: 1, level, primary_color: "#F6C85F", name: "Cafe", approved_manifest_hash: null, approved_at: null, last_facade_approved_at: null, pending_appearance: null, last_appearance_decision: null, facade_exemption_level: null, appearance_revision: 1, layout_revision: 1 };
    const plot = { plot: { id: "plot-main-n-0", road_id: "main", side: "North", index: 0, corner: true, owner: accountId, rule: { kind: "Free" }, pending_rule: null, building, logo: emptyMedia, billboard: emptyMedia, ticket_cooldown_until: 0, reserved_storage_bytes: 4096, used_storage_bytes: 0 }, effective_rule: { kind: "Free" }, logo_eligible: false, billboard_eligible: false };
    const variable = query.get("variable");
    if (variable) {
      plot.plot.frontage_units = variable === "one" ? 1 : 2;
      plot.plot.design_choice = variable === "diner" ? 1 : 0;
    }
    if (query.has("active-billboard")) {
      plot.plot.billboard = { ...emptyMedia, revision: 1, active: { content: { asset_hash: "a".repeat(64), link: null }, approved_layout_revision: 1, approved_at: 1000 } };
      plot.billboard_eligible = true;
    }
    const customNeighbour = query.has("custom-neighbour");
    const neighbor = structuredClone(plot);
    neighbor.plot.id = "plot-main-n-1";
    neighbor.plot.index = 1;
    neighbor.plot.owner = null;
    neighbor.plot.building = { ...building, building_type: "Retail", name: "Neighbor shop", approved_manifest_hash: query.get("approved-hash") };
    const candidate = { id: 1, variant: 1, palette: "#F6C85F", manifest: {}, manifestHash: "b".repeat(64), spriteHash: "c".repeat(64), thumbnailHash: "d".repeat(64), spriteUrl: "/illustrated/cafe-l2.png", thumbnailUrl: "/illustrated/cafe-l2.png" };
    const mockJob = { id: "mock-job", accountId, plotId: plot.plot.id, buildingType: "Cafe", level, layoutRevision: 1, appearanceRevision: 1, description: "A bright cafe", promptSpec: null, status: "ready", selectedCandidateId: null, proposalRevision: null, decidedAt: null, decisionReason: null, mode: "curated_mock", candidates: [candidate], createdAt: 1000 };
    if (query.has("variable-job")) {
      const units = plot.plot.frontage_units;
      const designChoice = plot.plot.design_choice;
      const choice = choices.filter((entry) => entry.units === units)[designChoice];
      const imageUrl = guestBuildingUrl(choice, level);
      const manifest = { schemaVersion: 2, renderProfileVersion: 2, frontageUnits: units, designChoice, buildingType: "Cafe", level };
      mockJob.promptSpec = { version: 5, frontageUnits: units, designChoice, buildingType: "Cafe", level };
      mockJob.candidates = [
        { ...candidate, id: 1, manifest, spriteUrl: imageUrl, thumbnailUrl: imageUrl },
        { ...candidate, id: 2, manifest, manifestHash: "e".repeat(64), spriteUrl: imageUrl, thumbnailUrl: imageUrl },
      ];
      if (query.has("stale-job")) plot.plot.design_choice = (designChoice + 1) % 5;
      if (query.has("approved-job")) {
        plot.plot.building.layout_revision = 2;
        plot.plot.building.approved_manifest_hash = candidate.manifestHash;
        plot.plot.building.last_appearance_decision = { reference: { manifest_hash: candidate.manifestHash }, status: "Approved", reason: null };
        mockJob.status = "approved";
      }
    }
    const adCalls = [];
    window.adCalls = adCalls;
    window.designCalls = [];
    window.agentCalls = [];
    window.uploadedAdBytes = [];
    const adUpload = { uploadId: "upload-1", hash: "a".repeat(64), url: "/api/assets/preview", width: 512, height: 256, status: "pending", layoutRevision: 1 };
    const adProposal = { id: "proposal-1", uploadId: adUpload.uploadId, accountId, plotId: plot.plot.id, kind: "Billboard", assetHash: adUpload.hash, link: "https://example.com/ad", buildingType: "Cafe", level, layoutRevision: 1, expectedMediaRevision: 0, proposalRevision: null, status: "selected", decidedAt: null, decisionReason: null, createdAt: 1, assetUrl: adUpload.url };
    const adWallet = {
      accountId,
      hasPendingGameplayAction: () => false,
      uploadMedia: async (plotId, kind, file) => { const image = await createImageBitmap(file); adCalls.push(["upload", plotId, kind, image.width + "x" + image.height]); image.close(); window.uploadedAdBytes = [...new Uint8Array(await file.arrayBuffer())]; return adUpload; },
      createMediaProposal: async (_upload, plotId, kind, link) => { adCalls.push(["prepare", plotId, kind, link]); return adProposal; },
      submitMediaProposal: async (proposal) => { adCalls.push(["wallet", proposal.id]); return { ...proposal, status: "submitted" }; },
    };
    const agentWallet = {
      accountId,
      hasPendingGameplayAction: () => false,
      addParkingAgentKey: async (publicKey) => {
        window.agentCalls.push(["add", publicKey]);
        screen.parkingAgentStatus = { state: "ready", publicKey, allowance: "50000000000000000000000" };
        return screen.parkingAgentStatus;
      },
      revokeParkingAgentKey: async () => {
        window.agentCalls.push(["revoke"]);
        screen.parkingAgentStatus = { state: "none", publicKey: null, allowance: null };
        return screen.parkingAgentStatus;
      },
    };
    const screen = new ChainScreen(document.querySelector("#host"), {}, () => ({ roadId: "main", side: "North" }), [], async () => ({}));
    Object.assign(screen, {
      visible: true,
      wallet: query.has("ad-flow") ? adWallet : query.has("agent-flow") ? agentWallet : { accountId, hasPendingGameplayAction: () => false, chooseDesign: async (plotId, index) => { window.designCalls.push([plotId, index]); } },
      player: { account_id: accountId, account: { balance: "100000000", active_session_id: null, last_emergency_repair_at: null }, cars: [], active_session: null },
      plots: customNeighbour ? [plot, neighbor] : [plot],
      mockJob: customNeighbour || query.has("variable-job") ? mockJob : null,
      paidAvailable: query.has("paid"),
      ownerConfig: { version: 1, park_durability_cost: 5, max_durability: 100, repair_cost_per_point: "1000000", emergency_repair_cooldown_seconds: 3600, meter_rate_max_per_hour: "20000000", rule_delay_seconds: 3600, change_building_type_cost: "50000000", building_upgrade_costs: ["100000000", "200000000", "300000000"] },
      selectedOwnedPlotId: "plot-main-n-0",
      ownerDraft: { plotId: "plot-main-n-0", ruleKind: "Free", meterRate: "5", color: "Red", buildingType: "Cafe", variant: 1, palette: "#F6C85F", name: "Cafe" },
    });
    if (query.has("ad-flow") || query.has("design-preview") || query.has("agent-flow")) screen.refresh = async () => screen.render();
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

test("owner can authorize and revoke a separate parking-agent key", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/__owner_type_review?agent-flow", (route) =>
    route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
  );
  await page.goto("/__owner_type_review?agent-flow");
  await expect(page.locator(".chain-parking-agent")).toContainText(
    "It cannot buy, repair, upgrade, ticket, or change your plots.",
  );
  await page
    .locator("#parking-agent-public-key")
    .fill("ed25519:ExamplePublicKey");
  await page.locator("#parking-agent-add").click();
  await expect(page.locator(".chain-parking-agent")).toContainText(
    "Ready to run",
  );
  await expect(page.locator(".chain-parking-agent")).toContainText(
    "0.05 testnet NEAR gas allowance left",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator("#parking-agent-revoke").click();
  await expect(page.locator(".chain-parking-agent")).toContainText("Off");
  expect(await page.evaluate(() => window.agentCalls)).toEqual([
    ["add", "ed25519:ExamplePublicKey"],
    ["revoke"],
  ]);
});

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

test("owner design comparison uses verified approved neighbor art", async ({
  page,
}) => {
  const art = illustratedCatalog.facades.find(
    (entry) =>
      entry.type === "retail" && entry.variant === 1 && entry.level === 2,
  )!;
  const png = readFileSync(`apps/web/public/illustrated/${art.sprite}`);
  const thumbnailHash = createHash("sha256").update(png).digest("hex");
  const manifest = validateAssetManifest({
    schemaVersion: 1,
    renderProfileVersion: 1,
    buildingType: "Retail",
    level: 2,
    spriteHash: "a".repeat(64),
    thumbnailHash,
    alphaBounds: art.alphaBounds,
    logoRect: null,
    billboardRect: null,
  });
  const approvedHash = createHash("sha256")
    .update(canonicalJson(manifest))
    .digest("hex");
  await page.route("**/__owner_type_review**", (route) =>
    route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
  );
  await page.route(`**/api/manifests/${approvedHash}`, (route) =>
    route.fulfill({ json: manifest }),
  );
  await page.route(`**/api/assets/${thumbnailHash}`, (route) =>
    route.fulfill({ contentType: "image/png", body: png }),
  );
  await page.goto(
    `/__owner_type_review?custom-neighbour&approved-hash=${approvedHash}`,
  );
  const neighbor = page.locator(`[data-approved-neighbour="${approvedHash}"]`);
  await expect(neighbor).toContainText("Neighbor shop");
  await expect(neighbor.locator("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await expect(neighbor.locator(".owner-neighbour-status")).toHaveCount(0);
});

test("version-2 owner controls offer logos and only supported billboard surfaces", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("**/__owner_type_review**", (route) =>
    route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
  );
  await page.goto("/__owner_type_review?level=4&variable=one");
  await expect(page.locator("[data-owner-design]")).toHaveCount(5);
  await expect(page.locator(".owner-variable-preview img")).toHaveAttribute(
    "alt",
    "News kiosk at level 4",
  );
  expect(
    await page
      .locator(".owner-variable-preview img")
      .evaluate(async (image) => {
        await (image as HTMLImageElement).decode();
        return (image as HTMLImageElement).naturalWidth;
      }),
  ).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await expect(page.locator(".owner-building-preview")).toHaveCount(0);
  await expect(page.locator(".owner-shape-card")).toHaveCount(0);
  await expect(page.locator("#owner-variable-building-type")).toHaveValue(
    "Cafe",
  );
  await page.locator("#owner-variable-building-type").selectOption("Office");
  await expect(page.locator("#owner-change-type")).toHaveText(
    "Change to Office · 50 coins",
  );
  await expect(page.locator(".owner-variable-preview img")).toHaveAttribute(
    "alt",
    "News kiosk at level 4",
  );
  await expect(page.locator("#owner-logo-file")).toBeVisible();
  await expect(page.locator("#owner-ad-file")).toHaveCount(0);
  await expect(page.locator(".owner-media")).toContainText(
    "no billboard surface",
  );

  await page.goto("/__owner_type_review?level=4&variable=diner");
  await expect(page.locator("[data-owner-design]")).toHaveCount(5);
  await expect(page.locator(".owner-variable-preview img")).toHaveAttribute(
    "alt",
    "Diner at level 4",
  );
  await expect(page.locator("#owner-logo-file")).toBeVisible();
  await expect(page.locator("#owner-ad-file")).toBeVisible();
  await expect(page.locator("#owner-upload-ad")).toBeVisible();
});

test("owner compares a fitting design beside the plot before applying it", async ({
  page,
}) => {
  await page.route("**/__owner_type_review**", (route) =>
    route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
  );
  await page.goto(
    "/__owner_type_review?variable=one&custom-neighbour&design-preview",
  );
  await expect(page.locator(".design-street-building")).toHaveCount(2);
  await expect(
    page.locator(".design-street-building.is-selected"),
  ).toContainText("1U");
  await expect(page.locator(".design-preview-stall")).toHaveCount(2);
  await expect(page.locator(".design-preview-sign")).toHaveCount(2);
  await expect(page.locator("#owner-apply-design")).toBeDisabled();
  await page.locator('[data-owner-design="1"]').click();
  await expect(
    page.locator(".design-street-building.is-selected img"),
  ).toHaveAttribute("alt", "Coffee pod on plot 1");
  expect(await page.evaluate(() => (window as any).designCalls)).toEqual([]);
  await page.locator('[data-owner-preview-level="4"]').click();
  await expect(
    page.locator(".design-street-building.is-selected"),
  ).toContainText("LV 4");
  await expect(page.locator("#owner-apply-design")).toBeDisabled();
  await page.locator('[data-owner-preview-level="2"]').click();
  await expect(page.locator("#owner-apply-design")).toBeEnabled();
  await page.locator("#owner-apply-design").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).designCalls))
    .toEqual([["plot-main-n-0", 1]]);
});

test("owner previews the real ad crop and submits its image, link and wallet proposal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("**/__owner_type_review**", (route) =>
    route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
  );
  await page.goto("/__owner_type_review?level=4&variable=diner&ad-flow");
  const image = await sharp({
    create: { width: 100, height: 200, channels: 4, background: "#d64537" },
  })
    .png()
    .toBuffer();
  await page.locator("#owner-ad-file").setInputFiles({
    name: "banner.png",
    mimeType: "image/png",
    buffer: image,
  });
  const preview = page.locator("#owner-ad-local-preview");
  await expect(preview).toBeVisible();
  await expect(page.locator("#owner-ad-fill")).toBeChecked();
  const bounds = await preview.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width / bounds!.height).toBeCloseTo(88 / 20, 1);
  const previewPixels = await preview.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return {
      leftAlpha: context.getImageData(10, 80, 1, 1).data[3],
      centerRed: context.getImageData(352, 80, 1, 1).data[0],
    };
  });
  expect(previewPixels.leftAlpha).toBe(255);
  expect(previewPixels.centerRed).toBe(214);
  if (process.env.ESTATE_CAPTURE_VISUAL === "1") {
    const banner = await sharp(
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="880" height="200" viewBox="0 0 880 200">
        <rect width="880" height="200" fill="#e64437"/>
        <rect x="0" y="0" width="880" height="18" fill="#ffcf5c"/>
        <text x="440" y="103" text-anchor="middle" font-family="Arial, sans-serif" font-size="70" font-weight="800" fill="#fff7e8">NEAR &amp; FAR</text>
        <text x="440" y="158" text-anchor="middle" font-family="Arial, sans-serif" font-size="36" font-weight="700" fill="#fff7e8">BURGERS · OPEN LATE</text>
      </svg>`),
    )
      .png()
      .toBuffer();
    await page.locator("#owner-ad-file").setInputFiles({
      name: "near-and-far.png",
      mimeType: "image/png",
      buffer: banner,
    });
    await expect(preview).toBeVisible();
    await page.locator(".owner-media").screenshot({
      path: "docs/images/near-estate-owner-ad-form-v1.png",
    });
  }
  await page.locator("#owner-ad-link").fill("https://example.com/ad");
  await page.locator("#owner-upload-ad").click();
  await expect(page.locator("#host")).toContainText(
    "Ad submitted on testnet and awaiting review",
  );
  expect(
    await page.evaluate(
      () => (window as typeof window & { adCalls: string[][] }).adCalls,
    ),
  ).toEqual([
    ["upload", "plot-main-n-0", "Billboard", "512x121"],
    ["prepare", "plot-main-n-0", "Billboard", "https://example.com/ad"],
    ["wallet", "proposal-1"],
  ]);
  const uploadedBytes = await page.evaluate(
    () =>
      (window as typeof window & { uploadedAdBytes: number[] }).uploadedAdBytes,
  );
  const stored = await normalizedImage(
    new File([Uint8Array.from(uploadedBytes)], "billboard-crop.png", {
      type: "image/png",
    }),
    "Billboard",
  );
  const displayed = await sharp(stored)
    .resize(88, 20, { fit: "cover" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  expect(displayed[3]).toBe(255);
  expect(displayed[(10 * 88 + 44) * 4 + 3]).toBe(255);
  await expect(page.locator("#owner-create-media")).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});

test("owner can keep the whole ad instead of filling the sign", async ({
  page,
}) => {
  await page.route("**/__owner_type_review**", (route) =>
    route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
  );
  await page.goto("/__owner_type_review?level=4&variable=diner&ad-flow");
  const image = await sharp({
    create: { width: 100, height: 200, channels: 4, background: "#d64537" },
  })
    .png()
    .toBuffer();
  await page.locator("#owner-ad-file").setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: image,
  });
  await page.locator("#owner-ad-fill").uncheck();
  const preview = page.locator("#owner-ad-local-preview");
  await expect(preview).toBeVisible();
  const leftAlpha = await preview.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return context.getImageData(10, 80, 1, 1).data[3];
  });
  expect(leftAlpha).toBe(0);
  await page.locator("#owner-upload-ad").click();
  await expect(page.locator("#host")).toContainText(
    "Ad submitted on testnet and awaiting review",
  );
  const calls = await page.evaluate(
    () => (window as typeof window & { adCalls: string[][] }).adCalls,
  );
  expect(calls[0]).toEqual(["upload", "plot-main-n-0", "Billboard", "100x200"]);
});

test("legacy billboard preview uses its wider storefront sign ratio", async ({
  page,
}) => {
  await page.route("**/__owner_type_review**", (route) =>
    route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
  );
  await page.goto("/__owner_type_review?level=4");
  const image = await sharp({
    create: { width: 100, height: 200, channels: 4, background: "#d64537" },
  })
    .png()
    .toBuffer();
  await page.locator("#owner-ad-file").setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: image,
  });
  const preview = page.locator("#owner-ad-local-preview");
  await expect(preview).toBeVisible();
  const bounds = await preview.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width / bounds!.height).toBeCloseTo(2, 1);
});

test("version-2 prompt entry fits a narrow owner editor when the invite pilot is enabled", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("**/__owner_type_review**", (route) =>
    route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
  );
  await page.goto("/__owner_type_review?variable=diner&paid");
  await expect(page.locator("#owner-generate-paid")).toBeDisabled();
  await expect(page.locator("#owner-use-prior-art")).toBeVisible();
  await page
    .locator("#owner-mock-description")
    .fill("A warm diner with copper details");
  await expect(page.locator("#owner-generate-paid")).toBeEnabled();
  await expect(page.locator("#owner-restore-paid")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});

test("carried old billboard is not labeled visible without a version-2 surface", async ({
  page,
}) => {
  await page.route("**/__owner_type_review**", (route) =>
    route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
  );
  await page.goto("/__owner_type_review?variable=diner&active-billboard");
  const billboard = page
    .locator(".owner-media-status")
    .filter({ has: page.locator("strong", { hasText: "Billboard" }) });
  await expect(billboard).toContainText("No billboard surface on this design");
  await expect(billboard).not.toContainText("Visible on this building");
  await expect(billboard.locator("[data-owner-reuse-media]")).toHaveCount(0);
  await expect(page.locator("#owner-upload-ad")).toHaveCount(0);
  await expect(
    billboard.locator('[data-owner-remove-media="Billboard"]'),
  ).toBeVisible();
});

test("version-2 owner can inspect an existing width-bound facade job", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("**/__owner_type_review**", (route) =>
    route.fulfill({ contentType: "text/html", body: ownerReviewPage }),
  );
  await page.goto("/__owner_type_review?level=4&variable=one&variable-job");
  await expect(page.locator(".owner-variable-review")).toContainText(
    "News kiosk · level 4",
  );
  await expect(page.locator(".owner-variable-candidates button")).toHaveCount(
    2,
  );
  await expect(page.locator("#owner-submit-mock")).toBeEnabled();
  const preview = page.locator(".owner-variable-review-preview img");
  await expect(preview).toHaveAttribute("width", "85");
  expect(
    await preview.evaluate(async (image) => {
      await (image as HTMLImageElement).decode();
      return (image as HTMLImageElement).naturalWidth;
    }),
  ).toBeGreaterThan(0);
  await page.locator('[data-owner-candidate="1"]').click();
  await expect(page.locator('[data-owner-candidate="1"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#owner-variable-building-type")).toHaveValue(
    "Cafe",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);

  await page.goto(
    "/__owner_type_review?level=4&variable=one&variable-job&stale-job",
  );
  await expect(page.locator(".owner-variable-review")).toContainText(
    "does not match the plot's current width, design, category or level",
  );
  await expect(page.locator(".owner-variable-review-preview")).toHaveCount(0);
  await expect(page.locator("#owner-submit-mock")).toHaveCount(0);

  await page.goto(
    "/__owner_type_review?level=4&variable=one&variable-job&approved-job",
  );
  await expect(
    page.locator(".owner-variable-review-preview img"),
  ).toBeVisible();
  await expect(page.locator(".owner-variable-review")).toContainText(
    "approved for the current building",
  );
  await expect(page.locator("#owner-submit-mock")).toHaveCount(0);
});
