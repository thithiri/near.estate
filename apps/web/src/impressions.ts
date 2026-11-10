import {
  IMPRESSION_RULES,
  ImpressionEvent,
  type ImpressionEvent as ImpressionEventType,
} from "@estate/shared";

export type VisibleAdSurface = {
  plotId: string;
  surface: "Logo" | "Billboard";
};

type ActiveSurface = VisibleAdSurface & {
  enteredAt: number;
  lastReportedAt: number;
};

const QUEUE_KEY = "near-estate-impression-queue-v1";
const MAX_QUEUED_EVENTS = 100;

export class VisibilityRecorder {
  private readonly active = new Map<string, ActiveSurface>();

  observe(nowMs: number, surfaces: VisibleAdSurface[]): ImpressionEventType[] {
    const current = new Map(
      surfaces.map((surface) => [surface.plotId, surface]),
    );
    const completed: ImpressionEventType[] = [];
    for (const [plotId, previous] of this.active) {
      const visible = current.get(plotId);
      if (visible?.surface === previous.surface) continue;
      completed.push(...this.segment(previous, nowMs));
      this.active.delete(plotId);
    }
    for (const surface of current.values())
      if (!this.active.has(surface.plotId))
        this.active.set(surface.plotId, {
          ...surface,
          enteredAt: nowMs,
          lastReportedAt: nowMs,
        });
    return completed;
  }

  drain(nowMs: number): ImpressionEventType[] {
    return [...this.active.values()].flatMap((surface) =>
      this.segment(surface, nowMs),
    );
  }

  private segment(
    surface: ActiveSurface,
    nowMs: number,
  ): ImpressionEventType[] {
    if (nowMs - surface.enteredAt < IMPRESSION_RULES.visibleThresholdMs)
      return [];
    const events: ImpressionEventType[] = [];
    while (nowMs > surface.lastReportedAt) {
      const duration = Math.min(
        IMPRESSION_RULES.maxEventMs,
        nowMs - surface.lastReportedAt,
      );
      surface.lastReportedAt += duration;
      events.push({
        eventId: crypto.randomUUID(),
        plotId: surface.plotId,
        surface: surface.surface,
        observedAt: surface.lastReportedAt,
        msVisible: duration,
      });
    }
    return events;
  }
}

function loadQueue(): ImpressionEventType[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .map((value) => ImpressionEvent.safeParse(value))
      .filter((result) => result.success)
      .map((result) => result.data)
      .slice(-MAX_QUEUED_EVENTS);
  } catch {
    return [];
  }
}

export class ImpressionReporter {
  private readonly recorder = new VisibilityRecorder();
  private queue = loadQueue();
  private sessionReady = false;
  private sending = false;

  observe(surfaces: VisibleAdSurface[]): void {
    this.enqueue(this.recorder.observe(Date.now(), surfaces));
  }

  pause(): void {
    this.observe([]);
  }

  private enqueue(events: ImpressionEventType[]): void {
    if (!events.length) return;
    this.queue.push(...events);
    this.queue = this.queue.slice(-MAX_QUEUED_EVENTS);
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue));
    } catch {
      // A private browser session may disable storage; the current page still works.
    }
  }

  private async ensureSession(): Promise<boolean> {
    if (this.sessionReady) return true;
    const response = await fetch("/api/impressions/session", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    this.sessionReady = response.ok;
    return this.sessionReady;
  }

  async flush(): Promise<void> {
    this.enqueue(this.recorder.drain(Date.now()));
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    try {
      const now = Date.now();
      this.queue = this.queue.filter(
        (event) => now - event.observedAt <= IMPRESSION_RULES.maxEventAgeMs,
      );
      this.persist();
      if (!this.queue.length || !(await this.ensureSession())) return;
      for (
        let batchNumber = 0;
        batchNumber < 3 && this.queue.length;
        batchNumber++
      ) {
        const batch = this.queue.slice(0, IMPRESSION_RULES.maxBatchEvents);
        const response = await fetch("/api/impressions", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: batch }),
        });
        if (response.status === 401) {
          this.sessionReady = false;
          return;
        }
        if (response.status === 403) {
          const reason = (await response.json().catch(() => null)) as {
            code?: string;
            plotId?: string;
            surface?: string;
          } | null;
          if (reason?.code === "NO_APPROVED_AD" && reason.plotId) {
            this.queue = this.queue.filter(
              (event) =>
                event.plotId !== reason.plotId ||
                event.surface !== reason.surface,
            );
            this.persist();
            continue;
          }
        }
        if (!response.ok) return;
        const sent = new Set(batch.map((event) => event.eventId));
        this.queue = this.queue.filter((event) => !sent.has(event.eventId));
        this.persist();
      }
    } catch {
      // Keep the same event IDs in the persisted queue for a later retry.
    } finally {
      this.sending = false;
    }
  }
}
