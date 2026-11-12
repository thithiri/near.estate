import assert from "node:assert/strict";
import test from "node:test";
import { ChainPlotV2, variableFrontageMediaLayout } from "@estate/shared";
import sharp from "sharp";
import { composeVariableFacadePreview } from "./variable-art.js";
import { normalizeVariableGeneratedFacade } from "./variable-generated-art.js";

function plot(units: 1 | 2 | 3, design: number, level: 1 | 2 | 3 | 4) {
  return ChainPlotV2.parse({
    plot: {
      id: "plot-main-n-0",
      road_id: "main",
      side: "North",
      index: 0,
      corner: false,
      owner: "owner.testnet",
      rule: { kind: "Free" },
      pending_rule: null,
      frontage_units: units,
      design_choice: design,
      building: {
        building_type: "Retail",
        variant: 1,
        level,
        primary_color: "#F6C85F",
        name: "Owner shop",
        approved_manifest_hash: null,
        approved_at: null,
        last_facade_approved_at: null,
        pending_appearance: null,
        last_appearance_decision: null,
        facade_exemption_level: null,
        appearance_revision: 1,
        layout_revision: 1,
      },
      logo: {
        revision: 0,
        active: null,
        pending: null,
        last_decision: null,
        last_replacement_at: null,
      },
      billboard: {
        revision: 0,
        active: null,
        pending: null,
        last_decision: null,
        last_replacement_at: null,
      },
      ticket_cooldown_until: 0,
      reserved_storage_bytes: 4096,
      used_storage_bytes: 0,
    },
    effective_rule: { kind: "Free" },
    logo_eligible: false,
    billboard_eligible: false,
  });
}

async function solid(width: number, height: number, color: string) {
  return sharp({
    create: { width, height, channels: 4, background: color },
  })
    .png()
    .toBuffer();
}

async function pixel(image: Buffer, width: number, x: number, y: number) {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (Math.floor(y) * width + Math.floor(x)) * info.channels;
  return [...data.subarray(offset, offset + info.channels)];
}

test("variable-width review uses the actual illustration and shared logo position", async () => {
  const logo = await solid(256, 256, "#ff0000");
  for (const units of [1, 2, 3] as const) {
    const width = units * 85;
    const review = await composeVariableFacadePreview({
      plot: plot(units, 0, 1),
      logo,
    });
    const metadata = await sharp(review).metadata();
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, 190);
    const rect = variableFrontageMediaLayout(units, 0, 1).logo;
    assert.deepEqual(
      await pixel(
        review,
        width,
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      ),
      [255, 0, 0, 255],
    );
  }
});

test("billboard media fits only eligible wide designs at levels three and four", async () => {
  const billboard = await sharp({
    create: { width: 512, height: 256, channels: 4, background: "#ff0000" },
  })
    .composite([{ input: await solid(512, 136, "#00ff00"), left: 0, top: 60 }])
    .png()
    .toBuffer();
  for (const [units, design] of [
    [2, 1],
    [2, 4],
  ] as const) {
    for (const level of [3, 4] as const) {
      const review = await composeVariableFacadePreview({
        plot: plot(units, design, level),
        billboard,
      });
      const rect = variableFrontageMediaLayout(units, design, level).billboard!;
      assert.equal(rect.width, 88);
      assert.equal(rect.height, 20);
      for (const y of [rect.y + 1, rect.y + 10, rect.y + 18]) {
        const [red = 255, green = 0, blue = 255, alpha = 0] = await pixel(
          review,
          units * 85,
          rect.x + rect.width / 2,
          y,
        );
        assert(red <= 5);
        assert(green >= 250);
        assert(blue <= 5);
        assert.equal(alpha, 255);
      }
    }
  }
  assert.equal(variableFrontageMediaLayout(2, 4, 4).billboard?.y, 84);
  await assert.rejects(
    () => composeVariableFacadePreview({ plot: plot(1, 0, 4), billboard }),
    /no billboard placement/,
  );
  await assert.rejects(
    () => composeVariableFacadePreview({ plot: plot(2, 1, 2), billboard }),
    /no billboard placement/,
  );
  await assert.rejects(
    () => composeVariableFacadePreview({ plot: plot(3, 0, 3), billboard }),
    /no billboard placement/,
  );
  await assert.rejects(
    () => composeVariableFacadePreview({ plot: plot(3, 2, 4), billboard }),
    /no billboard placement/,
  );
});

test("moderator preview composes approved custom facade under the exact sign", async () => {
  const source = await sharp({
    create: {
      width: 680,
      height: 760,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: await solid(656, 640, "#ae6350"),
        left: 12,
        top: 120,
      },
    ])
    .png()
    .toBuffer();
  const candidate = await normalizeVariableGeneratedFacade(source, {
    frontageUnits: 2,
    designChoice: 1,
    buildingType: "Retail",
    level: 4,
  });
  const logo = await solid(256, 256, "#ff0000");
  const review = await composeVariableFacadePreview({
    plot: plot(2, 1, 4),
    logo,
    approvedFacade: { manifest: candidate.manifest, sprite: candidate.sprite },
  });
  assert.deepEqual(await pixel(review, 170, 80, 100), [174, 99, 80, 255]);
  const mark = variableFrontageMediaLayout(2, 1, 4).logo;
  assert.deepEqual(
    await pixel(review, 170, mark.x + mark.width / 2, mark.y + mark.height / 2),
    [255, 0, 0, 255],
  );
  await assert.rejects(
    () =>
      composeVariableFacadePreview({
        plot: plot(1, 0, 4),
        approvedFacade: {
          manifest: candidate.manifest,
          sprite: candidate.sprite,
        },
      }),
    /does not match its plot/,
  );
});
