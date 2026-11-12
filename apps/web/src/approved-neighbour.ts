import {
  manifestHash,
  validateAssetManifest,
  type AssetManifest,
} from "@estate/shared";

const MAX_THUMBNAIL_BYTES = 1_000_000;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function dataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:image/png;base64,${btoa(binary)}`;
}

export async function loadApprovedNeighbourThumbnail(
  approvedHash: string,
  buildingType: AssetManifest["buildingType"],
  level: number,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(approvedHash))
    throw new Error("Invalid approved facade hash");
  const manifestResponse = await fetcher(`/api/manifests/${approvedHash}`);
  if (!manifestResponse.ok)
    throw new Error("Approved facade manifest unavailable");
  const manifest = validateAssetManifest(await manifestResponse.json());
  if (
    (await manifestHash(manifest)) !== approvedHash ||
    manifest.buildingType !== buildingType ||
    manifest.level !== level
  )
    throw new Error("Approved facade does not match this plot");
  const thumbnailResponse = await fetcher(
    `/api/assets/${manifest.thumbnailHash}`,
  );
  if (!thumbnailResponse.ok)
    throw new Error("Approved facade thumbnail unavailable");
  const bytes = new Uint8Array(await thumbnailResponse.arrayBuffer());
  if (
    bytes.length < PNG_SIGNATURE.length ||
    bytes.length > MAX_THUMBNAIL_BYTES ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  )
    throw new Error("Approved facade thumbnail is invalid");
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (digest !== manifest.thumbnailHash)
    throw new Error("Approved facade thumbnail hash mismatch");
  return dataUrl(bytes);
}
