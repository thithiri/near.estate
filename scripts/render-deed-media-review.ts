import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  FRONTAGE_DESIGN_IDS_V2,
  canonicalJson,
  validateAssetManifest,
  variableFrontageMediaLayout,
} from "@estate/shared";
import { composeFacadePreview } from "../services/api/src/moderation-preview.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const inventory = JSON.parse(
  await readFile(
    `${root}deployments/variable-city-readiness-current-2026-11-12.json`,
    "utf8",
  ),
) as {
  ownedPlots: Array<{
    id: string;
    building: {
      level: number;
      approved_manifest_hash: string | null;
      name: string;
    };
    logo: { active: { content: { asset_hash: string } } | null };
    billboard: { active: { content: { asset_hash: string } } | null };
  }>;
};
const rehearsal = JSON.parse(
  await readFile(
    `${root}deployments/variable-city-sandbox-rehearsal-2026-11-12.json`,
    "utf8",
  ),
) as {
  runtimeCarriedLogosEligibleVerified: boolean;
  runtimeCarriedLogoCount: number;
  runtimeCarriedBillboardHiddenVerified: boolean;
};
const catalog = JSON.parse(
  await readFile(`${root}apps/web/src/guest-illustrations.json`, "utf8"),
) as {
  buildings: Array<{
    id: string;
    level: number;
    sprite: string;
    sha256: string;
  }>;
};
const main = inventory.ownedPlots.find((plot) => plot.id === "plot-main-n-2");
if (
  !main ||
  main.building.level !== 2 ||
  !main.logo.active ||
  !main.billboard.active ||
  !main.building.approved_manifest_hash ||
  !rehearsal.runtimeCarriedLogosEligibleVerified ||
  rehearsal.runtimeCarriedLogoCount !== 1 ||
  !rehearsal.runtimeCarriedBillboardHiddenVerified
)
  throw new Error("Pinned owner media or sandbox visibility evidence changed");

// These are the two testnet fixture uploads in testnet-media-api-journey.ts.
// Their processed hashes are checked against the pinned on-chain inventory below.
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="44" fill="#173F5F"/><path d="M28 184h200" stroke="#FFD166" stroke-width="13"/><text x="128" y="145" text-anchor="middle" font-family="Arial,sans-serif" font-size="100" font-weight="bold" fill="white">NE</text></svg>`;
const billboardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="256" viewBox="0 0 512 256"><rect width="512" height="256" rx="24" fill="#F6C85F"/><circle cx="90" cy="128" r="62" fill="#B45131"/><path d="M42 128h96" stroke="#73D9A6" stroke-width="16"/><text x="180" y="112" font-family="Arial,sans-serif" font-size="44" font-weight="bold" fill="#173F5F">NEAR &amp; FAR</text><text x="180" y="165" font-family="Arial,sans-serif" font-size="38" fill="#173F5F">BURGERS</text></svg>`;
async function processed(source: string, width: number): Promise<Buffer> {
  const png = await sharp(Buffer.from(source)).png().toBuffer();
  return sharp(png)
    .rotate()
    .resize(width, 256, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .toColourspace("srgb")
    .png({ compressionLevel: 9 })
    .toBuffer();
}
const [logo, billboard] = await Promise.all([
  processed(logoSvg, 256),
  processed(billboardSvg, 512),
]);
for (const [label, bytes, hash] of [
  ["logo", logo, main.logo.active.content.asset_hash],
  ["billboard", billboard, main.billboard.active.content.asset_hash],
] as const) {
  if (createHash("sha256").update(bytes).digest("hex") !== hash)
    throw new Error(
      `Pinned ${label} image no longer matches the source fixture`,
    );
}
const oldManifest = validateAssetManifest(
  JSON.parse(
    await readFile(
      `${root}docs/review-data/near-garden-v1-manifest.json`,
      "utf8",
    ),
  ),
);
if (
  createHash("sha256").update(canonicalJson(oldManifest)).digest("hex") !==
  main.building.approved_manifest_hash
)
  throw new Error("Saved V1 facade manifest differs from the on-chain hash");
const oldThumbnail = await readFile(
  `${root}docs/images/near-estate-approved-v1-near-garden-thumbnail.png`,
);
if (
  createHash("sha256").update(oldThumbnail).digest("hex") !==
  oldManifest.thumbnailHash
)
  throw new Error("Saved V1 facade thumbnail differs from its public hash");
const oldPreview = await composeFacadePreview({
  thumbnail: oldThumbnail,
  manifest: oldManifest,
  logo,
  billboard,
});

const designChoice = (3 * 2) % 5; // Main, North, target index 3.
const designId = FRONTAGE_DESIGN_IDS_V2[2][designChoice];
if (designId !== "diner") throw new Error("The destination design changed");
const art = catalog.buildings.find(
  (item) => item.id === designId && item.level === 2,
);
if (!art) throw new Error("Missing destination Diner art");
const artBytes = await readFile(
  `${root}apps/web/public/guest-buildings/${art.sprite}`,
);
if (createHash("sha256").update(artBytes).digest("hex") !== art.sha256)
  throw new Error("Destination Diner art changed");
const layout = variableFrontageMediaLayout(2, designChoice, 2);
if (layout.billboard)
  throw new Error("Destination unexpectedly displays a billboard");

const width = 1400;
const height = 860;
const dinerLeft = 625;
const dinerTop = 150;
const scale = 3;
const logoRect = {
  left: Math.round(dinerLeft + (layout.logo.x + 1) * scale),
  top: Math.round(dinerTop + (layout.logo.y + 1) * scale),
  width: Math.round((layout.logo.width - 2) * scale),
  height: Math.round((layout.logo.height - 2) * scale),
};
const background =
  Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#e8f0ef"/>
  <rect width="${width}" height="80" fill="#153a52"/>
  <text x="36" y="51" fill="#fffaf0" font-family="Arial,sans-serif" font-size="29" font-weight="800">near.estate · owned deed media review</text>
  <rect x="28" y="105" width="540" height="720" rx="18" fill="#fffaf0" stroke="#c5d3d0" stroke-width="2"/>
  <rect x="590" y="105" width="782" height="720" rx="18" fill="#fffaf0" stroke="#c5d3d0" stroke-width="2"/>
  <text x="50" y="148" fill="#153a52" font-family="Arial,sans-serif" font-size="23" font-weight="800">CURRENT · MAIN NORTH PLOT 2</text>
  <text x="50" y="180" fill="#536f7b" font-family="Arial,sans-serif" font-size="17">Approved V1 facade, logo and billboard · exact pixels</text>
  <text x="50" y="215" fill="#153a52" font-family="Arial,sans-serif" font-size="18" font-weight="700">Near Garden</text>
  <text x="50" y="766" fill="#536f7b" font-family="Arial,sans-serif" font-size="17">V1 facade and media remain stored on the moved deed.</text>
  <text x="50" y="794" fill="#536f7b" font-family="Arial,sans-serif" font-size="17">Only the logo would still display at level 2.</text>
  <text x="615" y="148" fill="#153a52" font-family="Arial,sans-serif" font-size="23" font-weight="800">PROPOSED · MAIN NORTH PLOT 3</text>
  <text x="615" y="180" fill="#536f7b" font-family="Arial,sans-serif" font-size="17">Two-unit Diner, level 2 · illustrated fallback with carried logo</text>
  <rect x="${dinerLeft}" y="${dinerTop + 570}" width="510" height="5" fill="#b2aaa0"/>
  <rect x="1158" y="250" width="188" height="45" rx="9" fill="#d9efe6"/>
  <text x="1175" y="279" fill="#176b58" font-family="Arial,sans-serif" font-size="19" font-weight="800">LOGO VISIBLE</text>
  <rect x="1158" y="318" width="188" height="45" rx="9" fill="#f8e6d7"/>
  <text x="1172" y="347" fill="#a25d32" font-family="Arial,sans-serif" font-size="18" font-weight="800">BILLBOARD HIDDEN</text>
  <text x="1158" y="391" fill="#536f7b" font-family="Arial,sans-serif" font-size="15">Level 3 is required</text>
  <text x="1158" y="417" fill="#536f7b" font-family="Arial,sans-serif" font-size="15">for this sign.</text>
  <text x="615" y="794" fill="#536f7b" font-family="Arial,sans-serif" font-size="16">Review image only · no testnet deed or artwork changed</text>
</svg>`);
const image = await sharp(background)
  .composite([
    {
      input: await sharp(oldPreview).resize(420, 480).png().toBuffer(),
      left: 88,
      top: 240,
    },
    {
      input: await sharp(artBytes).resize(510, 570).png().toBuffer(),
      left: dinerLeft,
      top: dinerTop,
    },
    {
      input: await sharp(logo)
        .resize(logoRect.width, logoRect.height)
        .png()
        .toBuffer(),
      left: logoRect.left,
      top: logoRect.top,
    },
  ])
  .png()
  .toBuffer();
const destination = `${root}docs/images/near-estate-deed-media-review-v1.png`;
if (process.argv.includes("--check")) {
  if (!(await readFile(destination)).equals(image))
    throw new Error("Deed media review image drifted");
  console.log("Deed media review matches pinned state and art");
} else {
  await writeFile(destination, image);
  console.log(destination);
}
