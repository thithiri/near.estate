import { PlotStats } from "@estate/shared";

export type StatsPlot = {
  id: string;
  label: string;
};

function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export class AdvertiserStatsScreen {
  private selectedPlotId: string;
  private stats: PlotStats | null = null;
  private error = "";
  private loading = false;
  private mounted = false;
  private request = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly plots: StatsPlot[],
    private readonly liveAvailable: boolean,
    private readonly onBack: () => void,
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {
    if (!plots.length) throw new Error("Advertiser stats need city plots");
    this.selectedPlotId = plots[0]!.id;
  }

  mount(plotId?: string): void {
    if (plotId && this.plots.some((plot) => plot.id === plotId))
      this.selectedPlotId = plotId;
    this.mounted = true;
    this.render();
    if (this.liveAvailable) void this.load();
  }

  unmount(): void {
    this.mounted = false;
    this.request++;
  }

  private async load(): Promise<void> {
    const plotId = this.selectedPlotId;
    const request = ++this.request;
    this.loading = true;
    this.error = "";
    this.stats = null;
    this.render();
    try {
      const response = await this.fetcher(
        `/api/stats/plots/${encodeURIComponent(plotId)}`,
        { cache: "no-store" },
      );
      if (!response.ok)
        throw new Error(`Statistics unavailable (${response.status})`);
      const stats = PlotStats.parse(await response.json());
      if (stats.plotId !== plotId)
        throw new Error("Statistics returned for a different plot");
      if (!this.mounted || request !== this.request) return;
      this.stats = stats;
    } catch (error) {
      if (!this.mounted || request !== this.request) return;
      this.error =
        error instanceof Error ? error.message : "Could not load statistics";
    } finally {
      if (this.mounted && request === this.request) {
        this.loading = false;
        this.render();
      }
    }
  }

  private render(): void {
    if (!this.mounted) return;
    const plot = this.plots.find((entry) => entry.id === this.selectedPlotId)!;
    const stats = this.stats?.plotId === plot.id ? this.stats : null;
    const indexedAt = stats?.freshness.indexedThroughAt;
    const indexLabel =
      indexedAt === null || indexedAt === undefined
        ? "Parking events are not indexed yet."
        : `Parking events through ${new Date(indexedAt).toLocaleString()}${Date.now() - indexedAt > 600_000 ? " · catching up" : ""}.`;
    const exposureLabel = stats?.freshness.impressionReceivedAt
      ? `Latest view report ${new Date(stats.freshness.impressionReceivedAt).toLocaleString()}.`
      : "No approved-ad views have been recorded for this plot.";
    this.host.innerHTML = `<div class="stats-heading"><button id="stats-back">← City map</button><div><h1>Advertiser stats</h1><p>Read-only · last 7 days</p></div></div>
      <section class="card advertiser-stats-controls">
        <label>Building <select id="stats-plot" aria-label="Choose a plot">${this.plots.map((entry) => `<option value="${html(entry.id)}" ${entry.id === plot.id ? "selected" : ""}>${html(entry.label)}</option>`).join("")}</select></label>
        ${this.liveAvailable ? `<button id="stats-refresh" ${this.loading ? "disabled" : ""}>${this.loading ? "Loading…" : "Refresh statistics"}</button>` : ""}
      </section>
      ${!this.liveAvailable ? `<section class="card"><h2>Guest preview</h2><p>Connect this build to the testnet city to see live advertiser statistics.</p></section>` : ""}
      ${this.loading ? `<p class="muted" role="status">Loading plot statistics…</p>` : ""}
      ${this.error ? `<p class="card" role="alert">${html(this.error)}. Try again in a moment.</p>` : ""}
      ${
        stats
          ? `<section class="card"><h2>${html(plot.label)}</h2>
        <div class="owner-stats-grid"><div><span>Estimated views</span><strong>${stats.totals.impressions}</strong></div><div><span>Average visible time</span><strong>${(stats.totals.averageVisibleMs / 1_000).toFixed(1)} s</strong></div><div><span>Parks</span><strong>${stats.totals.parks}</strong></div><div><span>Tickets</span><strong>${stats.totals.tickets}</strong></div></div>
        <p class="muted">${html(indexLabel)} ${html(exposureLabel)} Views are client-reported estimates, not billing records.</p>
        <div class="owner-stats-days">${stats.days.map((day) => `<div class="owner-stats-day"><strong>${html(day.day)}</strong><span>${day.impressions} views · ${(day.averageVisibleMs / 1_000).toFixed(1)} s average · ${day.parks} parks · ${day.tickets} tickets</span></div>`).join("")}</div>
      </section>`
          : ""
      }`;
    this.host
      .querySelector<HTMLButtonElement>("#stats-back")!
      .addEventListener("click", this.onBack);
    this.host
      .querySelector<HTMLSelectElement>("#stats-plot")!
      .addEventListener("change", (event) => {
        this.selectedPlotId = (event.target as HTMLSelectElement).value;
        this.stats = null;
        this.render();
        if (this.liveAvailable) void this.load();
      });
    this.host
      .querySelector<HTMLButtonElement>("#stats-refresh")
      ?.addEventListener("click", () => void this.load());
  }
}
