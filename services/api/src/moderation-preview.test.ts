import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { renderMockCandidate } from "./mock-art.js";
import {
  composeFacadePreview,
  ModerationPreviewError,
} from "./moderation-preview.js";

function pixel(rgba: Buffer, x: number, y: number): number[] {
  const offset = (y * 140 + x) * 4;
  return [...rgba.subarray(offset, offset + 4)];
}

test("moderation preview places the exact logo and billboard pixels on the facade", async () => {
  const facade = await renderMockCandidate("Retail", 1, 1, "#73D9A6");
  const logo = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 4,
      background: "#ff0000",
    },
  })
    .png()
    .toBuffer();
  const billboard = await sharp({
    create: {
      width: 512,
      height: 256,
      channels: 4,
      background: "#0000ff",
    },
  })
    .png()
    .toBuffer();
  const preview = await composeFacadePreview({
    thumbnail: facade.thumbnail,
    manifest: facade.manifest,
    logo,
    billboard,
  });
  const decoded = await sharp(preview)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 140);
  assert.equal(decoded.info.height, 160);
  const logoRect = facade.manifest.logoRect!;
  const billboardRect = facade.manifest.billboardRect!;
  assert.deepEqual(
    pixel(
      decoded.data,
      logoRect.x + logoRect.width / 2,
      logoRect.y + logoRect.height / 2,
    ),
    [255, 0, 0, 255],
  );
  assert.deepEqual(
    pixel(
      decoded.data,
      billboardRect.x + billboardRect.width / 2,
      billboardRect.y + billboardRect.height / 2,
    ),
    [0, 0, 255, 255],
  );
  await assert.rejects(
    () =>
      composeFacadePreview({
        thumbnail: facade.thumbnail,
        manifest: { ...facade.manifest, billboardRect: null },
        billboard,
      }),
    ModerationPreviewError,
  );
});
