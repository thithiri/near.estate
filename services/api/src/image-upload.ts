import sharp from "sharp";

const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_INPUT_PIXELS = 4_000_000;

export async function normalizedImage(
  file: File,
  kind: "Logo" | "Billboard",
): Promise<Buffer> {
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES)
    throw new Error("Image must be between 1 byte and 1 MB");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Use a PNG, JPEG or WebP image");
  const input = Buffer.from(await file.arrayBuffer());
  const metadata = await sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "error",
  }).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > 4096 ||
    metadata.height > 4096 ||
    metadata.width * metadata.height > MAX_INPUT_PIXELS ||
    (metadata.pages ?? 1) !== 1 ||
    !["png", "jpeg", "webp"].includes(metadata.format ?? "")
  )
    throw new Error("Image dimensions or format are not supported");
  const width = kind === "Logo" ? 256 : 512;
  const height = kind === "Logo" ? 256 : 256;
  const output = await sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "error",
  })
    .rotate()
    .resize(width, height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .toColourspace("srgb")
    .png({ compressionLevel: 9 })
    .toBuffer();
  if (output.length > MAX_IMAGE_BYTES)
    throw new Error("Processed image is too large");
  return output;
}
