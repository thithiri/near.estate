import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { saveImmutablePng } from "./asset-storage.js";

test("content-addressed PNG writes are atomic, repeatable and never overwrite different bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "estate-assets-"));
  try {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "#58a2d0" },
    })
      .png()
      .toBuffer();
    const hash = createHash("sha256").update(png).digest("hex");
    await Promise.all([
      saveImmutablePng(dir, hash, png),
      saveImmutablePng(dir, hash, png),
    ]);
    assert.deepEqual(await readFile(join(dir, `${hash}.png`)), png);
    assert.deepEqual(await readdir(dir), [`${hash}.png`]);
    await writeFile(join(dir, `${hash}.png`), Buffer.from("corrupted"));
    await assert.rejects(saveImmutablePng(dir, hash, png));
    assert.deepEqual(
      await readFile(join(dir, `${hash}.png`)),
      Buffer.from("corrupted"),
    );
    await assert.rejects(saveImmutablePng(dir, "0".repeat(64), png));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
