import { readFileSync } from "node:fs";
import { writeFile, rename, rm } from "node:fs/promises";
import {
  InspectorStatus,
  type InspectorStatus as Status,
} from "@estate/shared";
import type { PatrolResult } from "./inspector-patrol.js";

export class InspectorStatusTracker {
  private consecutiveFailures: number;

  constructor(
    private readonly contractId: string,
    priorFailures = 0,
  ) {
    if (!Number.isSafeInteger(priorFailures) || priorFailures < 0)
      throw new Error("Invalid previous patrol failure count");
    this.consecutiveFailures = priorFailures;
  }

  completed(result: PatrolResult, now: number): Status {
    const allAttemptsFailed =
      result.attempted > 0 && result.failed === result.attempted;
    if (allAttemptsFailed) this.consecutiveFailures++;
    else if (result.attempted > 0) this.consecutiveFailures = 0;
    return InspectorStatus.parse({
      contractId: this.contractId,
      completedAt: now,
      outcome: allAttemptsFailed ? "error" : "ok",
      consecutiveFailures: this.consecutiveFailures,
      eligible: result.eligible,
      attempted: result.attempted,
      failed: result.failed,
    });
  }

  failed(now: number): Status {
    this.consecutiveFailures++;
    return InspectorStatus.parse({
      contractId: this.contractId,
      completedAt: now,
      outcome: "error",
      consecutiveFailures: this.consecutiveFailures,
      eligible: 0,
      attempted: 0,
      failed: 0,
    });
  }
}

export function readInspectorStatus(
  path: string,
  contractId: string,
): Status | null {
  try {
    const parsed = InspectorStatus.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success && parsed.data.contractId === contractId
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

export async function writeInspectorStatus(
  path: string,
  status: Status,
): Promise<void> {
  if (!path.startsWith("/"))
    throw new Error("Inspector status path must be absolute");
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(InspectorStatus.parse(status)), {
      mode: 0o600,
    });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
