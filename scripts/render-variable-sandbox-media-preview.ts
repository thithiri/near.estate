import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChainPlotV2, validateAssetManifestV2 } from "@estate/shared";
import { composeVariableFacadePreview } from "../services/api/src/variable-art.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureDir = join(root, "tests/fixtures/variable-city-media");
const art = JSON.parse(
  await readFile(join(fixtureDir, "fixture.json"), "utf8"),
) as {
  manifest: unknown;
  manifestHash: string;
  spriteHash: string;
  logoHash: string;
};
const contract = JSON.parse(
  await readFile(
    join(
      root,
      "deployments/variable-city-contract-media-fixture-2026-11-12.json",
    ),
    "utf8",
  ),
) as { logoApprovedPlot: unknown };
const plot = ChainPlotV2.parse(contract.logoApprovedPlot);
const manifest = validateAssetManifestV2(art.manifest);
if (
  plot.plot.building.approved_manifest_hash !== art.manifestHash ||
  plot.plot.logo.active?.content.asset_hash !== art.logoHash ||
  !plot.logo_eligible
)
  throw new Error(
    "Sandbox readback does not approve the local facade and logo",
  );
const [sprite, logo] = await Promise.all([
  readFile(join(fixtureDir, `${art.spriteHash}.png`)),
  readFile(join(fixtureDir, `${art.logoHash}.png`)),
]);
const preview = await composeVariableFacadePreview({
  plot,
  approvedFacade: { manifest, sprite },
  logo,
});
const destination = join(
  root,
  "docs/images/near-estate-sandbox-market-hall-logo-v1.png",
);
if (process.argv.includes("--check")) {
  const existing = await readFile(destination);
  if (!existing.equals(preview))
    throw new Error("Sandbox media preview drifted");
  process.stdout.write("Sandbox media preview matches the contract readback\n");
} else {
  await writeFile(destination, preview);
  process.stdout.write(`Rendered ${destination}\n`);
}
