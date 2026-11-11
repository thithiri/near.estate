import { GeneratedArtError, saveGeneratedFacade } from "./generated-art.js";
import type { ImageTokenUsage } from "./image-provider.js";
import {
  PaidGenerationLedger,
  type PaidJob,
} from "./paid-generation-ledger.js";

export async function processPaidImageResult(input: {
  ledger: PaidGenerationLedger;
  jobId: string;
  workerId: string;
  clientRequestId: string;
  providerRequestId: string | null;
  usage?: ImageTokenUsage | null;
  png: Buffer;
  assetDir: string;
  now: number;
}): Promise<PaidJob> {
  const job = input.ledger.job(input.jobId);
  if (!job?.snapshot) throw new Error("Paid job has no building snapshot");
  let candidate;
  try {
    candidate = await saveGeneratedFacade(
      input.png,
      job.snapshot.buildingType,
      job.snapshot.level,
      input.assetDir,
    );
  } catch (error) {
    return input.ledger.finishAttempt({
      jobId: input.jobId,
      workerId: input.workerId,
      clientRequestId: input.clientRequestId,
      providerRequestId: input.providerRequestId,
      usage: input.usage,
      outcome: error instanceof GeneratedArtError ? "rejected" : "uncertain",
      now: input.now,
    });
  }
  if (
    input.ledger
      .candidates(input.jobId)
      .some((existing) => existing.manifestHash === candidate.manifestHash)
  )
    return input.ledger.finishAttempt({
      jobId: input.jobId,
      workerId: input.workerId,
      clientRequestId: input.clientRequestId,
      providerRequestId: input.providerRequestId,
      usage: input.usage,
      outcome: "rejected",
      now: input.now,
    });
  return input.ledger.finishAttempt({
    jobId: input.jobId,
    workerId: input.workerId,
    clientRequestId: input.clientRequestId,
    providerRequestId: input.providerRequestId,
    usage: input.usage,
    outcome: "accepted",
    candidate,
    now: input.now,
  });
}
