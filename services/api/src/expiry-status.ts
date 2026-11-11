import { readFileSync } from "node:fs";
import { writeFile, rename, rm } from "node:fs/promises";
import { ExpiryStatus, type ExpiryStatus as Status } from "@estate/shared";
import type { ExpirySweepResult } from "./expiry-sweep.js";

export class ExpiryStatusTracker {
  private consecutiveFailures: number;

  constructor(
    private readonly contractId: string,
    priorFailures = 0,
  ) {
    if (!Number.isSafeInteger(priorFailures) || priorFailures < 0)
      throw new Error("Invalid previous expiry failure count");
    this.consecutiveFailures = priorFailures;
  }

  completed(result: ExpirySweepResult, now: number): Status {
    if (result.failed > 0) this.consecutiveFailures++;
    else this.consecutiveFailures = 0;
    return ExpiryStatus.parse({
      contractId: this.contractId,
      completedAt: now,
      outcome: result.failed > 0 ? "error" : "ok",
      consecutiveFailures: this.consecutiveFailures,
      ...result,
    });
  }

  failed(now: number): Status {
    this.consecutiveFailures++;
    return ExpiryStatus.parse({
      contractId: this.contractId,
      completedAt: now,
      outcome: "error",
      consecutiveFailures: this.consecutiveFailures,
      eligible: 0,
      attempted: 0,
      settled: 0,
      raced: 0,
      failed: 0,
    });
  }
}

export function readExpiryStatus(
  path: string,
  contractId: string,
): Status | null {
  try {
    const parsed = ExpiryStatus.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success && parsed.data.contractId === contractId
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

export async function writeExpiryStatus(
  path: string,
  status: Status,
): Promise<void> {
  if (!path.startsWith("/"))
    throw new Error("Expiry status path must be absolute");
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(ExpiryStatus.parse(status)), {
      mode: 0o600,
    });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
