import {
  BuildingType,
  CarBody,
  CarColor,
  formatCoins,
  MaterialHint,
  ParkingRule,
  PlotStats,
  TOWER_FLOORS,
  TOWER_SPACES_PER_FLOOR,
  ThemeHint,
  type ChainOwnerConfig,
  type NPCSite,
  type ChainPlayerSnapshot,
  type ChainPlot,
  type ChainPlotPurchaseBreakdown,
  type ChainSession,
  type ChainStreetSide,
} from "@estate/shared";
import { ChainReader } from "./chain-reader.js";
import { garageRecovery } from "./garage-recovery.js";
import { PRESET_PALETTES } from "./preset-catalog.js";
import { sessionFullPayout } from "./plot-earnings.js";
import { buildingMarkup } from "./studio-screen.js";
import {
  GameWalletClient,
  type ArtworkUpload,
  type GameplayKeyStatus,
  type MediaProposalRecord,
  type MockGenerationJob,
  type PaidGenerationJob,
} from "./wallet-client.js";
import "@near-wallet-selector/modal-ui/styles.css";

type RoadSide = {
  roadId: ChainStreetSide["road_id"];
  side: ChainStreetSide["side"];
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

function ruleLabel(
  rule: ChainStreetSide["plots"][number]["plot"]["effective_rule"],
): string {
  switch (rule.kind) {
    case "Free":
      return "Free parking";
    case "NoParking":
      return "No parking";
    case "ColorOnly":
      return `${rule.color} cars only`;
    case "Meter":
      return `Meter · ${formatCoins(rule.ratePerHour)} coins/hour`;
  }
}

function nearAmount(yocto: string): string {
  const value = BigInt(yocto);
  const whole = value / 10n ** 24n;
  const fraction = (value % 10n ** 24n)
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} testnet NEAR`;
}

type OwnerDraft = {
  plotId: string;
  ruleKind: ChainPlot["effective_rule"]["kind"];
  meterRate: string;
  color: (typeof CarColor.options)[number];
  buildingType: (typeof BuildingType.options)[number];
  variant: 1 | 2;
  palette: string;
  name: string;
};

function draftForPlot(plot: ChainPlot): OwnerDraft {
  const rule = plot.plot.pending_rule?.rule ?? plot.effective_rule;
  return {
    plotId: plot.plot.id,
    ruleKind: rule.kind,
    meterRate: rule.kind === "Meter" ? formatCoins(rule.ratePerHour) : "5",
    color: rule.kind === "ColorOnly" ? rule.color : "Red",
    buildingType: plot.plot.building.building_type,
    variant: plot.plot.building.variant as 1 | 2,
    palette: plot.plot.building.primary_color,
    name: plot.plot.building.name,
  };
}

function coinInput(value: string): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error("Enter a coin amount with up to six decimals");
  return (
    BigInt(match[1]!) * 1_000_000n +
    BigInt((match[2] ?? "").padEnd(6, "0"))
  ).toString();
}

function selectedCandidateIndex(job: MockGenerationJob): number {
  const index = job.candidates.findIndex(
    (candidate) => candidate.id === job.selectedCandidateId,
  );
  return Math.max(0, index);
}

export class ChainScreen {
  private wallet: GameWalletClient | null = null;
  private player: ChainPlayerSnapshot | null = null;
  private street: ChainStreetSide | null = null;
  private plots: ChainPlot[] = [];
  private ownerConfig: ChainOwnerConfig | null = null;
  private ownerFetchedAt = 0;
  private ownerError = "";
  private plotStats: PlotStats | null = null;
  private plotStatsError = "";
  private plotStatsLoading = false;
  private plotStatsRequest = 0;
  private chainTime = 0;
  private chainTimeReadAt = 0;
  private purchasePreview: {
    plotId: string;
    breakdown: ChainPlotPurchaseBreakdown;
  } | null = null;
  private selectedOwnedPlotId: string | null = null;
  private ownerDraft: OwnerDraft | null = null;
  private pendingUpload:
    | (ArtworkUpload & { plotId: string; kind: "Logo" | "Billboard" })
    | null = null;
  private mediaProposal: MediaProposalRecord | null = null;
  private mediaLinkDraft = "";
  private mockJob: MockGenerationJob | null = null;
  private paidJob: PaidGenerationJob | null = null;
  private paidAvailable: boolean | null = null;
  private mockHistory: MockGenerationJob[] | null = null;
  private mockDescription = "";
  private mockThemeHint: ThemeHint = "None";
  private mockMaterials: MaterialHint[] = [];
  private usePriorArt = true;
  private selectedMockCandidate = 0;
  private keyStatus: GameplayKeyStatus = "none";
  private accountId: string | null = null;
  private selectedCarId: number | null = null;
  private quote: string | null = null;
  private towerAvailable: number | null = null;
  private towerFloors: number[] | null = null;
  private towerSpaces: (ChainSession | null)[] | null = null;
  private towerSpaceError = "";
  private selectedTowerFloor = 0;
  private busy = false;
  private message = "";
  private visible = false;
  private focusOwnedOnRender = false;
  private generation = 0;
  private pollId: number | null = null;
  private countdownId: number | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly reader: ChainReader,
    private readonly getRoadSide: () => RoadSide,
    private readonly sites: NPCSite[],
    private readonly getWallet: () => Promise<GameWalletClient>,
  ) {}

  async show(focusOwned = false): Promise<void> {
    this.visible = true;
    if (focusOwned) this.focusOwnedOnRender = true;
    this.render();
    if (!this.wallet) {
      try {
        this.wallet = await this.getWallet();
        this.wallet.selector.store.observable.subscribe(() => {
          if (this.visible) void this.refresh();
        });
      } catch (error) {
        this.message =
          error instanceof Error ? error.message : "Wallet setup failed";
        this.render();
        return;
      }
    }
    if (!this.visible) return;
    if (this.paidAvailable === null)
      this.paidAvailable = await this.wallet
        .paidGenerationEnabled()
        .catch(() => false);
    await this.refresh();
    if (this.pollId === null) {
      this.pollId = window.setInterval(() => {
        const focused = document.activeElement;
        const editingOwner =
          focused instanceof HTMLElement &&
          Boolean(focused.closest("#chain-owned-plots"));
        if (this.visible && !this.busy && !editingOwner) void this.refresh();
      }, 15_000);
    }
    if (this.countdownId === null) {
      this.countdownId = window.setInterval(
        () => this.updateCountdown(),
        1_000,
      );
    }
  }

  hide(): void {
    this.visible = false;
    this.generation++;
    this.plotStatsRequest++;
    this.plotStatsLoading = false;
    if (this.pollId !== null) {
      window.clearInterval(this.pollId);
      this.pollId = null;
    }
    if (this.countdownId !== null) {
      window.clearInterval(this.countdownId);
      this.countdownId = null;
    }
  }

  private async refresh(keepMessage = false): Promise<void> {
    const generation = ++this.generation;
    const accountId = this.wallet?.accountId ?? null;
    if (this.accountId !== accountId) {
      this.player = null;
      this.selectedCarId = null;
      this.selectedOwnedPlotId = null;
      this.ownerDraft = null;
      this.purchasePreview = null;
      this.pendingUpload = null;
      this.mediaProposal = null;
      this.mediaLinkDraft = "";
      this.mockJob = null;
      this.paidJob = null;
      this.mockHistory = null;
      this.mockDescription = "";
      this.mockThemeHint = "None";
      this.mockMaterials = [];
      this.selectedMockCandidate = 0;
      this.plots = [];
      this.ownerConfig = null;
      this.ownerFetchedAt = 0;
      this.ownerError = "";
      this.plotStats = null;
      this.plotStatsError = "";
      this.plotStatsLoading = false;
      this.plotStatsRequest++;
      this.keyStatus = "none";
      this.accountId = accountId;
    }
    const { roadId, side } = this.getRoadSide();
    const tower = this.sites.find(
      (site) =>
        site.roadId === roadId &&
        site.side === side &&
        site.role === "ParkingTower",
    );
    const selectedTowerFloor = this.selectedTowerFloor;
    const loadOwner = Boolean(
      accountId && Date.now() - this.ownerFetchedAt >= 60_000,
    );
    const ownerState = loadOwner
      ? Promise.all([
          this.reader.plots(),
          this.reader.ownerConfig(),
          this.reader.chainTimeSeconds(),
        ]).then(
          ([plots, config, chainTime]) => ({ plots, config, chainTime }),
          (error: unknown) => ({ error }),
        )
      : Promise.resolve(null);
    try {
      const [
        street,
        player,
        keyStatus,
        quote,
        towerState,
        towerSpaceState,
        owner,
      ] = await Promise.all([
        this.reader.streetSide(roadId, side),
        accountId ? this.reader.player(accountId) : Promise.resolve(null),
        accountId && this.wallet
          ? this.wallet.resumePendingKey()
          : Promise.resolve("none" as const),
        accountId ? this.reader.registrationQuote() : Promise.resolve(null),
        tower ? this.reader.towerState(tower.id) : Promise.resolve(null),
        tower
          ? this.reader.towerFloorSessions(tower.id, selectedTowerFloor).then(
              (spaces) => ({ spaces }),
              (error: unknown) => ({ error }),
            )
          : Promise.resolve(null),
        ownerState,
      ]);
      if (
        !this.visible ||
        generation !== this.generation ||
        this.wallet?.accountId !== accountId
      )
        return;
      this.street = street;
      this.player = player;
      this.keyStatus = keyStatus;
      this.quote = quote;
      this.towerFloors = towerState?.floors ?? null;
      this.towerAvailable = towerState?.available ?? null;
      this.towerSpaces =
        towerSpaceState && "spaces" in towerSpaceState
          ? towerSpaceState.spaces
          : null;
      this.towerSpaceError =
        towerSpaceState && "error" in towerSpaceState
          ? towerSpaceState.error instanceof Error
            ? towerSpaceState.error.message
            : "Could not load tower spaces"
          : "";
      if (owner && "error" in owner) {
        this.ownerError =
          owner.error instanceof Error
            ? owner.error.message
            : "Could not load owner data";
      } else if (owner && "plots" in owner) {
        this.plots = owner.plots;
        this.ownerConfig = owner.config;
        this.chainTime = owner.chainTime;
        this.chainTimeReadAt = Date.now();
        this.ownerFetchedAt = Date.now();
        this.ownerError = "";
      }
      if (
        this.purchasePreview &&
        this.plots.find(
          (entry) => entry.plot.id === this.purchasePreview?.plotId,
        )?.plot.owner
      )
        this.purchasePreview = null;
      const ownedPlots = this.plots.filter(
        (entry) => entry.plot.owner === accountId,
      );
      if (
        !ownedPlots.some((entry) => entry.plot.id === this.selectedOwnedPlotId)
      ) {
        this.selectedOwnedPlotId = ownedPlots[0]?.plot.id ?? null;
        this.ownerDraft = null;
        this.plotStats = null;
        this.plotStatsRequest++;
      }
      const selectedOwnedPlot = ownedPlots.find(
        (entry) => entry.plot.id === this.selectedOwnedPlotId,
      );
      if (
        selectedOwnedPlot &&
        this.ownerDraft?.plotId !== selectedOwnedPlot.plot.id
      )
        this.ownerDraft = draftForPlot(selectedOwnedPlot);
      if (!keepMessage) this.message = "";
      const walletSelection = this.wallet?.selectedCarId();
      if (player?.cars.some((car) => car.id === walletSelection))
        this.selectedCarId = walletSelection ?? null;
      if (
        player?.cars.length &&
        !player.cars.some((car) => car.id === this.selectedCarId)
      ) {
        this.selectedCarId = player.cars[0]!.id;
        this.wallet?.selectCar(this.selectedCarId);
      }
      this.render();
    } catch (error) {
      if (!this.visible || generation !== this.generation) return;
      this.street = null;
      this.player = null;
      this.towerAvailable = null;
      this.towerFloors = null;
      this.towerSpaces = null;
      this.towerSpaceError = "";
      this.keyStatus = "none";
      this.message =
        error instanceof Error ? error.message : "Chain read failed";
      this.render();
    }
  }

  private async mutate(action: () => Promise<string | void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.message = "Waiting for wallet or chain confirmation…";
    this.render();
    try {
      this.message = (await action()) || "Confirmed on testnet.";
    } catch (error) {
      this.message =
        error instanceof Error ? error.message : "Testnet action failed";
    } finally {
      this.busy = false;
      if (this.visible) await this.refresh(true);
    }
  }

  private async previewPlotPurchase(plotId: string): Promise<void> {
    if (this.busy) return;
    const accountId = this.wallet?.accountId;
    if (!accountId) return;
    this.busy = true;
    this.message = "Checking the current plot price…";
    this.render();
    try {
      const breakdown = await this.reader.plotPurchaseBreakdown(plotId);
      if (
        BigInt(breakdown.price_yocto) +
          BigInt(breakdown.storage_reserve_yocto) !==
        BigInt(breakdown.total_yocto)
      )
        throw new Error("Plot price breakdown does not add up");
      if (!this.visible || this.wallet?.accountId !== accountId) return;
      this.purchasePreview = { plotId, breakdown };
      this.message = "Review the total wallet deposit before buying.";
    } catch (error) {
      if (!this.visible || this.wallet?.accountId !== accountId) return;
      this.purchasePreview = null;
      this.message =
        error instanceof Error ? error.message : "Price check failed";
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private updateCountdown(): void {
    if (!this.visible || !this.chainTimeReadAt) return;
    const now =
      this.chainTime + Math.floor((Date.now() - this.chainTimeReadAt) / 1000);
    this.host
      .querySelectorAll<HTMLElement>("[data-effective-at]")
      .forEach((item) => {
        const seconds = Math.max(0, Number(item.dataset.effectiveAt) - now);
        item.textContent =
          seconds > 0
            ? `Starts in ${Math.floor(seconds / 60)}m ${seconds % 60}s`
            : "Active now; refresh to confirm";
      });
    const earnUntil = this.host.querySelector<HTMLElement>("[data-earn-until]");
    if (earnUntil) {
      const seconds = Math.max(0, Number(earnUntil.dataset.earnUntil) - now);
      earnUntil.textContent =
        seconds > 0
          ? `Full payout in ${Math.floor(seconds / 60)}m ${seconds % 60}s`
          : "Full payout ready";
      const advice = this.host.querySelector<HTMLElement>(
        "[data-collect-advice]",
      );
      if (advice)
        advice.textContent =
          seconds > 0
            ? "Collect sooner for partial earnings"
            : "Full payout reached";
    }
    const expiresAt = this.host.querySelector<HTMLElement>(
      "[data-park-expires]",
    );
    if (expiresAt) {
      const seconds = Math.max(0, Number(expiresAt.dataset.parkExpires) - now);
      expiresAt.textContent =
        seconds > 0
          ? `Parking expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s`
          : "Parking expired; settle to free the car";
      const collect =
        this.host.querySelector<HTMLButtonElement>("#chain-collect");
      if (collect)
        collect.textContent =
          seconds === 0
            ? "Settle expired parking"
            : earnUntil && now >= Number(earnUntil.dataset.earnUntil)
              ? "Collect full payout"
              : "Collect parked car";
    }
    const emergency = this.host.querySelector<HTMLButtonElement>(
      "#chain-emergency-repair",
    );
    if (emergency) {
      const availableAt = Number(emergency.dataset.availableAt);
      const seconds = Math.max(0, availableAt - now);
      emergency.disabled =
        this.busy || this.keyStatus !== "ready" || seconds > 0;
      const countdown = this.host.querySelector<HTMLElement>(
        "#chain-emergency-countdown",
      );
      if (countdown)
        countdown.textContent =
          seconds > 0
            ? `Available in ${Math.floor(seconds / 60)}m ${seconds % 60}s`
            : "Ready now";
    }
  }

  private mockStudioMarkup(selected: ChainPlot, accountId: string): string {
    const plot = selected.plot;
    const building = plot.building;
    const job =
      this.mockJob?.plotId === plot.id && this.mockJob.accountId === accountId
        ? this.mockJob
        : null;
    const paidJob = this.paidJob?.plotId === plot.id ? this.paidJob : null;
    const selectedIndex = job?.selectedCandidateId
      ? selectedCandidateIndex(job)
      : this.selectedMockCandidate;
    const chosenCandidate = job?.candidates[selectedIndex];
    const decision =
      chosenCandidate &&
      building.last_appearance_decision?.reference.manifest_hash ===
        chosenCandidate.manifestHash
        ? building.last_appearance_decision
        : null;
    const current = Boolean(
      job &&
        job.buildingType === building.building_type &&
        job.level === building.level &&
        job.layoutRevision === building.layout_revision,
    );
    const choice = current || decision ? chosenCandidate : null;
    const pending =
      choice &&
      building.pending_appearance?.manifest_hash === choice.manifestHash;
    const canSubmit = Boolean(
      current &&
        job &&
        choice &&
        (job.status === "ready" || job.status === "selected") &&
        (building.appearance_revision === job.appearanceRevision ||
          Boolean(pending)),
    );
    const neighbour = (offset: number) => {
      const other = this.plots.find(
        (entry) =>
          entry.plot.road_id === plot.road_id &&
          entry.plot.side === plot.side &&
          entry.plot.index === plot.index + offset,
      );
      if (!other)
        return `<div class="owner-neighbour"><span>Street end</span></div>`;
      const look = other.plot.building;
      return `<div class="owner-neighbour">${buildingMarkup(look.building_type, look.variant, look.level, look.primary_color)}<span>${html(look.name || `Plot ${other.plot.index + 1}`)}</span></div>`;
    };
    return `<div class="owner-mock-studio"><h4>${job?.mode === "paid" ? "Prompt-generated designs" : "Explore three designs"}</h4>
      <p class="muted">${job?.mode === "paid" ? "These private designs use your description. Choose one for review; your current building stays live until approval." : "Curated designs use building art from the game. Your description is saved with the private job but does not change these images."}</p>
      <label>Your idea <textarea id="owner-mock-description" maxlength="800" rows="3" placeholder="A greenhouse café with copper trim…">${html(this.mockDescription)}</textarea></label>
      <details class="owner-style-hints"><summary>Style hints (optional)</summary>
        <label>Theme <select id="owner-mock-theme">${ThemeHint.options.map((theme) => `<option value="${theme}" ${theme === this.mockThemeHint ? "selected" : ""}>${theme}</option>`).join("")}</select></label>
        <fieldset><legend>Materials (up to two)</legend>${MaterialHint.options.map((material) => `<label><input type="checkbox" data-owner-material="${material}" ${this.mockMaterials.includes(material) ? "checked" : ""} ${this.mockMaterials.length >= 2 && !this.mockMaterials.includes(material) ? "disabled" : ""}> ${material}</label>`).join("")}</fieldset>
      </details>
      ${this.paidAvailable ? `<label><input id="owner-use-prior-art" type="checkbox" ${this.usePriorArt ? "checked" : ""}> Use my last approved building as a starting point when available</label>` : ""}
      <button id="owner-generate-mock" ${this.busy || !this.mockDescription.trim() ? "disabled" : ""}>Explore curated designs</button>
      ${this.paidAvailable ? `<button id="owner-generate-paid" ${this.busy || !this.mockDescription.trim() ? "disabled" : ""}>Generate prompt art (invite pilot)</button><button id="owner-restore-paid" ${this.busy ? "disabled" : ""}>Restore prompt job</button>` : ""}
      ${paidJob ? `<div class="owner-paid-progress"><p>Prompt job: ${html(paidJob.status.replaceAll("_", " "))} · ${paidJob.acceptedCount} generated, ${paidJob.reviewedCount} reviewed, ${paidJob.approvedCount} approved · ${paidJob.attemptsStarted} of 4 attempts used.</p>${paidJob.status === "uncertain" ? `<p class="muted">The image provider result needs operator review. No automatic retry will be made.</p>` : ""}${paidJob.status === "awaiting_review" ? `<p class="muted">A moderator is checking content and style. The designs will appear after review.</p>` : ""}${paidJob.status === "review_rejected" ? `<p class="muted">No generated design passed review. Your current building is unchanged.</p>` : ""}${paidJob.status === "expired" ? `<p class="muted">Unchosen previews expire after seven days. Generate a new set to continue.</p>` : ""}<button id="owner-refresh-paid" ${this.busy ? "disabled" : ""}>Refresh prompt job</button></div>` : ""}
      <button id="owner-restore-mock" ${this.busy ? "disabled" : ""}>Restore last designs</button>
      <button id="owner-history-mock" ${this.busy ? "disabled" : ""}>View design history</button>
      ${job?.status === "expired" ? `<p class="chain-parked">These unchosen previews expired after seven days. Generate a new set to continue.</p>` : ""}
      ${this.mockHistory ? `<ul class="owner-design-history">${this.mockHistory.map((entry) => `<li>${new Date(entry.createdAt * 1000).toLocaleDateString()} · ${html(entry.status)} · design ${entry.selectedCandidateId ?? "—"}${entry.decisionReason ? ` · ${html(entry.decisionReason)}` : ""}</li>`).join("") || "<li>No earlier designs.</li>"}</ul>` : ""}
      ${job && !current && !decision ? `<p class="chain-parked">The building changed after this job. Generate again for the current type and level.</p>` : ""}
      ${
        choice && job
          ? `<div class="owner-generation-candidates" data-count="${job.candidates.length}">${job.candidates.map((candidate, index) => `<button type="button" data-owner-candidate="${index}" aria-pressed="${index === selectedIndex}" ${job.status !== "ready" ? "disabled" : ""}><img src="${html(candidate.thumbnailUrl)}" alt="" width="140" height="160" /><span>Design ${candidate.id}${job.mode === "paid" ? " · generated" : ` · shape ${candidate.variant}`}</span></button>`).join("")}</div>
      <p class="muted">Choose a design to preview it beside the neighbouring plots. Submitting asks your wallet to publish a proposal for moderator review.</p>
      <div class="owner-street-preview" aria-label="Selected design beside current neighbouring plots">
        ${neighbour(-1)}
        <div class="owner-neighbour selected"><img src="${html(choice!.thumbnailUrl)}" alt="" width="140" height="160" /><span>Selected design</span></div>
        ${neighbour(1)}
      </div>
      ${pending ? `<p class="chain-parked">This design is pending moderator review on testnet.</p>` : ""}
      ${decision?.status === "Approved" ? `<p class="chain-parked">This design was approved on testnet.</p>` : ""}
      ${decision?.status === "Rejected" ? `<p class="chain-parked">This design was rejected: ${html(decision.reason ?? "No reason supplied")}</p>` : ""}
      ${decision?.status === "Revoked" ? `<p class="chain-parked">This design was withdrawn: ${html(decision.reason ?? "No reason supplied")}</p>` : ""}
      ${job.status === "selected" && !pending && !decision ? `<p class="chain-parked">Your choice is saved. Submit it or check whether your earlier wallet action confirmed.</p>` : ""}
      ${canSubmit && !decision ? `<button id="owner-submit-mock" ${this.busy ? "disabled" : ""}>${pending ? "Confirm proposal" : job.status === "selected" ? "Submit or check proposal" : "Submit selected design for review"}</button>` : ""}`
          : ""
      }
    </div>`;
  }

  private ownerMediaMarkup(selected: ChainPlot): string {
    const plot = selected.plot;
    const status = (["Logo", "Billboard"] as const)
      .map((kind) => {
        const slot = kind === "Logo" ? plot.logo : plot.billboard;
        const eligible =
          kind === "Logo"
            ? selected.logo_eligible
            : selected.billboard_eligible;
        const active = eligible ? slot.active : null;
        const decision = slot.last_decision;
        return `<div class="owner-media-status"><strong>${kind}</strong> · ${active ? "Visible on this building" : slot.pending ? "Awaiting review" : slot.active ? "Hidden after building change" : "Showing fallback"}
          ${active ? `<img class="owner-upload-preview" src="/api/assets/${html(active.content.asset_hash)}" alt="Approved ${kind.toLowerCase()}" />` : ""}
          ${active?.content.link ? `<a href="${html(active.content.link)}" target="_blank" rel="noopener noreferrer">Approved link</a>` : ""}
          ${decision?.status === "Rejected" || decision?.status === "Revoked" ? `<p class="chain-parked">${decision.status}: ${html(decision.reason ?? "No reason supplied")}</p>` : ""}
          ${slot.active && !eligible && !slot.pending ? `<button type="button" data-owner-reuse-media="${kind}" ${this.busy ? "disabled" : ""}>Reuse approved ${kind.toLowerCase()}</button>` : ""}
          ${slot.active || slot.pending ? `<button type="button" data-owner-remove-media="${kind}" ${this.busy ? "disabled" : ""}>Remove ${kind.toLowerCase()}</button>` : ""}
        </div>`;
      })
      .join("");
    const upload =
      this.pendingUpload?.plotId === plot.id ? this.pendingUpload : null;
    const proposal =
      this.mediaProposal?.plotId === plot.id ? this.mediaProposal : null;
    return `<div class="owner-media"><h4>Logo and billboard</h4>
      <p class="muted">Upload a PNG, JPEG or WebP image up to 1 MB. It stays private until your wallet proposes it and a moderator approves it.</p>
      ${status}
      <label>Logo <input id="owner-logo-file" type="file" accept="image/png,image/jpeg,image/webp" /></label>
      <button id="owner-upload-logo" ${this.busy ? "disabled" : ""}>Upload logo</button>
      <button id="owner-restore-logo" ${this.busy ? "disabled" : ""}>Restore last logo</button>
      <label>Billboard <input id="owner-ad-file" type="file" accept="image/png,image/jpeg,image/webp" /></label>
      <button id="owner-upload-ad" ${this.busy ? "disabled" : ""}>Upload billboard</button>
      <button id="owner-restore-ad" ${this.busy ? "disabled" : ""}>Restore last billboard</button>
      ${
        upload
          ? `<p class="chain-parked">${upload.kind} image · ${upload.hash.slice(0, 12)}…</p><img class="owner-upload-preview" src="${html(upload.url)}" alt="Uploaded ${upload.kind.toLowerCase()} preview" />
        ${upload.layoutRevision !== plot.building.layout_revision ? `<p class="muted">This upload belongs to an earlier building layout. Use Reuse approved ${upload.kind.toLowerCase()} above, or upload the image again.</p>` : ""}
        <label>Destination link (optional) <input id="owner-media-link" type="url" maxlength="256" placeholder="https://brand.example" value="${html(this.mediaLinkDraft)}" ${proposal?.status === "selected" ? "disabled" : ""} /></label>
        ${!proposal || proposal.status !== "selected" ? `<button id="owner-create-media" ${this.busy || upload.layoutRevision !== plot.building.layout_revision ? "disabled" : ""}>Prepare ${upload.kind.toLowerCase()} proposal</button>` : ""}`
          : ""
      }
      ${
        proposal
          ? `<p class="chain-parked">${proposal.kind} proposal: ${html(proposal.status)}${proposal.decisionReason ? ` · ${html(proposal.decisionReason)}` : ""}</p>
        ${!proposal.assetUrl && !upload ? `<p class="muted">This rejected private image has expired. Upload a new image to try again; its review decision remains saved.</p>` : ""}
        ${proposal.status === "selected" ? `<button id="owner-submit-media" ${this.busy ? "disabled" : ""}>Submit or check ${proposal.kind.toLowerCase()} proposal</button>` : ""}`
          : ""
      }
    </div>`;
  }

  private async loadPlotStats(plotId: string): Promise<void> {
    const request = ++this.plotStatsRequest;
    this.plotStatsLoading = true;
    this.plotStatsError = "";
    this.render();
    try {
      const response = await fetch(
        `/api/stats/plots/${encodeURIComponent(plotId)}`,
        {
          cache: "no-store",
        },
      );
      if (!response.ok)
        throw new Error(`Statistics unavailable (${response.status})`);
      const stats = PlotStats.parse(await response.json());
      if (!this.visible || request !== this.plotStatsRequest) return;
      this.plotStats = stats;
    } catch (error) {
      if (!this.visible || request !== this.plotStatsRequest) return;
      this.plotStatsError =
        error instanceof Error ? error.message : "Statistics unavailable";
    } finally {
      if (this.visible && request === this.plotStatsRequest) {
        this.plotStatsLoading = false;
        this.render();
      }
    }
  }

  private plotStatsMarkup(plotId: string): string {
    const stats = this.plotStats?.plotId === plotId ? this.plotStats : null;
    const indexedAt = stats?.freshness.indexedThroughAt;
    const indexLabel =
      indexedAt === null || indexedAt === undefined
        ? "Parking events are not indexed yet."
        : `Parking events through ${new Date(indexedAt).toLocaleString()}${Date.now() - indexedAt > 600_000 ? " · catching up" : ""}.`;
    const exposureLabel = stats?.freshness.impressionReceivedAt
      ? `Latest view report ${new Date(stats.freshness.impressionReceivedAt).toLocaleString()}.`
      : "No approved-ad views have been recorded for this plot.";
    return `<div class="owner-section owner-stats"><h3>Plot statistics · last 7 days</h3>
      <button id="owner-load-stats" ${this.plotStatsLoading ? "disabled" : ""}>${this.plotStatsLoading ? "Loading…" : stats ? "Refresh statistics" : "View statistics"}</button>
      ${this.plotStatsError ? `<p role="alert">${html(this.plotStatsError)}</p>` : ""}
      ${
        stats
          ? `<div class="owner-stats-grid"><div><span>Estimated views</span><strong>${stats.totals.impressions}</strong></div><div><span>Average visible time</span><strong>${(stats.totals.averageVisibleMs / 1_000).toFixed(1)} s</strong></div><div><span>Parks</span><strong>${stats.totals.parks}</strong></div><div><span>Tickets</span><strong>${stats.totals.tickets}</strong></div></div>
        <p class="muted">${html(indexLabel)} ${html(exposureLabel)} Views are client-reported estimates, not billing records.</p>
        <div class="owner-stats-days">${stats.days.map((day) => `<div class="owner-stats-day"><strong>${html(day.day)}</strong><span>${day.impressions} views · ${(day.averageVisibleMs / 1_000).toFixed(1)} s average · ${day.parks} parks · ${day.tickets} tickets</span></div>`).join("")}</div>`
          : ""
      }
    </div>`;
  }

  private ownerMarkup(
    accountId: string,
    balance: string,
    keyReady: boolean,
  ): string {
    if (this.ownerError)
      return `<section class="card" id="chain-owned-plots"><h2>My plots</h2><p>Owner tools are temporarily unavailable: ${html(this.ownerError)}</p><button id="chain-retry-owner">Retry owner tools</button></section>`;
    const owned = this.plots.filter((entry) => entry.plot.owner === accountId);
    const selected = owned.find(
      (entry) => entry.plot.id === this.selectedOwnedPlotId,
    );
    const config = this.ownerConfig;
    const draft = this.ownerDraft;
    if (!owned.length)
      return `<section class="card" id="chain-owned-plots"><h2>My plots</h2><p>You do not own a plot yet. Explore available plots on the current street below.</p></section>`;
    if (!selected || !draft || !config)
      return `<section class="card" id="chain-owned-plots"><h2>My plots</h2><p>Loading owner controls…</p></section>`;
    const plot = selected.plot;
    const building = plot.building;
    const pending =
      plot.pending_rule && plot.pending_rule.effective_at > this.chainTime;
    const typeCost = BigInt(config.change_building_type_cost);
    const levelCost =
      building.level < 4
        ? BigInt(config.building_upgrade_costs[building.level - 1]!)
        : null;
    const levelShortfall =
      levelCost !== null && BigInt(balance) < levelCost
        ? (levelCost - BigInt(balance)).toString()
        : null;
    const changingType = draft.buildingType !== building.building_type;
    const affectedMedia = (["logo", "billboard"] as const).filter(
      (kind) => plot[kind].active || plot[kind].pending,
    );
    return `<section class="card" id="chain-owned-plots"><h2>My plots · ${owned.length}</h2>
      <label>Manage plot <select id="chain-owned-plot">${owned.map((entry) => `<option value="${html(entry.plot.id)}" ${entry.plot.id === plot.id ? "selected" : ""}>${html(entry.plot.road_id)} · ${entry.plot.side} · Plot ${entry.plot.index + 1}${entry.plot.corner ? " (corner)" : ""}</option>`).join("")}</select></label>
      <div class="owner-grid">
        <div class="owner-section"><h3>Parking rules</h3>
          <p>Current: <strong>${html(ruleLabel(selected.effective_rule))}</strong></p>
          ${pending ? `<p class="chain-parked">Next: ${html(ruleLabel(plot.pending_rule!.rule))} · <span data-effective-at="${plot.pending_rule!.effective_at}"></span></p>` : ""}
          <p class="muted">Changes take effect ${Math.floor(config.rule_delay_seconds / 60)} minutes after confirmation. Cars already parked keep the rule they arrived under.</p>
          <label>New rule <select id="owner-rule-kind">${["Free", "Meter", "ColorOnly", "NoParking"].map((kind) => `<option value="${kind}" ${kind === draft.ruleKind ? "selected" : ""}>${kind === "ColorOnly" ? "One car colour" : kind === "NoParking" ? "No parking" : kind}</option>`).join("")}</select></label>
          ${draft.ruleKind === "Meter" ? `<label>Coins per hour <input id="owner-meter-rate" type="number" min="0" max="${html(formatCoins(config.meter_rate_max_per_hour))}" step="0.000001" value="${html(draft.meterRate)}" /></label><p class="muted">Maximum ${formatCoins(config.meter_rate_max_per_hour)} coins/hour. The fee is capped at half the driver's earnings.</p>` : ""}
          ${draft.ruleKind === "ColorOnly" ? `<label>Allowed colour <select id="owner-rule-color">${CarColor.options.map((color) => `<option value="${color}" ${color === draft.color ? "selected" : ""}>${color}</option>`).join("")}</select></label>` : ""}
          <button id="owner-save-rule" ${!keyReady || this.busy ? "disabled" : ""}>Schedule rule change</button>
          ${!keyReady ? `<p class="muted">Enable the gameplay key above to change parking rules.</p>` : ""}
        </div>
        <div class="owner-section"><h3>Building</h3>
          <p>${html(building.building_type)} · level ${building.level} · shape ${building.variant}</p>
          <div class="owner-building-preview">${buildingMarkup(draft.buildingType, draft.variant, building.level, draft.palette)}</div>
          <label>Type <select id="owner-building-type">${BuildingType.options.map((type) => `<option value="${type}" ${type === draft.buildingType ? "selected" : ""}>${type}</option>`).join("")}</select></label>
          <label>Shape <select id="owner-building-variant"><option value="1" ${draft.variant === 1 ? "selected" : ""}>Shape 1</option><option value="2" ${draft.variant === 2 ? "selected" : ""}>Shape 2</option></select></label>
          <label>Colour <select id="owner-building-palette">${PRESET_PALETTES.map((palette) => `<option value="${palette}" ${palette === draft.palette ? "selected" : ""}>${palette}</option>`).join("")}</select></label>
          <label>Name <input id="owner-building-name" maxlength="24" value="${html(draft.name)}" /></label>
          ${changingType ? `<button id="owner-change-type" ${this.busy || BigInt(balance) < typeCost ? "disabled" : ""}>Change type · ${formatCoins(config.change_building_type_cost)} coins</button><p class="muted">Changing type uses its curated preset and keeps level ${building.level}. Choose colour and name afterward.</p>` : `<button id="owner-save-preset" ${this.busy ? "disabled" : ""}>Use this preset</button>`}
          ${levelCost === null ? `<p>Maximum level reached.</p>` : `<button id="owner-upgrade-building" ${this.busy || BigInt(balance) < levelCost ? "disabled" : ""}>Upgrade to level ${building.level + 1} · ${formatCoins(config.building_upgrade_costs[building.level - 1]!)} coins</button>`}
          ${levelShortfall ? `<p class="muted">Earn ${formatCoins(levelShortfall)} more coins by parking and collecting before this upgrade is available.</p>` : ""}
          <p class="muted">Using a preset, changing type or upgrading immediately replaces the current facade with a curated design. Any custom facade must be reviewed again.</p>
          ${affectedMedia.length ? `<p class="chain-parked">A building change will hide the current ${affectedMedia.join(" and ")} until a moderator approves it for the new layout. You can reuse an approved image or upload a new one. Pending media proposals will be cancelled.</p>` : ""}
          ${this.mockStudioMarkup(selected, accountId)}
          ${this.ownerMediaMarkup(selected)}
        </div>
      </div>
      ${this.plotStatsMarkup(plot.id)}
    </section>`;
  }

  private render(): void {
    if (!this.visible) return;
    const wallet = this.wallet;
    const player = this.player;
    const accountId = wallet?.accountId ?? null;
    const registered = Boolean(player?.account);
    const keyReady = this.keyStatus === "ready";
    const car = player?.cars.find((entry) => entry.id === this.selectedCarId);
    const session = player?.active_session;
    const now = Math.floor(Date.now() / 1000);
    const garageConfig = this.ownerConfig;
    const fullRepairPoints =
      car && garageConfig
        ? Math.max(0, garageConfig.max_durability - car.durability)
        : 0;
    const parkRepairPoints =
      car && garageConfig
        ? Math.max(0, garageConfig.park_durability_cost - car.durability)
        : 0;
    const repairRate = BigInt(garageConfig?.repair_cost_per_point ?? "0");
    const fullRepairCost = BigInt(fullRepairPoints) * repairRate;
    const parkRepairCost = BigInt(parkRepairPoints) * repairRate;
    const balance = BigInt(player?.account?.balance ?? "0");
    const chainNow = this.chainTimeReadAt
      ? this.chainTime + Math.floor((Date.now() - this.chainTimeReadAt) / 1000)
      : now;
    const recovery =
      player?.account && garageConfig
        ? garageRecovery(player.account, player.cars, garageConfig, chainNow)
        : null;
    const { roadId, side } = this.getRoadSide();
    const tower = this.sites.find(
      (site) =>
        site.roadId === roadId &&
        site.side === side &&
        site.role === "ParkingTower",
    );
    const busy = this.busy ? "disabled" : "";
    const carOptions = CarBody.options
      .map((body) => `<option value="${body}">${body}</option>`)
      .join("");
    const colorOptions = CarColor.options
      .map((color) => `<option value="${color}">${color}</option>`)
      .join("");
    this.host.innerHTML = `<div class="chain-screen">
      <div class="chain-heading"><div><span class="tag">Shared testnet state</span><h1>Live city</h1>
        <p class="muted">${html(roadId)} · ${side} side. The illustrated Street can switch between guest and testnet play.</p></div>
        <button id="chain-refresh" ${busy}>Refresh</button></div>
      ${this.message ? `<p class="chain-message" role="status">${html(this.message)}</p>` : ""}
      <section class="card chain-account"><h2>Wallet</h2>
        ${
          !wallet
            ? `<p>Loading supported wallets…</p>`
            : !accountId
              ? `<p>Connect MyNearWallet or Meteor on testnet.</p><button id="chain-connect" class="primary" ${this.street && !this.busy ? "" : "disabled"}>Connect wallet</button>`
              : `
          <p><strong>${html(accountId)}</strong></p>
          ${
            !registered
              ? `<p>Choose your free starter car. Registration requires ${this.quote ? html(nearAmount(this.quote)) : "a storage deposit"} from your wallet.</p>
            <label>Body <select id="starter-body">${carOptions}</select></label>
            <label>Colour <select id="starter-color">${colorOptions}</select></label>
            <button id="chain-register" class="primary" ${busy}>Register and get starter car</button>`
              : `
            <p>${formatCoins(player!.account!.balance)} coins · ${player!.cars.length} car${player!.cars.length === 1 ? "" : "s"}</p>
            <p>Gameplay key: ${this.keyStatus === "ready" ? "Ready for wallet-free play" : this.keyStatus === "pending" ? "Awaiting verification" : this.keyStatus === "inactive" ? "Inactive or out of gas" : "Off"}</p>
            ${this.keyStatus === "none" ? `<button id="chain-enable-key" ${busy}>Enable gameplay key</button>` : this.keyStatus === "ready" || this.keyStatus === "inactive" ? `<button id="chain-revoke-key" ${busy}>Revoke gameplay key</button>` : `<button id="chain-check-key" ${busy}>Retry or check key</button>`}
            ${wallet?.hasPendingGameplayAction() ? `<p class="chain-parked">A signed gameplay action is still being checked. Check it before disconnecting or signing another action.</p><button id="chain-check-action" ${busy}>Check pending action</button>` : ""}
            <p class="muted">The gameplay key is limited to this contract, selected methods and 0.25 testnet NEAR of gas. Disconnect revokes it on-chain first and may open your wallet.</p>
          `
          }
          <button id="chain-signout" ${busy}>${this.keyStatus === "ready" || this.keyStatus === "inactive" ? "Revoke key and disconnect" : "Disconnect wallet"}</button>`
        }
      </section>
      ${
        registered
          ? `<section class="card"><h2>My cars</h2>
        <label>Driving <select id="chain-car">${player!.cars.map((entry) => `<option value="${entry.id}" ${entry.id === this.selectedCarId ? "selected" : ""}>#${entry.id} ${entry.color} ${entry.body} · tier ${entry.tier} · ${entry.durability}${garageConfig ? `/${garageConfig.max_durability}` : ""} durability</option>`).join("")}</select></label>
        ${car && !garageConfig ? `<p class="muted">Loading current repair costs…</p>` : ""}
        ${car && garageConfig && fullRepairPoints > 0 && car.parked_session_id === null ? `<button id="chain-repair" ${!keyReady || this.busy || balance < fullRepairCost ? "disabled" : ""}>Repair to full · ${formatCoins(fullRepairCost.toString())} coins</button>` : ""}
        ${car && garageConfig && parkRepairPoints > 0 && parkRepairPoints < fullRepairPoints && car.parked_session_id === null ? `<button id="chain-repair-to-park" ${!keyReady || this.busy || balance < parkRepairCost ? "disabled" : ""}>Repair to park · ${formatCoins(parkRepairCost.toString())} coins</button>` : ""}
        ${recovery?.stranded ? `<button id="chain-emergency-repair" data-available-at="${recovery.availableAt ?? 0}" ${!keyReady || this.busy || !recovery.eligible ? "disabled" : ""}>Free starter repair</button><p class="muted" id="chain-emergency-countdown">${recovery.eligible ? "Ready now" : "Waiting for recovery cooldown"}</p>` : ""}
        ${car && car.tier < 3 && car.parked_session_id === null ? `<button id="chain-upgrade" ${busy}>Upgrade selected car</button>` : ""}
        ${
          session
            ? `<p class="chain-parked">Car #${session.car_id} is parked at ${html(session.location_id)} · space ${session.slot + 1}.</p>
          <p class="muted">Up to ${sessionFullPayout(session)} coins for this park · <span data-earn-until="${session.earn_until}"></span> · <span data-park-expires="${session.expires_at}"></span>. <span data-collect-advice>${now < session.earn_until ? "Collect sooner for partial earnings" : "Full payout reached"}</span>${session.legal ? "" : "; illegal parking can be ticketed"}.</p>
          <button id="chain-collect" class="primary" ${!keyReady || this.busy ? "disabled" : ""}>${now >= session.expires_at ? "Settle expired parking" : now >= session.earn_until ? "Collect full payout" : "Collect parked car"}</button>`
            : ""
        }
        <div class="chain-purchase"><label>New body <select id="chain-buy-body">${carOptions}</select></label>
          <label>Colour <select id="chain-buy-color">${colorOptions}</select></label>
          <button id="chain-buy-car" ${player!.cars.length >= 3 || this.busy ? "disabled" : ""}>Buy car with coins</button></div>
      </section>`
          : ""
      }
      ${registered && accountId ? this.ownerMarkup(accountId, player!.account!.balance, keyReady) : ""}
      <section class="card"><h2>${html(roadId)} · ${side} curb</h2>
        ${
          this.street
            ? `<div class="chain-plots">${this.street.plots
                .map(({ plot, slots }) => {
                  const owned = Boolean(
                    accountId && plot.plot.owner === accountId,
                  );
                  const title = plot.plot.building.name.startsWith("Plot ")
                    ? `Plot ${plot.plot.index + 1}`
                    : `${plot.plot.building.name} · Plot ${plot.plot.index + 1}`;
                  const open = slots.findIndex(
                    (entry) => !entry || now >= entry.expires_at,
                  );
                  const illegal = slots.find(
                    (entry) => entry && !entry.legal && now < entry.expires_at,
                  );
                  return `<article class="chain-plot"><h3>${html(title)}</h3>
            <p>${html(ruleLabel(plot.effective_rule))} · ${owned ? "Your plot" : plot.plot.owner ? `Owned by ${html(plot.plot.owner)}` : "Available to buy"}</p>
            <p>${slots.filter((entry) => entry && now < entry.expires_at).length}/2 spaces occupied</p>
            ${registered && !session && car && open >= 0 && !owned ? `<button data-chain-park="${html(plot.plot.id)}" data-slot="${open}" ${!keyReady || this.busy ? "disabled" : ""}>Park car #${car.id} here</button>` : ""}
            ${registered && owned && illegal ? `<button data-chain-ticket="${html(plot.plot.id)}" data-slot="${illegal.slot}" data-session="${illegal.id}" ${!keyReady || this.busy ? "disabled" : ""}>Ticket illegal parker</button>` : ""}
            ${
              registered && !plot.plot.owner
                ? `<button data-chain-quote-plot="${html(plot.plot.id)}" ${busy}>Review plot price</button>
              ${this.purchasePreview?.plotId === plot.plot.id ? `<div class="chain-purchase-preview"><p>Plot price: ${nearAmount(this.purchasePreview.breakdown.price_yocto)}</p><p>Owner storage reserve: ${nearAmount(this.purchasePreview.breakdown.storage_reserve_yocto)}</p><p><strong>Total wallet deposit: ${nearAmount(this.purchasePreview.breakdown.total_yocto)}</strong></p><p class="muted">Your wallet signs the purchase. The contract checks ownership and price again.</p><button data-chain-buy-plot="${html(plot.plot.id)}" ${busy}>Buy this plot</button></div>` : ""}`
                : ""
            }
          </article>`;
                })
                .join("")}</div>`
            : `<p>${this.message ? "Street state is unavailable. Check the contract ID and retry." : "Loading street state…"}</p>`
        }
      </section>
      ${
        tower && this.street
          ? `<section class="card"><h2>${html(tower.name)}</h2>
          <p>${this.towerAvailable ?? "?"}/${tower.capacity} spaces available · half-rate legal parking</p>
          ${this.towerFloors ? `<label>Choose floor <select id="chain-tower-floor">${Array.from({ length: TOWER_FLOORS }, (_, floor) => `<option value="${floor}" ${floor === this.selectedTowerFloor ? "selected" : ""}>Floor ${floor + 1} · ${this.towerFloors?.[floor] ?? "?"}/${TOWER_SPACES_PER_FLOOR} free</option>`).join("")}</select></label>` : ""}
          <p class="muted">Floor ${this.selectedTowerFloor + 1} spaces · expires at the time shown, then becomes available</p>
          ${
            this.towerSpaceError
              ? `<p role="status">Space list unavailable: ${html(this.towerSpaceError)}</p>`
              : this.towerSpaces
                ? `<div class="tower-space-list" role="list" aria-label="Floor ${this.selectedTowerFloor + 1} spaces">${this.towerSpaces
                    .map((entry, offset) => {
                      const space =
                        this.selectedTowerFloor * TOWER_SPACES_PER_FLOOR +
                        offset;
                      const occupied = entry && now < entry.expires_at;
                      const expiry = occupied
                        ? new Date(entry.expires_at * 1000)
                        : null;
                      return `<div class="tower-space ${occupied ? "occupied" : ""}" role="listitem"><strong>Space ${space + 1}</strong><span>${occupied ? (entry.driver === accountId ? "Your car" : "Occupied") : "Free"}</span>${expiry ? `<small>Until <time datetime="${expiry.toISOString()}">${html(expiry.toLocaleString())}</time></small>` : ""}</div>`;
                    })
                    .join("")}</div>`
                : `<p>Loading floor spaces…</p>`
          }
          ${registered && !session && car ? `<button id="chain-park-tower" ${!keyReady || this.busy || !(this.towerFloors ? this.towerFloors[this.selectedTowerFloor] : this.towerAvailable) ? "disabled" : ""}>${this.towerFloors?.[this.selectedTowerFloor] === 0 ? "Floor full" : this.towerFloors ? `Park car #${car.id} on floor ${this.selectedTowerFloor + 1}` : `Park car #${car.id} in tower`}</button>` : ""}
          </section>`
          : ""
      }
    </div>`;
    this.attachEvents();
    this.updateCountdown();
    if (this.focusOwnedOnRender) {
      const target =
        this.host.querySelector("#chain-owned-plots") ??
        this.host.querySelector(".chain-account");
      if (target) {
        this.focusOwnedOnRender = false;
        requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
      }
    }
  }

  private attachEvents(): void {
    const on = (selector: string, handler: (event: Event) => void) =>
      this.host.querySelector(selector)?.addEventListener("click", handler);
    on("#chain-refresh", () => {
      this.ownerFetchedAt = 0;
      void this.refresh();
    });
    on("#chain-retry-owner", () => {
      this.ownerFetchedAt = 0;
      void this.refresh();
    });
    on("#chain-connect", () => this.wallet?.connect());
    on(
      "#chain-signout",
      () =>
        void this.mutate(async () => {
          await this.wallet?.signOut();
          return "Wallet disconnected.";
        }),
    );
    on("#chain-register", () => {
      const body =
        this.host.querySelector<HTMLSelectElement>("#starter-body")!.value;
      const color =
        this.host.querySelector<HTMLSelectElement>("#starter-color")!.value;
      void this.mutate(async () => this.wallet?.register(body, color));
    });
    on(
      "#chain-enable-key",
      () =>
        void this.mutate(async () => {
          const state = await this.wallet?.addGameplayKey();
          return state === "ready"
            ? "Gameplay key confirmed."
            : "Gameplay key is awaiting chain confirmation.";
        }),
    );
    on(
      "#chain-revoke-key",
      () =>
        void this.mutate(async () => {
          const state = await this.wallet?.revokeGameplayKey();
          return state === "revoked"
            ? "Gameplay key revoked on-chain."
            : "Key revocation is awaiting chain confirmation.";
        }),
    );
    on(
      "#chain-check-key",
      () =>
        void this.mutate(async () => {
          const state = await this.wallet?.retryPendingKey();
          return state === "ready"
            ? "Gameplay key confirmed."
            : state === "none"
              ? "Key revocation confirmed."
              : "Gameplay key action is awaiting chain confirmation.";
        }),
    );
    on(
      "#chain-check-action",
      () =>
        void this.mutate(async () => {
          const state = await this.wallet?.checkPendingGameplayAction();
          return state === "success"
            ? "The previous gameplay action confirmed. The game state has refreshed."
            : state === "failure"
              ? this.wallet?.failedGameplayReason
                ? `${this.wallet.failedGameplayReason}. Review the game state before trying again.`
                : "The previous gameplay action failed on-chain. Review the game state before trying again."
              : state === "expired"
                ? "The previous gameplay action expired without landing. Review the game state, then retry."
                : state === "pending"
                  ? "The previous action is still pending. Check it again shortly."
                  : "There is no pending gameplay action.";
        }),
    );
    this.host
      .querySelector<HTMLSelectElement>("#chain-car")
      ?.addEventListener("change", (event) => {
        this.selectedCarId = Number((event.target as HTMLSelectElement).value);
        this.wallet?.selectCar(this.selectedCarId);
        this.render();
      });
    this.host
      .querySelector<HTMLSelectElement>("#chain-owned-plot")
      ?.addEventListener("change", (event) => {
        this.selectedOwnedPlotId = (event.target as HTMLSelectElement).value;
        const plot = this.plots.find(
          (entry) => entry.plot.id === this.selectedOwnedPlotId,
        );
        this.ownerDraft = plot ? draftForPlot(plot) : null;
        this.mockJob = null;
        this.paidJob = null;
        this.pendingUpload = null;
        this.mediaProposal = null;
        this.mediaLinkDraft = "";
        this.mockHistory = null;
        this.mockDescription = "";
        this.mockThemeHint = "None";
        this.mockMaterials = [];
        this.selectedMockCandidate = 0;
        this.plotStatsRequest++;
        this.plotStats = null;
        this.plotStatsError = "";
        this.plotStatsLoading = false;
        this.render();
      });
    on("#owner-load-stats", () => {
      if (this.selectedOwnedPlotId)
        void this.loadPlotStats(this.selectedOwnedPlotId);
    });
    this.host
      .querySelector<HTMLSelectElement>("#owner-rule-kind")
      ?.addEventListener("change", (event) => {
        if (!this.ownerDraft) return;
        this.ownerDraft.ruleKind = (event.target as HTMLSelectElement)
          .value as OwnerDraft["ruleKind"];
        this.render();
      });
    this.host
      .querySelector<HTMLInputElement>("#owner-meter-rate")
      ?.addEventListener("input", (event) => {
        if (this.ownerDraft)
          this.ownerDraft.meterRate = (event.target as HTMLInputElement).value;
      });
    this.host
      .querySelector<HTMLSelectElement>("#owner-rule-color")
      ?.addEventListener("change", (event) => {
        if (this.ownerDraft)
          this.ownerDraft.color = CarColor.parse(
            (event.target as HTMLSelectElement).value,
          );
      });
    for (const [selector, field] of [
      ["#owner-building-type", "buildingType"],
      ["#owner-building-variant", "variant"],
      ["#owner-building-palette", "palette"],
    ] as const) {
      this.host
        .querySelector<HTMLSelectElement>(selector)
        ?.addEventListener("change", (event) => {
          if (!this.ownerDraft) return;
          const value = (event.target as HTMLSelectElement).value;
          if (field === "buildingType")
            this.ownerDraft.buildingType = BuildingType.parse(value);
          else if (field === "variant")
            this.ownerDraft.variant = Number(value) as 1 | 2;
          else this.ownerDraft.palette = value;
          this.render();
        });
    }
    this.host
      .querySelector<HTMLInputElement>("#owner-building-name")
      ?.addEventListener("input", (event) => {
        if (this.ownerDraft)
          this.ownerDraft.name = (event.target as HTMLInputElement).value;
      });
    this.host
      .querySelector<HTMLTextAreaElement>("#owner-mock-description")
      ?.addEventListener("input", (event) => {
        this.mockDescription = (event.target as HTMLTextAreaElement).value;
        const button = this.host.querySelector<HTMLButtonElement>(
          "#owner-generate-mock",
        );
        if (button) button.disabled = !this.mockDescription.trim();
        const paidButton = this.host.querySelector<HTMLButtonElement>(
          "#owner-generate-paid",
        );
        if (paidButton) paidButton.disabled = !this.mockDescription.trim();
      });
    this.host
      .querySelector<HTMLSelectElement>("#owner-mock-theme")
      ?.addEventListener("change", (event) => {
        this.mockThemeHint = ThemeHint.parse(
          (event.target as HTMLSelectElement).value,
        );
      });
    const materialInputs = Array.from(
      this.host.querySelectorAll<HTMLInputElement>("[data-owner-material]"),
    );
    for (const input of materialInputs) {
      input.addEventListener("change", () => {
        this.mockMaterials = materialInputs
          .filter((item) => item.checked)
          .map((item) => MaterialHint.parse(item.dataset.ownerMaterial));
        for (const item of materialInputs)
          item.disabled = this.mockMaterials.length >= 2 && !item.checked;
      });
    }
    this.host
      .querySelector<HTMLInputElement>("#owner-use-prior-art")
      ?.addEventListener("change", (event) => {
        this.usePriorArt = (event.target as HTMLInputElement).checked;
      });
    on("#owner-generate-mock", () => {
      const plotId = this.selectedOwnedPlotId;
      const description = this.mockDescription;
      const palette = this.ownerDraft?.palette;
      const themeHint = this.mockThemeHint;
      const materialHints = [...this.mockMaterials];
      void this.mutate(async () => {
        if (!this.wallet || !plotId || !palette)
          throw new Error("Select an owned plot first");
        this.mockJob = await this.wallet.createMockGeneration(
          plotId,
          description,
          palette,
          themeHint,
          materialHints,
        );
        this.paidJob = null;
        this.selectedMockCandidate = 0;
        this.mockHistory = null;
        return "Three private curated designs are ready.";
      });
    });
    const loadPaid = async (paid: PaidGenerationJob): Promise<void> => {
      this.paidJob = paid;
      if (paid.designJobId) {
        if (!this.wallet) throw new Error("Connect a testnet wallet first");
        this.mockJob = await this.wallet.generationById(paid.designJobId);
        this.selectedMockCandidate = selectedCandidateIndex(this.mockJob);
      }
    };
    on("#owner-generate-paid", () => {
      const plotId = this.selectedOwnedPlotId;
      const description = this.mockDescription;
      const palette = this.ownerDraft?.palette;
      const themeHint = this.mockThemeHint;
      const materialHints = [...this.mockMaterials];
      const usePriorArt = this.usePriorArt;
      const fresh = Boolean(
        this.paidJob &&
          [
            "complete",
            "partial",
            "review_rejected",
            "failed",
            "cancelled",
            "superseded",
            "expired",
          ].includes(this.paidJob.status),
      );
      void this.mutate(async () => {
        if (!this.wallet || !plotId || !palette)
          throw new Error("Select an owned plot first");
        await loadPaid(
          await this.wallet.createPaidGeneration(
            plotId,
            description,
            palette,
            themeHint,
            materialHints,
            usePriorArt,
            fresh,
          ),
        );
        this.mockHistory = null;
        return this.paidJob?.designJobId
          ? "Prompt designs are ready to compare."
          : "Prompt job queued. Refresh it to see the designs.";
      });
    });
    on("#owner-restore-paid", () => {
      const plotId = this.selectedOwnedPlotId;
      void this.mutate(async () => {
        if (!this.wallet || !plotId)
          throw new Error("Select an owned plot first");
        const paid = await this.wallet.latestPaidGeneration(plotId);
        if (!paid) return "No prompt job for this plot yet.";
        await loadPaid(paid);
        if (this.mockJob) {
          this.mockDescription = this.mockJob.description;
          this.mockThemeHint = this.mockJob.promptSpec?.themeHint ?? "None";
          this.mockMaterials = this.mockJob.promptSpec?.materialHints ?? [];
        }
        return paid.designJobId
          ? "Prompt designs restored."
          : `Prompt job is ${paid.status}.`;
      });
    });
    on("#owner-refresh-paid", () => {
      const paidId = this.paidJob?.id;
      void this.mutate(async () => {
        if (!this.wallet || !paidId)
          throw new Error("Restore the prompt job first");
        const paid = await this.wallet.paidGeneration(paidId);
        await loadPaid(paid);
        return paid.designJobId
          ? "Prompt designs are ready to compare."
          : `Prompt job is ${paid.status}.`;
      });
    });
    on("#owner-restore-mock", () => {
      const plotId = this.selectedOwnedPlotId;
      void this.mutate(async () => {
        if (!this.wallet || !plotId)
          throw new Error("Select an owned plot first");
        this.mockJob = await this.wallet.latestMockGeneration(plotId);
        this.mockDescription = this.mockJob?.description ?? "";
        this.mockThemeHint = this.mockJob?.promptSpec?.themeHint ?? "None";
        this.mockMaterials = this.mockJob?.promptSpec?.materialHints ?? [];
        this.selectedMockCandidate = this.mockJob
          ? selectedCandidateIndex(this.mockJob)
          : 0;
        return this.mockJob
          ? "Last private design job restored."
          : "No earlier design job for this plot.";
      });
    });
    on("#owner-history-mock", () => {
      const plotId = this.selectedOwnedPlotId;
      void this.mutate(async () => {
        if (!this.wallet || !plotId)
          throw new Error("Select an owned plot first");
        this.mockHistory = await this.wallet.mockGenerationHistory(plotId);
        return `${this.mockHistory.length} recent design job${this.mockHistory.length === 1 ? "" : "s"}.`;
      });
    });
    on("#owner-submit-mock", () => {
      const job = this.mockJob;
      const candidate = job?.candidates[this.selectedMockCandidate];
      void this.mutate(async () => {
        if (!this.wallet || !job || !candidate)
          throw new Error("Choose a design first");
        this.mockJob = await this.wallet.submitMockGeneration(
          job,
          candidate.id,
        );
        this.mockHistory = null;
        this.selectedMockCandidate = selectedCandidateIndex(this.mockJob);
        this.ownerFetchedAt = 0;
        return this.mockJob.status === "submitted"
          ? "Design proposal confirmed on testnet and awaiting review."
          : "Wallet action sent. Use Submit or check proposal to confirm its status.";
      });
    });
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-owner-candidate]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          const candidate =
            this.mockJob?.candidates[Number(button.dataset.ownerCandidate)];
          if (!candidate || !this.ownerDraft) return;
          this.selectedMockCandidate = Number(button.dataset.ownerCandidate);
          this.ownerDraft.buildingType = BuildingType.parse(
            this.mockJob?.buildingType,
          );
          this.ownerDraft.variant = candidate.variant;
          this.ownerDraft.palette = candidate.palette;
          this.render();
        }),
      );
    on(
      "#owner-save-rule",
      () =>
        void this.mutate(async () => {
          const draft = this.ownerDraft;
          const config = this.ownerConfig;
          if (!draft || !config) throw new Error("Select a plot first");
          const rule = ParkingRule.parse(
            draft.ruleKind === "Meter"
              ? { kind: "Meter", ratePerHour: coinInput(draft.meterRate) }
              : draft.ruleKind === "ColorOnly"
                ? { kind: "ColorOnly", color: draft.color }
                : { kind: draft.ruleKind },
          );
          if (
            rule.kind === "Meter" &&
            BigInt(rule.ratePerHour) > BigInt(config.meter_rate_max_per_hour)
          )
            throw new Error("Meter rate is above the current maximum");
          await this.wallet?.gameplayCall("set_rule", {
            plot_id: draft.plotId,
            rule,
          });
          this.ownerDraft = null;
          this.ownerFetchedAt = 0;
          return "Rule change scheduled on testnet.";
        }),
    );
    on(
      "#owner-save-preset",
      () =>
        void this.mutate(async () => {
          const draft = this.ownerDraft;
          if (!draft) throw new Error("Select a plot first");
          await this.wallet?.choosePreset(
            draft.plotId,
            draft.variant,
            draft.palette,
            draft.name,
          );
          this.ownerDraft = null;
          this.ownerFetchedAt = 0;
          return "Curated building preset confirmed on testnet.";
        }),
    );
    on(
      "#owner-change-type",
      () =>
        void this.mutate(async () => {
          const draft = this.ownerDraft;
          if (!draft) throw new Error("Select a plot first");
          await this.wallet?.changeBuildingType(
            draft.plotId,
            draft.buildingType,
            draft.variant,
          );
          this.ownerDraft = null;
          this.ownerFetchedAt = 0;
          return "Building type confirmed on testnet.";
        }),
    );
    on(
      "#owner-upgrade-building",
      () =>
        void this.mutate(async () => {
          const plotId = this.selectedOwnedPlotId;
          if (!plotId) throw new Error("Select a plot first");
          await this.wallet?.upgradeBuilding(plotId);
          this.ownerDraft = null;
          this.ownerFetchedAt = 0;
          return "Building level confirmed on testnet.";
        }),
    );
    for (const [kind, inputId, buttonId] of [
      ["Logo", "#owner-logo-file", "#owner-upload-logo"],
      ["Billboard", "#owner-ad-file", "#owner-upload-ad"],
    ] as const) {
      on(buttonId, () => {
        const file =
          this.host.querySelector<HTMLInputElement>(inputId)?.files?.[0];
        const plotId = this.selectedOwnedPlotId;
        void this.mutate(async () => {
          if (!file || !plotId)
            throw new Error("Choose an image and owned plot first");
          if (!this.wallet) throw new Error("Connect a wallet first");
          const result = await this.wallet.uploadMedia(plotId, kind, file);
          this.pendingUpload = { ...result, plotId, kind };
          this.mediaProposal = null;
          this.mediaLinkDraft = "";
          return `${kind} uploaded privately. Prepare a proposal when ready.`;
        });
      });
    }
    for (const [kind, buttonId] of [
      ["Logo", "#owner-restore-logo"],
      ["Billboard", "#owner-restore-ad"],
    ] as const) {
      on(buttonId, () => {
        const plotId = this.selectedOwnedPlotId;
        void this.mutate(async () => {
          if (!this.wallet || !plotId)
            throw new Error("Select an owned plot first");
          const [proposal, latest] = await Promise.all([
            this.wallet.latestMediaProposal(plotId, kind),
            this.wallet.latestUpload(plotId, kind),
          ]);
          this.mediaProposal = proposal;
          const upload = proposal?.assetUrl
            ? {
                uploadId: proposal.uploadId,
                hash: proposal.assetHash,
                url: proposal.assetUrl,
                width: kind === "Logo" ? 256 : 512,
                height: 256,
                status: "pending" as const,
                layoutRevision: proposal.layoutRevision,
              }
            : latest;
          this.pendingUpload = upload ? { ...upload, plotId, kind } : null;
          this.mediaLinkDraft = proposal?.link ?? "";
          return proposal
            ? proposal.assetUrl
              ? `Last ${kind.toLowerCase()} proposal restored.`
              : latest
                ? `Last ${kind.toLowerCase()} decision restored. Its private image expired; your newer upload is ready.`
                : `Last ${kind.toLowerCase()} decision restored. Its private image expired; upload again.`
            : latest
              ? `Last ${kind.toLowerCase()} upload restored.`
              : `No ${kind.toLowerCase()} upload found.`;
        });
      });
    }
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-owner-reuse-media]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          const kind = button.dataset.ownerReuseMedia as "Logo" | "Billboard";
          const plotId = this.selectedOwnedPlotId;
          const selected = this.plots.find((entry) => entry.plot.id === plotId);
          void this.mutate(async () => {
            if (!this.wallet || !plotId || !selected)
              throw new Error("Select an owned plot first");
            const slot =
              kind === "Logo" ? selected.plot.logo : selected.plot.billboard;
            if (!slot.active) throw new Error("No approved image to reuse");
            const upload = await this.wallet.reuseApprovedMedia(plotId, kind);
            this.pendingUpload = { ...upload, plotId, kind };
            this.mediaProposal = null;
            this.mediaLinkDraft = slot.active.content.link ?? "";
            return `${kind} is ready for a new proposal and moderator review.`;
          });
        }),
      );
    this.host
      .querySelector<HTMLInputElement>("#owner-media-link")
      ?.addEventListener("input", (event) => {
        this.mediaLinkDraft = (event.target as HTMLInputElement).value;
      });
    on("#owner-create-media", () => {
      const upload = this.pendingUpload;
      const link = this.mediaLinkDraft.trim() || null;
      void this.mutate(async () => {
        if (!this.wallet || !upload) throw new Error("Upload an image first");
        this.mediaProposal = await this.wallet.createMediaProposal(
          upload,
          upload.plotId,
          upload.kind,
          link,
        );
        return `${upload.kind} proposal prepared. Submit it with your wallet.`;
      });
    });
    on("#owner-submit-media", () => {
      const proposal = this.mediaProposal;
      void this.mutate(async () => {
        if (!this.wallet || !proposal)
          throw new Error("Prepare a media proposal first");
        this.mediaProposal = await this.wallet.submitMediaProposal(proposal);
        this.ownerFetchedAt = 0;
        return this.mediaProposal.status === "submitted"
          ? `${proposal.kind} proposal confirmed on testnet and awaiting review.`
          : "Wallet action sent. Use Submit or check proposal to confirm it.";
      });
    });
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-owner-remove-media]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          const kind = button.dataset.ownerRemoveMedia as "Logo" | "Billboard";
          const plotId = this.selectedOwnedPlotId;
          void this.mutate(async () => {
            if (!this.wallet || !plotId)
              throw new Error("Select an owned plot first");
            await this.wallet.removeMedia(plotId, kind);
            this.mediaProposal = null;
            this.ownerFetchedAt = 0;
            return `${kind} removed from this building on testnet.`;
          });
        }),
      );
    on(
      "#chain-collect",
      () =>
        void this.mutate(async () => {
          const session = this.player?.active_session;
          if (!session) return;
          await this.wallet?.gameplayCall(
            Math.floor(Date.now() / 1000) >= session.expires_at
              ? "settle_expired"
              : "collect",
            { expected_session_id: session.id },
          );
        }),
    );
    on(
      "#chain-repair",
      () =>
        void this.mutate(async () => {
          const car = this.player?.cars.find(
            (entry) => entry.id === this.selectedCarId,
          );
          const config = this.ownerConfig;
          if (car && config)
            await this.wallet?.gameplayCall("repair", {
              car_id: car.id,
              points: config.max_durability - car.durability,
            });
        }),
    );
    on(
      "#chain-repair-to-park",
      () =>
        void this.mutate(async () => {
          const car = this.player?.cars.find(
            (entry) => entry.id === this.selectedCarId,
          );
          const config = this.ownerConfig;
          if (car && config)
            await this.wallet?.gameplayCall("repair", {
              car_id: car.id,
              points: config.park_durability_cost - car.durability,
            });
        }),
    );
    on(
      "#chain-emergency-repair",
      () =>
        void this.mutate(async () =>
          this.wallet?.gameplayCall("emergency_repair", {}),
        ),
    );
    on(
      "#chain-upgrade",
      () =>
        void this.mutate(async () => {
          if (this.selectedCarId !== null)
            await this.wallet?.upgradeCar(this.selectedCarId);
        }),
    );
    on("#chain-buy-car", () => {
      const body =
        this.host.querySelector<HTMLSelectElement>("#chain-buy-body")!.value;
      const color =
        this.host.querySelector<HTMLSelectElement>("#chain-buy-color")!.value;
      void this.mutate(async () => this.wallet?.buyCar(body, color));
    });
    this.host
      .querySelector<HTMLSelectElement>("#chain-tower-floor")
      ?.addEventListener("change", (event) => {
        this.selectedTowerFloor = Number(
          (event.target as HTMLSelectElement).value,
        );
        this.towerSpaces = null;
        this.render();
        void this.refresh(true);
      });
    on("#chain-park-tower", () => {
      const selectedFloor = this.selectedTowerFloor;
      const { roadId, side } = this.getRoadSide();
      const tower = this.sites.find(
        (site) =>
          site.roadId === roadId &&
          site.side === side &&
          site.role === "ParkingTower",
      );
      void this.mutate(async () => {
        if (!tower || this.selectedCarId === null) return;
        const space = this.towerFloors
          ? await this.reader.towerOpenSpaceOnFloor(tower.id, selectedFloor)
          : await this.reader.towerOpenSpace(tower.id);
        if (space === null) throw new Error("The parking tower is full");
        await this.wallet?.gameplayCall("park_tower", {
          car_id: this.selectedCarId,
          site_id: tower.id,
          space,
        });
      });
    });
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-chain-park]")
      .forEach((button) =>
        button.addEventListener(
          "click",
          () =>
            void this.mutate(async () => {
              if (this.selectedCarId === null) return;
              await this.wallet?.gameplayCall("park", {
                car_id: this.selectedCarId,
                plot_id: button.dataset.chainPark,
                slot: Number(button.dataset.slot),
              });
            }),
        ),
      );
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-chain-ticket]")
      .forEach((button) =>
        button.addEventListener(
          "click",
          () =>
            void this.mutate(async () => {
              await this.wallet?.gameplayCall("ticket", {
                plot_id: button.dataset.chainTicket,
                slot: Number(button.dataset.slot),
                expected_session_id: Number(button.dataset.session),
              });
            }),
        ),
      );
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-chain-quote-plot]")
      .forEach((button) =>
        button.addEventListener(
          "click",
          () => void this.previewPlotPurchase(button.dataset.chainQuotePlot!),
        ),
      );
    this.host
      .querySelectorAll<HTMLButtonElement>("[data-chain-buy-plot]")
      .forEach((button) =>
        button.addEventListener(
          "click",
          () =>
            void this.mutate(async () => {
              const preview = this.purchasePreview;
              if (!preview || preview.plotId !== button.dataset.chainBuyPlot)
                throw new Error("Review the current plot price first");
              await this.wallet?.buyPlot(
                preview.plotId,
                preview.breakdown.total_yocto,
              );
              this.purchasePreview = null;
              this.ownerFetchedAt = 0;
              return "Plot purchase confirmed on testnet.";
            }),
        ),
      );
  }
}
