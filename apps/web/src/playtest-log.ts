export const PLAYTEST_LOG_KEY = "near-estate-playtest-v1";

export type PlaytestEventName =
  | "park_legal"
  | "park_illegal"
  | "collect"
  | "repair"
  | "upgrade"
  | "garage_opened"
  | "burger_visit"
  | "cinema_finished"
  | "practice_finished"
  | "horse_race_finished"
  | "trip_stop_complete"
  | "return_day";

export type PlaytestLog = {
  schema: 1;
  enabled: boolean;
  startedAtMs: number;
  lastVisitDay: string;
  events: Array<{ name: PlaytestEventName; minute: number; day: number }>;
};

const allowed = new Set<PlaytestEventName>([
  "park_legal",
  "park_illegal",
  "collect",
  "repair",
  "upgrade",
  "garage_opened",
  "burger_visit",
  "cinema_finished",
  "practice_finished",
  "horse_race_finished",
  "trip_stop_complete",
  "return_day",
]);

export class PlaytestRecorder {
  constructor(
    private readonly storage: Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  read(): PlaytestLog | null {
    try {
      const value = JSON.parse(
        this.storage.getItem(PLAYTEST_LOG_KEY) ?? "null",
      );
      if (
        value?.schema !== 1 ||
        typeof value.enabled !== "boolean" ||
        !Number.isSafeInteger(value.startedAtMs) ||
        typeof value.lastVisitDay !== "string" ||
        !Array.isArray(value.events)
      )
        return null;
      const events = value.events
        .filter(
          (event: PlaytestLog["events"][number]) =>
            allowed.has(event?.name) &&
            Number.isSafeInteger(event.minute) &&
            event.minute >= 0 &&
            Number.isSafeInteger(event.day) &&
            event.day >= 0,
        )
        .slice(-120);
      return { ...value, events } as PlaytestLog;
    } catch {
      return null;
    }
  }

  setEnabled(enabled: boolean): void {
    const date = this.now();
    const current = this.read();
    const next: PlaytestLog = current
      ? { ...current, enabled }
      : {
          schema: 1,
          enabled,
          startedAtMs: date.getTime(),
          lastVisitDay: date.toISOString().slice(0, 10),
          events: [],
        };
    this.storage.setItem(PLAYTEST_LOG_KEY, JSON.stringify(next));
  }

  record(name: PlaytestEventName): void {
    const log = this.read();
    if (!log?.enabled || !allowed.has(name)) return;
    const date = this.now();
    const elapsed = Math.max(0, date.getTime() - log.startedAtMs);
    const minute = Math.floor(elapsed / 60_000);
    const day = Math.floor(elapsed / 86_400_000);
    const visitDay = date.toISOString().slice(0, 10);
    if (visitDay !== log.lastVisitDay && name !== "return_day") {
      log.events.push({ name: "return_day", minute, day });
    }
    log.events.push({
      name,
      minute,
      day,
    });
    log.events = log.events.slice(-120);
    log.lastVisitDay = visitDay;
    this.storage.setItem(PLAYTEST_LOG_KEY, JSON.stringify(log));
  }

  noteVisit(): void {
    const log = this.read();
    if (!log?.enabled) return;
    const day = this.now().toISOString().slice(0, 10);
    if (day !== log.lastVisitDay) this.record("return_day");
  }

  clear(): void {
    this.storage.removeItem(PLAYTEST_LOG_KEY);
  }

  export(): { schema: 1; source: "guest"; events: PlaytestLog["events"] } {
    return { schema: 1, source: "guest", events: this.read()?.events ?? [] };
  }
}
