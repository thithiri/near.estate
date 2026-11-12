import type {
  ArtworkUpload,
  GameWalletClient,
  MediaProposalRecord,
} from "./wallet-client.js";

type AdWallet = Pick<
  GameWalletClient,
  "uploadMedia" | "createMediaProposal" | "submitMediaProposal"
>;

export function adDestinationLink(value: string): string | null {
  const link = value.trim();
  if (!link) return null;
  if (link.length > 256) throw new Error("Ad website link is too long");
  try {
    const url = new URL(link);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    )
      throw new Error("Use an HTTPS website link without sign-in details");
  } catch {
    throw new Error("Use an HTTPS website link without sign-in details");
  }
  return link;
}

export async function submitAdForReview(
  wallet: AdWallet,
  plotId: string,
  file: File,
  link: string | null,
  onUpload: (upload: ArtworkUpload) => void,
  onProposal: (proposal: MediaProposalRecord) => void,
): Promise<MediaProposalRecord> {
  const upload = await wallet.uploadMedia(plotId, "Billboard", file);
  onUpload(upload);
  const proposal = await wallet.createMediaProposal(
    upload,
    plotId,
    "Billboard",
    link,
  );
  onProposal(proposal);
  const confirmed = await wallet.submitMediaProposal(proposal);
  onProposal(confirmed);
  return confirmed;
}
