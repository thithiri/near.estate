import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateAssetManifest,
  type AssetManifest,
  type ChainPlot,
} from "@estate/shared";
import sharp from "sharp";
import { renderMockCandidate } from "./mock-art.js";
import type { ApiStore, MediaProposalRecord } from "./store.js";

export class ModerationPreviewError extends Error {}

type Overlay = { hash: string; link: string | null };

export type MediaReviewPreview = {
  png: Buffer;
  logo: Overlay | null;
  billboard: Overlay | null;
  facadeManifestHash: string | null;
};

async function storedPng(store: ApiStore, assetHash: string): Promise<Buffer> {
  const bytes = await readFile(join(store.assetDir, `${assetHash}.png`));
  if (createHash("sha256").update(bytes).digest("hex") !== assetHash)
    throw new ModerationPreviewError("Stored image hash does not match");
  return bytes;
}

export async function composeFacadePreview(input: {
  thumbnail: Buffer;
  manifest: AssetManifest;
  logo?: Buffer | null;
  billboard?: Buffer | null;
}): Promise<Buffer> {
  const manifest = validateAssetManifest(input.manifest);
  const metadata = await sharp(input.thumbnail).metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== 140 ||
    metadata.height !== 160
  )
    throw new ModerationPreviewError("Facade thumbnail is invalid");
  const overlays: { input: Buffer; left: number; top: number }[] = [];
  for (const [kind, png, rect] of [
    ["logo", input.logo, manifest.logoRect],
    ["billboard", input.billboard, manifest.billboardRect],
  ] as const) {
    if (!png) continue;
    if (!rect)
      throw new ModerationPreviewError(`Facade has no ${kind} placement`);
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    overlays.push({
      input: await sharp(png)
        .resize(width, height, { fit: "fill" })
        .png()
        .toBuffer(),
      left: Math.round(rect.x),
      top: Math.round(rect.y),
    });
  }
  return sharp(input.thumbnail)
    .composite(overlays)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function mediaReviewPreview(
  store: ApiStore,
  plot: ChainPlot,
  proposal: MediaProposalRecord,
): Promise<MediaReviewPreview> {
  const building = plot.plot.building;
  if (
    plot.plot.id !== proposal.plotId ||
    plot.plot.owner !== proposal.accountId ||
    building.building_type !== proposal.buildingType ||
    building.level !== proposal.level ||
    building.layout_revision !== proposal.layoutRevision
  )
    throw new ModerationPreviewError("Plot changed since media proposal");
  let manifest: AssetManifest;
  let thumbnail: Buffer;
  const facadeManifestHash = building.approved_manifest_hash;
  if (facadeManifestHash) {
    const approved = store.publicManifest(facadeManifestHash);
    if (!approved)
      throw new ModerationPreviewError("Approved facade is unavailable");
    manifest = approved;
    thumbnail = await storedPng(store, approved.thumbnailHash);
  } else {
    const curated = await renderMockCandidate(
      building.building_type,
      building.variant as 1 | 2,
      building.level,
      building.primary_color,
    );
    manifest = curated.manifest;
    thumbnail = curated.thumbnail;
  }
  const activeLogo =
    plot.logo_eligible && plot.plot.logo.active
      ? {
          hash: plot.plot.logo.active.content.asset_hash,
          link: plot.plot.logo.active.content.link,
        }
      : null;
  const activeBillboard =
    plot.billboard_eligible && plot.plot.billboard.active
      ? {
          hash: plot.plot.billboard.active.content.asset_hash,
          link: plot.plot.billboard.active.content.link,
        }
      : null;
  const proposed = { hash: proposal.assetHash, link: proposal.link };
  const logo = proposal.kind === "Logo" ? proposed : activeLogo;
  const billboard = proposal.kind === "Billboard" ? proposed : activeBillboard;
  return {
    png: await composeFacadePreview({
      thumbnail,
      manifest,
      logo: logo ? await storedPng(store, logo.hash) : null,
      billboard: billboard ? await storedPng(store, billboard.hash) : null,
    }),
    logo,
    billboard,
    facadeManifestHash,
  };
}
