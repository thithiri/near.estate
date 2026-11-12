import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  FRONTAGE_LEVEL_HEIGHTS_V2,
  FRONTAGE_UNIT_WIDTH_V2,
  manifestHashV2,
  validateAssetManifestV2,
  type BuildingLevelV2,
  type FrontageUnitsV2,
} from "@estate/shared";
import { normalizeVariableGeneratedFacade } from "./variable-generated-art.js";

async function facadeSource(
  units: FrontageUnitsV2,
  level: BuildingLevelV2,
  visibleWidth = units * FRONTAGE_UNIT_WIDTH_V2 - 6,
): Promise<Buffer> {
  const width = units * FRONTAGE_UNIT_WIDTH_V2 * 4;
  const height = 190 * 4;
  const buildingHeight = FRONTAGE_LEVEL_HEIGHTS_V2[level] * 4;
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: visibleWidth * 4,
            height: buildingHeight,
            channels: 4,
            background: "#b96752",
          },
        })
          .png()
          .toBuffer(),
        left: Math.floor((width - visibleWidth * 4) / 2),
        top: height - buildingHeight,
      },
    ])
    .png()
    .toBuffer();
}

test("version-2 generated facade fits each plot width and level envelope", async () => {
  for (const units of [1, 2, 3] as const) {
    for (const level of [1, 4] as const) {
      const candidate = await normalizeVariableGeneratedFacade(
        await facadeSource(units, level),
        {
          frontageUnits: units,
          designChoice: units === 2 ? 1 : 0,
          buildingType: "Retail",
          level,
        },
      );
      const sprite = await sharp(candidate.sprite).metadata();
      const thumbnail = await sharp(candidate.thumbnail).metadata();
      assert.equal(sprite.width, units * 85 * 4);
      assert.equal(sprite.height, 190 * 4);
      assert.equal(thumbnail.width, units * 85);
      assert.equal(thumbnail.height, 190);
      assert.equal(candidate.manifest.frontageUnits, units);
      assert.equal(candidate.manifest.level, level);
      assert.equal(
        candidate.manifest.alphaBounds.y,
        190 - FRONTAGE_LEVEL_HEIGHTS_V2[level],
      );
      assert.equal(candidate.manifest.alphaBounds.x, 3);
      assert.equal(
        candidate.manifestHash,
        await manifestHashV2(candidate.manifest),
      );
      assert.equal(
        candidate.manifest.billboardRect !== null,
        units === 2 && level === 4,
      );
    }
  }
});

test("version-2 manifest binds exact sign placement to its design", async () => {
  const candidate = await normalizeVariableGeneratedFacade(
    await facadeSource(2, 4),
    { frontageUnits: 2, designChoice: 1, buildingType: "Restaurant", level: 4 },
  );
  assert.throws(
    () => validateAssetManifestV2({ ...candidate.manifest, frontageUnits: 1 }),
    /version-2 facade exceeds/,
  );
  assert.throws(
    () => validateAssetManifestV2({ ...candidate.manifest, designChoice: 2 }),
    /version-2 logo placement differs|version-2 billboard placement differs/,
  );
  assert.throws(
    () => validateAssetManifestV2({ ...candidate.manifest, level: 1 }),
    /version-2 facade exceeds/,
  );
  assert.throws(
    () =>
      validateAssetManifestV2({
        ...candidate.manifest,
        alphaBounds: { ...candidate.manifest.alphaBounds, y: 20 },
      }),
    /version-2 facade exceeds/,
  );
});

test("version-2 normalizer rejects thin facades that leave most of a plot empty", async () => {
  await assert.rejects(
    normalizeVariableGeneratedFacade(await facadeSource(3, 4, 40), {
      frontageUnits: 3,
      designChoice: 0,
      buildingType: "Retail",
      level: 4,
    }),
    /too narrow/,
  );
});

test("accepted generated art fills the plot with only the shared side gap", async () => {
  const candidate = await normalizeVariableGeneratedFacade(
    await facadeSource(3, 4, 220),
    {
      frontageUnits: 3,
      designChoice: 0,
      buildingType: "Retail",
      level: 4,
    },
  );
  assert.deepEqual(candidate.manifest.alphaBounds, {
    x: 3,
    y: 30,
    width: 249,
    height: 160,
  });
  const { data, info } = await sharp(candidate.sprite)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphaAt = (x: number, y: number) =>
    data[(y * info.width + x) * info.channels + 3];
  assert.equal(alphaAt(2 * 4, 150 * 4), 0);
  assert.equal(alphaAt(3 * 4, 150 * 4), 255);
  assert.equal(alphaAt(251 * 4, 150 * 4), 255);
  assert.equal(alphaAt(252 * 4, 150 * 4), 0);
});
