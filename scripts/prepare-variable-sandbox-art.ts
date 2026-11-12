import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { normalizedImage } from "../services/api/src/image-upload.js";
import { buildVariableGenerationPrompt } from "../services/api/src/variable-prompt-builder.js";
import { normalizeVariableGeneratedFacade } from "../services/api/src/variable-generated-art.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = "apps/web/public/guest-buildings/market-hall-l2.png";
const fixtureDir = join(root, "tests/fixtures/variable-city-media");
const manifestPath = join(fixtureDir, "fixture.json");
const check = process.argv.includes("--check");

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const source = await readFile(join(root, sourcePath));
const catalog = JSON.parse(
  await readFile(join(root, "apps/web/src/guest-illustrations.json"), "utf8"),
) as {
  buildings: Array<{
    id: string;
    level: number;
    sprite: string;
    sha256: string;
  }>;
};
const entry = catalog.buildings.find(
  (building) => building.id === "market-hall" && building.level === 2,
);
if (
  !entry ||
  entry.sprite !== "market-hall-l2.png" ||
  entry.sha256 !== hash(source)
)
  throw new Error(
    "Sandbox art source differs from the validated guest catalog",
  );

const art = await normalizeVariableGeneratedFacade(source, {
  frontageUnits: 3,
  designChoice: 0,
  buildingType: "Retail",
  level: 2,
});
const promptSpec = buildVariableGenerationPrompt({
  frontageUnits: 3,
  designChoice: 0,
  buildingType: "Retail",
  level: 2,
  palette: "#EF8270",
  description: "Warm market windows and copper trim",
});
const logoSource = await sharp(
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect x="12" y="12" width="488" height="488" rx="104" fill="#19314b"/>
    <circle cx="256" cy="256" r="186" fill="#fff4d7"/>
    <path d="M150 142v228M362 142v228M150 256h212" stroke="#176e73" stroke-width="55" stroke-linecap="round"/>
    <circle cx="382" cy="128" r="31" fill="#ef8270"/>
  </svg>`),
)
  .png()
  .toBuffer();
const logo = await normalizedImage(
  new File([logoSource], "harbor-studio-logo.png", { type: "image/png" }),
  "Logo",
);
const logoHash = hash(logo);
const fixture = {
  scope:
    "local deterministic art for version-2 contract and API compatibility rehearsal",
  sourcePath,
  sourceSha256: hash(source),
  promptSpec,
  manifest: art.manifest,
  manifestHash: art.manifestHash,
  spriteHash: art.spriteHash,
  thumbnailHash: art.thumbnailHash,
  logoSourceSha256: hash(logoSource),
  logoHash,
};
const output = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`);
const spritePath = join(fixtureDir, `${art.spriteHash}.png`);
const thumbnailPath = join(fixtureDir, `${art.thumbnailHash}.png`);
const logoPath = join(fixtureDir, `${logoHash}.png`);
if (check) {
  for (const [path, expected] of [
    [manifestPath, output],
    [spritePath, art.sprite],
    [thumbnailPath, art.thumbnail],
    [logoPath, logo],
  ] as const) {
    const actual = await readFile(path);
    if (!actual.equals(expected))
      throw new Error(`Sandbox art fixture drifted: ${path}`);
  }
  process.stdout.write(`Sandbox art fixture matches ${art.manifestHash}\n`);
} else {
  await mkdir(dirname(manifestPath), { recursive: true });
  await Promise.all([
    writeFile(manifestPath, output),
    writeFile(spritePath, art.sprite),
    writeFile(thumbnailPath, art.thumbnail),
    writeFile(logoPath, logo),
  ]);
  process.stdout.write(`Prepared sandbox art ${art.manifestHash}\n`);
}
