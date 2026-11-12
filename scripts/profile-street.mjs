import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const url = process.env.ESTATE_PROFILE_URL ?? "http://127.0.0.1:5173/";
const outputIndex = process.argv.indexOf("--out");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
if (outputIndex >= 0 && !output)
  throw new Error("Pass an output path after --out");
const travelIndex = process.argv.indexOf("--travel-cycles");
const travelCycles =
  travelIndex >= 0 ? Number(process.argv[travelIndex + 1]) : 0;
if (
  !Number.isSafeInteger(travelCycles) ||
  travelCycles < 0 ||
  travelCycles > 20
)
  throw new Error("Pass 0–20 whole cycles after --travel-cycles");
if (!/^https?:\/\//.test(url))
  throw new Error("ESTATE_PROFILE_URL must be an HTTP URL");

async function guestTextureStats(page) {
  return page.evaluate(() => window.__nearEstateGuestTextureStats?.() ?? null);
}

async function travelCity(page, cycles) {
  const roads = ["main", "market", "river", "central", "harbor"];
  const failedImages = [];
  page.on("response", (response) => {
    if (response.url().includes("/guest-buildings/") && !response.ok())
      failedImages.push(`${response.status()} ${response.url()}`);
  });
  const snapshots = [];
  const started = performance.now();
  for (let cycle = 1; cycle <= cycles; cycle++) {
    for (const road of roads) {
      await page.locator('[data-screen="Map"]:visible').first().click();
      await page.locator(`button[data-road="${road}"]`).click();
      await page.waitForFunction(
        () => (window.__nearEstateGuestTextureStats?.().loadedImages ?? 0) > 0,
      );
      await page.locator("#cross-side").click();
      await page.waitForFunction(
        () => (window.__nearEstateGuestTextureStats?.().loadedImages ?? 0) > 0,
      );
      const textures = await guestTextureStats(page);
      if (!textures || textures.cachedImages > 32)
        throw new Error(`Street cache exceeded its budget on ${road}`);
      snapshots.push({ cycle, road, ...textures });
    }
  }
  return {
    cycles,
    streetVisits: snapshots.length,
    curbViews: snapshots.length * 2,
    elapsedSeconds: Math.round((performance.now() - started) / 1000),
    peakCachedImages: Math.max(...snapshots.map((item) => item.cachedImages)),
    peakEstimatedDecodedBytes: Math.max(
      ...snapshots.map((item) => item.estimatedDecodedBytes),
    ),
    finalTextures: snapshots.at(-1),
    failedImages,
    jsHeapMiB: await page.evaluate(() =>
      performance.memory
        ? Math.round(performance.memory.usedJSHeapSize / 1_048_576)
        : null,
    ),
  };
}

const browser = await chromium.launch({ headless: true });
const browserVersion = browser.version();
const viewports = [];
let renderer = "unknown";
try {
  for (const { width, height } of [
    { width: 1366, height: 768 },
    { width: 667, height: 375 },
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await page.goto(url, { waitUntil: "networkidle" });
      await page.locator("#street-canvas canvas").waitFor();
      await page.waitForTimeout(500);
      if (renderer === "unknown") {
        renderer = await page.evaluate(() => {
          const canvas = document.querySelector("#street-canvas canvas");
          const gl =
            canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
          const info = gl?.getExtension("WEBGL_debug_renderer_info");
          return info
            ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
            : "unavailable";
        });
      }
      await page.keyboard.down("ArrowRight");
      const sample = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const frameTimes = [];
            const started = performance.now();
            let previous = started;
            const tick = (now) => {
              frameTimes.push(now - previous);
              previous = now;
              if (now - started < 8_000) requestAnimationFrame(tick);
              else {
                frameTimes.sort((a, b) => a - b);
                const at = (fraction) =>
                  Math.round(
                    frameTimes[Math.ceil(frameTimes.length * fraction) - 1] *
                      10,
                  ) / 10;
                resolve({
                  sampledFrames: frameTimes.length,
                  framesPerSecond: Math.round(
                    (frameTimes.length * 1_000) / (now - started),
                  ),
                  medianFrameMs: at(0.5),
                  p95FrameMs: at(0.95),
                  jsHeapMiB: performance.memory
                    ? Math.round(performance.memory.usedJSHeapSize / 1_048_576)
                    : null,
                });
              }
            };
            requestAnimationFrame(tick);
          }),
      );
      await page.keyboard.up("ArrowRight");
      if (pageErrors.length)
        throw new Error(`Street page errors: ${pageErrors.join("; ")}`);
      const guestTextures = await guestTextureStats(page);
      const travel =
        travelCycles > 0 && width === 667
          ? await travelCity(page, travelCycles)
          : null;
      if (pageErrors.length)
        throw new Error(`Street page errors: ${pageErrors.join("; ")}`);
      viewports.push({
        widthCssPx: width,
        heightCssPx: height,
        ...sample,
        guestTextures,
        ...(travel ? { travel } : {}),
      });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

const report = {
  capturedAt: new Date().toISOString(),
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  workingTreeDirty: Boolean(
    execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
  ),
  scene: "guest Main Street, North side, ArrowRight held for eight seconds",
  browser: `Headless Chromium ${browserVersion} on ${process.platform}`,
  renderer,
  method:
    "Headless desktop Chromium viewport emulation; requestAnimationFrame intervals, page JavaScript heap and the development facade-cache estimate; optional repeated map and curb travel",
  viewports,
  limits:
    "The cache estimate counts loaded facade pixel area, not physical GPU allocation. Even repeated travel here is not a physical phone, GPU-memory measurement or live testnet street.",
};
if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
