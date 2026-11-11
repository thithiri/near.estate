import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const address = process.env.ESTATE_PACKAGED_WEB_URL ?? "http://127.0.0.1:8080";
const emptyMedia = {
  revision: 0,
  active: null,
  pending: null,
  last_decision: null,
  last_replacement_at: null,
};
const street = {
  road_id: "main",
  side: "North",
  plots: Array.from({ length: 8 }, (_, index) => ({
    plot: {
      plot: {
        id: `plot-main-n-${index}`,
        road_id: "main",
        side: "North",
        index,
        corner: index === 0 || index === 7,
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
    slots: [null, null],
  })),
};
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://test.rpc.fastnear.com/**", async (route) => {
    const body = route.request().postDataJSON();
    const method = body?.params?.method_name;
    const value = {
      get_street_side: street,
      get_tower_floor_availability: [8, 8, 8, 8],
      get_tower_floor_sessions: Array(8).fill(null),
    }[method];
    assert.notEqual(
      value,
      undefined,
      `Unexpected packaged-browser RPC: ${method}`,
    );
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          result: [...new TextEncoder().encode(JSON.stringify(value))],
          block_hash: "packaged-ci-block",
        },
      }),
    });
  });
  await page.addInitScript(() => {
    window.__estateScriptViolations = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      if (event.effectiveDirective.startsWith("script-src"))
        window.__estateScriptViolations.push({
          directive: event.violatedDirective,
          blockedUri: event.blockedURI,
          sourceFile: event.sourceFile,
          lineNumber: event.lineNumber,
          sample: event.sample,
        });
    });
  });

  const response = await page.goto(address, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "Packaged game HTML must load");
  const policy = response.headers()["content-security-policy"] ?? "";
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /unsafe-eval/);

  await page.getByRole("button", { name: "Open live testnet city" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByText("Meteor Wallet", { exact: true }).waitFor();
  const scriptViolations = await page.evaluate(
    () => window.__estateScriptViolations,
  );
  assert.deepEqual(pageErrors, [], "Packaged page raised a browser error");
  assert.deepEqual(scriptViolations, [], "CSP blocked a game script");
  console.log(
    JSON.stringify({
      packagedHtml: true,
      meteorChooser: true,
      scriptViolations,
      pageErrors,
    }),
  );
} finally {
  await browser.close();
}
