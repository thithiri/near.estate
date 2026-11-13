import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonicalJson,
  validateAssetManifest,
  validateAssetManifestV2,
  variableFrontageMediaLayout,
} from "@estate/shared";
import { loadApprovedNeighbourThumbnail } from "./approved-neighbour.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/4V0AAAAASUVORK5CYII=",
  "base64",
);
const thumbnailHash = createHash("sha256").update(png).digest("hex");
const manifest = validateAssetManifest({
  schemaVersion: 1,
  renderProfileVersion: 1,
  buildingType: "Cafe",
  level: 2,
  spriteHash: "a".repeat(64),
  thumbnailHash,
  alphaBounds: { x: 10, y: 65, width: 120, height: 95 },
  logoRect: { x: 20, y: 80, width: 20, height: 20 },
  billboardRect: null,
});
const approvedHash = createHash("sha256")
  .update(canonicalJson(manifest))
  .digest("hex");

test("owner neighbour preview accepts only the exact approved plot image", async () => {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const path = String(input);
    requests.push(path);
    if (path === `/api/manifests/${approvedHash}`)
      return Response.json(manifest);
    if (path === `/api/assets/${thumbnailHash}`) return new Response(png);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const url = await loadApprovedNeighbourThumbnail(
    approvedHash,
    "Cafe",
    2,
    fetcher,
  );
  assert.ok(url.startsWith("data:image/png;base64,"));
  assert.deepEqual(requests, [
    `/api/manifests/${approvedHash}`,
    `/api/assets/${thumbnailHash}`,
  ]);
  await assert.rejects(
    loadApprovedNeighbourThumbnail(approvedHash, "Office", 2, fetcher),
    /does not match this plot/,
  );
  const changedFetcher = (async (input: string | URL | Request) =>
    String(input).startsWith("/api/manifests/")
      ? Response.json(manifest)
      : new Response(
          Buffer.from(
            png.map((byte, index) => (index === 12 ? byte ^ 1 : byte)),
          ),
        )) as typeof fetch;
  await assert.rejects(
    loadApprovedNeighbourThumbnail(approvedHash, "Cafe", 2, changedFetcher),
    /hash mismatch/,
  );
});

test("owner neighbour preview accepts a verified variable-width facade", async () => {
  const media = variableFrontageMediaLayout(1, 0, 2);
  const variableManifest = validateAssetManifestV2({
    schemaVersion: 2,
    renderProfileVersion: 2,
    frontageUnits: 1,
    designChoice: 0,
    buildingType: "Cafe",
    level: 2,
    spriteHash: "a".repeat(64),
    thumbnailHash,
    alphaBounds: { x: 3, y: 90, width: 79, height: 100 },
    logoRect: media.logo,
    billboardRect: media.billboard,
  });
  const hash = createHash("sha256")
    .update(canonicalJson(variableManifest))
    .digest("hex");
  const fetcher = (async (input: string | URL | Request) =>
    String(input).startsWith("/api/manifests/")
      ? Response.json(variableManifest)
      : new Response(png)) as typeof fetch;
  assert.ok(
    (await loadApprovedNeighbourThumbnail(hash, "Cafe", 2, fetcher)).startsWith(
      "data:image/png;base64,",
    ),
  );
});
