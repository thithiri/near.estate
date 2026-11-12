export type BillboardFit = "cover" | "contain";

export type PreparedBillboard = {
  previewUrl: string;
  uploadFile: File;
};

function canvas(
  width: number,
  height: number,
): {
  image: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const image = document.createElement("canvas");
  image.width = width;
  image.height = height;
  const context = image.getContext("2d");
  if (!context) throw new Error("Ad preview is unavailable");
  return { image, context };
}

function drawCover(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource & { width: number; height: number },
  width: number,
  height: number,
): void {
  const ratio = width / height;
  const sourceRatio = source.width / source.height;
  const cropWidth = sourceRatio > ratio ? source.height * ratio : source.width;
  const cropHeight = sourceRatio > ratio ? source.height : source.width / ratio;
  context.drawImage(
    source,
    (source.width - cropWidth) / 2,
    (source.height - cropHeight) / 2,
    cropWidth,
    cropHeight,
    0,
    0,
    width,
    height,
  );
}

function pngBlob(image: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    image.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not prepare billboard image"));
    }, "image/png");
  });
}

export async function prepareBillboardImage(
  file: File,
  aspectRatio: number,
  fit: BillboardFit,
): Promise<PreparedBillboard> {
  if (
    !Number.isFinite(aspectRatio) ||
    aspectRatio <= 0 ||
    file.size < 1 ||
    file.size > 1024 * 1024 ||
    !["image/png", "image/jpeg", "image/webp"].includes(file.type)
  )
    throw new Error("Use a PNG, JPEG or WebP image up to 1 MB");
  const bitmap = await createImageBitmap(file);
  try {
    if (
      bitmap.width < 1 ||
      bitmap.height < 1 ||
      bitmap.width > 4096 ||
      bitmap.height > 4096 ||
      bitmap.width * bitmap.height > 4_000_000
    )
      throw new Error("Image dimensions are not supported");

    if (fit === "cover") {
      // A few extra vertical pixels keep resampling from introducing a
      // transparent hairline when the API centers this into 512 × 256.
      const height =
        aspectRatio > 2
          ? Math.ceil(512 / aspectRatio) + 4
          : Math.round(512 / aspectRatio);
      const cropped = canvas(512, height);
      drawCover(cropped.context, bitmap, 512, height);
      const blob = await pngBlob(cropped.image);
      if (blob.size > 1024 * 1024)
        throw new Error("Cropped ad is over 1 MB; use a simpler image");
      const preview = canvas(Math.round(160 * aspectRatio), 160);
      drawCover(preview.context, cropped.image, preview.image.width, 160);
      return {
        previewUrl: preview.image.toDataURL("image/png"),
        uploadFile: new File([blob], "billboard-crop.png", {
          type: "image/png",
        }),
      };
    }

    // Match the API's 512 × 256 transparent containment, followed by the
    // street's centered cover crop. The original file remains the upload.
    const normalized = canvas(512, 256);
    const scale = Math.min(512 / bitmap.width, 256 / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    normalized.context.drawImage(
      bitmap,
      (512 - width) / 2,
      (256 - height) / 2,
      width,
      height,
    );
    const preview = canvas(Math.round(160 * aspectRatio), 160);
    drawCover(preview.context, normalized.image, preview.image.width, 160);
    return {
      previewUrl: preview.image.toDataURL("image/png"),
      uploadFile: file,
    };
  } finally {
    bitmap.close();
  }
}
