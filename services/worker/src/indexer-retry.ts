const MAX_THROTTLE_WAIT_MS = 120_000;

export function throttleWaitMs(
  retryAfterMs: number,
  consecutive: number,
): number {
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1)
    throw new Error("Invalid provider retry delay");
  if (!Number.isSafeInteger(consecutive) || consecutive < 1)
    throw new Error("Invalid throttle count");
  return Math.min(
    MAX_THROTTLE_WAIT_MS,
    retryAfterMs * 2 ** Math.min(consecutive - 1, 5),
  );
}

export function waitForRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}
