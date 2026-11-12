import assert from "node:assert/strict";
import test from "node:test";
import { adDestinationLink, submitAdForReview } from "./owner-ad-flow.js";
import type { ArtworkUpload, MediaProposalRecord } from "./wallet-client.js";

const upload: ArtworkUpload = {
  uploadId: "upload-1",
  hash: "a".repeat(64),
  url: "/api/assets/preview",
  width: 512,
  height: 256,
  status: "pending",
  layoutRevision: 2,
};
const proposal: MediaProposalRecord = {
  id: "proposal-1",
  uploadId: upload.uploadId,
  accountId: "owner.testnet",
  plotId: "plot-main-n-3",
  kind: "Billboard",
  assetHash: upload.hash,
  link: "https://example.com/ad",
  buildingType: "Retail",
  level: 3,
  layoutRevision: 2,
  expectedMediaRevision: 0,
  proposalRevision: null,
  status: "selected",
  decidedAt: null,
  decisionReason: null,
  createdAt: 1,
  assetUrl: upload.url,
};
const file = new File(["image"], "ad.png", { type: "image/png" });

test("ad submission keeps each recoverable stage before wallet confirmation", async () => {
  const stages: string[] = [];
  let savedUpload: ArtworkUpload | null = null;
  let savedProposal: MediaProposalRecord | null = null;
  const wallet = {
    uploadMedia: async (_plotId: string, kind: string) => {
      assert.equal(kind, "Billboard");
      stages.push("upload");
      return upload;
    },
    createMediaProposal: async (
      _upload: ArtworkUpload,
      _plotId: string,
      _kind: string,
      link: string | null,
    ) => {
      assert.equal(link, proposal.link);
      assert.equal(savedUpload, upload);
      stages.push("prepare");
      return proposal;
    },
    submitMediaProposal: async () => {
      assert.equal(savedProposal, proposal);
      stages.push("wallet");
      return { ...proposal, status: "submitted" as const };
    },
  } as unknown as Parameters<typeof submitAdForReview>[0];
  const result = await submitAdForReview(
    wallet,
    proposal.plotId,
    file,
    proposal.link,
    (value) => {
      savedUpload = value;
      stages.push("save upload");
    },
    (value) => {
      savedProposal = value;
      stages.push(`save ${value.status}`);
    },
  );
  assert.equal(result.status, "submitted");
  assert.deepEqual(stages, [
    "upload",
    "save upload",
    "prepare",
    "save selected",
    "wallet",
    "save submitted",
  ]);
});

test("wallet interruption leaves a selected proposal for retry", async () => {
  let savedProposal: MediaProposalRecord | null = null;
  const wallet = {
    uploadMedia: async () => upload,
    createMediaProposal: async () => proposal,
    submitMediaProposal: async () => {
      throw new Error("Wallet response interrupted");
    },
  } as unknown as Parameters<typeof submitAdForReview>[0];
  await assert.rejects(
    submitAdForReview(
      wallet,
      proposal.plotId,
      file,
      proposal.link,
      () => {},
      (value) => {
        savedProposal = value;
      },
    ),
    /interrupted/,
  );
  assert.equal(savedProposal, proposal);
});

test("ad links are optional and must use HTTPS without credentials", () => {
  assert.equal(adDestinationLink("  "), null);
  assert.equal(
    adDestinationLink(" https://example.com/ad "),
    "https://example.com/ad",
  );
  for (const input of [
    "http://example.com",
    "https://a:b@example.com",
    "not a URL",
  ])
    assert.throws(() => adDestinationLink(input), /HTTPS website link/);
});
