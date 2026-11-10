import { createHash, randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function saveImmutablePng(
  assetDir: string,
  assetHash: string,
  bytes: Buffer,
): Promise<void> {
  if (
    !/^[0-9a-f]{64}$/.test(assetHash) ||
    createHash("sha256").update(bytes).digest("hex") !== assetHash ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  )
    throw new Error("Immutable PNG hash or format mismatch");
  const path = join(assetDir, `${assetHash}.png`);
  const temporaryPath = join(assetDir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(path);
      if (!existing.equals(bytes))
        throw new Error("Immutable PNG path contains different bytes");
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
