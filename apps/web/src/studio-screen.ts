import {
  BuildingType,
  DEFAULT_CONFIG,
  formatCoins,
  type PlayerPlot,
} from "@estate/shared";
import {
  facadeAssetUrl,
  facadePreset,
  paletteName,
  PRESET_PALETTES,
} from "./preset-catalog.js";
import { illustratedPreviewForType } from "./illustrated-preview.js";

type StudioStep = "Describe" | "Choose" | "Preview";
type StudioState = "Empty" | "Pending" | "Ready" | "Error";
type Candidate = { variant: 1 | 2; palette: string };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character]!;
  });
}

export function presetCandidates(variant: 1 | 2, palette: string): Candidate[] {
  const paletteIndex = PRESET_PALETTES.findIndex((entry) => entry === palette);
  if (paletteIndex < 0) throw new Error("Unknown preset colour");
  return [
    { variant, palette },
    { variant: variant === 1 ? 2 : 1, palette },
    {
      variant,
      palette: PRESET_PALETTES[(paletteIndex + 1) % PRESET_PALETTES.length]!,
    },
  ];
}

export function buildingMarkup(
  type: string,
  variant: number,
  level: number,
  palette: string,
): string {
  const preset = facadePreset(type, variant, level);
  const maskUrl = facadeAssetUrl(preset.paletteMask, preset.paletteMaskHash);
  const logo = preset.logoRect;
  const name = preset.nameRect;
  return `<div class="studio-building" role="img" aria-label="${type} variant ${variant}, level ${level}">
    <img src="${facadeAssetUrl(preset.sprite, preset.spriteHash)}" alt="" width="140" height="160" />
    <span class="studio-building-mask" style="background:${palette};-webkit-mask-image:url('${maskUrl}');mask-image:url('${maskUrl}')" aria-hidden="true"></span>
    ${logo ? `<span class="studio-logo" style="left:${logo.x}px;top:${logo.y}px;width:${logo.width}px;height:${logo.height}px">${type.slice(0, 2).toUpperCase()}</span>` : ""}
    <span class="studio-name" style="left:${name.x}px;top:${name.y}px;width:${name.width}px;height:${name.height}px;font-size:${Math.min(8, name.height * 0.7, name.width / (type.length * 0.62))}px">${type.toUpperCase()}</span>
  </div>`;
}

function illustratedStudyMarkup(type: string): string {
  const variants = type === "Cafe" ? [1, 2] : [undefined];
  const studies = variants.map((variant) => {
    const study = illustratedPreviewForType(type, variant);
    if (!study) return "";
    const logo = study.logoRect;
    const name = study.nameRect;
    const label =
      variant === 1
        ? "Glasshouse"
        : variant === 2
          ? "Pergola"
          : "Illustrated style study";
    const imageLabel =
      variant === undefined
        ? `${type} illustrated level 2 style study`
        : `${type} ${label} illustrated level 2 style study`;
    return `<figure class="studio-art-direction">
    <div class="studio-art-frame">
      <div class="studio-building" role="img" aria-label="${imageLabel}">
        <img src="${study.spriteUrl}" alt="" width="140" height="160" />
        ${logo ? `<span class="studio-logo" style="left:${logo.x}px;top:${logo.y}px;width:${logo.width}px;height:${logo.height}px">${type.slice(0, 2).toUpperCase()}</span>` : ""}
        ${name ? `<span class="studio-name" style="left:${name.x}px;top:${name.y}px;width:${name.width}px;height:${name.height}px;font-size:${Math.min(8, name.height * 0.7, name.width / (type.length * 0.62))}px">${type.toUpperCase()}</span>` : ""}
      </div>
    </div>
    <figcaption><strong>${label}</strong><span>Level 2 study · preview only</span></figcaption>
  </figure>`;
  });
  return `<div class="studio-art-studies ${variants.length === 1 ? "single" : "pair"}">${studies.join("")}</div>`;
}

function preload(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}

export class MockStudio {
  private root: HTMLElement | null = null;
  private step: StudioStep = "Describe";
  private state: StudioState = "Empty";
  private error = "";
  private requestId = 0;
  private candidates: Candidate[] = [];
  private selected = 0;
  private type: string;
  private variant: 1 | 2;
  private level = 1;
  private palette = "#F6C85F";
  private description = "";

  constructor(
    private readonly plot: PlayerPlot,
    private readonly neighbours: [PlayerPlot, PlayerPlot],
    private readonly onBack: () => void,
    private readonly isCurrent: () => boolean,
  ) {
    this.type = plot.initialType;
    this.variant = plot.initialVariant as 1 | 2;
  }

  mount(root: HTMLElement): void {
    this.root = root;
    this.render();
  }

  unmount(): void {
    this.root = null;
    this.requestId++;
  }

  private selectedLook(): Candidate {
    return (
      this.candidates[this.selected] ?? {
        variant: this.variant,
        palette: this.palette,
      }
    );
  }

  private canOpenStep(step: StudioStep): boolean {
    if (step === "Describe") return true;
    if (step === "Choose") return this.state !== "Empty";
    return this.state === "Ready";
  }

  private candidateMarkup(candidate: Candidate, index: number): string {
    return `<button class="studio-candidate ${index === this.selected ? "selected" : ""}" data-candidate="${index}" aria-pressed="${index === this.selected}">
      ${buildingMarkup(this.type, candidate.variant, this.level, candidate.palette)}
      <span>Design ${index + 1} · Shape ${candidate.variant}</span>
    </button>`;
  }

  private statusMarkup(): string {
    if (this.state === "Empty")
      return `<div class="studio-state" role="status"><strong>No designs loaded yet</strong><p>Choose a building type, level and colour, then explore three curated looks.</p></div>`;
    if (this.state === "Pending")
      return `<div class="studio-state" role="status" aria-live="polite"><strong>Loading preset designs…</strong><p>Checking the building images and colour masks.</p></div>`;
    if (this.state === "Error")
      return `<div class="studio-state error" role="alert"><strong>Could not load designs</strong><p>${escapeHtml(this.error)}</p><button id="retry-presets">Try again</button></div>`;
    return `<div class="candidate-grid">${this.candidates.map((candidate, index) => this.candidateMarkup(candidate, index)).join("")}</div>
      <div class="mobile-candidate">${buildingMarkup(this.type, this.selectedLook().variant, this.level, this.selectedLook().palette)}<p>Design ${this.selected + 1} of ${this.candidates.length}</p>
      <div class="candidate-thumbnails">${this.candidates.map((candidate, index) => `<button data-candidate="${index}" aria-label="Choose design ${index + 1}" aria-pressed="${index === this.selected}">${buildingMarkup(this.type, candidate.variant, this.level, candidate.palette)}</button>`).join("")}</div></div>
      <div class="studio-choice-actions"><button type="button" id="studio-previous-design" aria-label="Previous design">←</button><button type="button" class="primary" id="studio-open-preview">Street preview →</button><button type="button" id="studio-next-design" aria-label="Next design">→</button></div>`;
  }

  private render(): void {
    if (!this.root || !this.isCurrent()) return;
    const chosen = this.selectedLook();
    const left = this.neighbours[0];
    const right = this.neighbours[1];
    this.root.innerHTML = `<div class="studio-screen" data-step="${this.step}">
      <div class="studio-heading"><button id="studio-back" aria-label="Back to My Plots">←</button><div><h1>Build your place</h1><p>Plot ${this.plot.index + 1} · Main Street · Guest preview</p></div><span class="tag">Level ${this.level} preview</span></div>
      <nav class="studio-steps" aria-label="Building studio steps">${(["Describe", "Choose", "Preview"] as const).map((step) => `<button data-studio-step="${step}" aria-current="${step === this.step ? "step" : "false"}" ${this.canOpenStep(step) ? "" : "disabled"}>${step}</button>`).join("")}</nav>
      <div class="studio-layout">
        <section class="card studio-controls" aria-label="Describe your building">
          <h2>Your building</h2>
          <label>Type<select id="studio-type">${BuildingType.options.map((type) => `<option value="${type}" ${type === this.type ? "selected" : ""}>${type}</option>`).join("")}</select></label>
          ${illustratedStudyMarkup(this.type)}
          <label>Level to preview<select id="studio-level">${[1, 2, 3, 4].map((level) => `<option value="${level}" ${level === this.level ? "selected" : ""}>Level ${level} · ${[70, 100, 130, 160][level - 1]}px limit</option>`).join("")}</select></label>
          <fieldset class="studio-palette"><legend>Colour</legend>${PRESET_PALETTES.map((palette) => `<button type="button" data-studio-palette="${palette}" aria-label="${paletteName(palette)} colour" aria-pressed="${palette === this.palette}" style="background:${palette}"></button>`).join("")}</fieldset>
          <label>Your idea<textarea id="studio-description" maxlength="800" rows="4" placeholder="A greenhouse cafe with a tall glass peak and hanging plants…">${escapeHtml(this.description)}</textarea></label>
          <p class="muted">Your idea previews the future generation flow. The three selectable looks are curated designs for now.</p>
          <button class="primary" id="explore-presets">Explore 3 preset looks</button>
        </section>
        <div class="studio-workspace">
          <section class="studio-choice" aria-label="Choose a design"><h2>Choose a shape</h2>${this.statusMarkup()}</section>
          <section class="studio-preview" aria-label="Preview beside neighbours"><h2>On your street</h2>
            <div class="studio-neighbourhood">
              <div class="studio-neighbour">${buildingMarkup(left.initialType, left.initialVariant, (left.index % 4) + 1, PRESET_PALETTES[left.index % 4]!)}</div>
              <div class="studio-focus"><span class="studio-height-line" style="--height-line-top:${160 - [70, 100, 130, 160][this.level - 1]!}px"><span>Level ${this.level} limit</span></span>${buildingMarkup(this.type, chosen.variant, this.level, chosen.palette)}</div>
              <div class="studio-neighbour">${buildingMarkup(right.initialType, right.initialVariant, (right.index % 4) + 1, PRESET_PALETTES[right.index % 4]!)}</div>
              <div class="studio-curb"><span>Parking</span><span>Parking</span></div>
            </div>
            <p class="muted">${this.level > 1 ? `Level ${this.level} is a visual preview. Paid upgrades cost ${formatCoins(DEFAULT_CONFIG.buildingUpgradeCosts[this.level - 2]!)} coins for this step.` : "Your current building is level 1. Previewing leaves it unchanged."}</p>
            <button class="primary" disabled>Submit for review</button><p class="muted">To publish a design, buy a plot on testnet and submit your choice for review.</p>
          </section>
        </div>
      </div>
      <div class="studio-mobile-action"><button class="primary" id="explore-presets-mobile">See 3 level ${this.level} designs →</button></div>
    </div>`;
    this.bind();
  }

  private bind(): void {
    const root = this.root!;
    root
      .querySelector<HTMLButtonElement>("#studio-back")!
      .addEventListener("click", this.onBack);
    root
      .querySelectorAll<HTMLButtonElement>("[data-studio-step]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          this.step = button.dataset.studioStep as StudioStep;
          this.render();
        }),
      );
    root
      .querySelector<HTMLSelectElement>("#studio-type")!
      .addEventListener("change", (event) => {
        this.type = (event.target as HTMLSelectElement).value;
        this.resetOptions();
      });
    root
      .querySelector<HTMLSelectElement>("#studio-level")!
      .addEventListener("change", (event) => {
        this.level = Number((event.target as HTMLSelectElement).value);
        this.resetOptions();
      });
    root
      .querySelectorAll<HTMLButtonElement>("[data-studio-palette]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          this.palette = button.dataset.studioPalette!;
          this.resetOptions();
        }),
      );
    root
      .querySelector<HTMLTextAreaElement>("#studio-description")!
      .addEventListener("input", (event) => {
        this.description = (event.target as HTMLTextAreaElement).value;
      });
    root
      .querySelector<HTMLButtonElement>("#explore-presets")!
      .addEventListener("click", () => {
        void this.explore();
      });
    root
      .querySelector<HTMLButtonElement>("#explore-presets-mobile")!
      .addEventListener("click", () => {
        void this.explore();
      });
    root
      .querySelector<HTMLButtonElement>("#retry-presets")
      ?.addEventListener("click", () => {
        void this.explore();
      });
    root
      .querySelectorAll<HTMLButtonElement>("[data-candidate]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          this.selected = Number(button.dataset.candidate);
          this.variant = this.selectedLook().variant;
          const group = button.closest(".candidate-thumbnails")
            ? ".candidate-thumbnails"
            : ".candidate-grid";
          this.render();
          this.root
            ?.querySelector<HTMLButtonElement>(
              `${group} [data-candidate="${this.selected}"]`,
            )
            ?.focus();
        }),
      );
    root
      .querySelector<HTMLButtonElement>("#studio-previous-design")
      ?.addEventListener("click", () => this.moveCandidate(-1));
    root
      .querySelector<HTMLButtonElement>("#studio-next-design")
      ?.addEventListener("click", () => this.moveCandidate(1));
    root
      .querySelector<HTMLButtonElement>("#studio-open-preview")
      ?.addEventListener("click", () => {
        this.step = "Preview";
        this.render();
      });
  }

  private moveCandidate(direction: -1 | 1): void {
    if (!this.candidates.length) return;
    this.selected =
      (this.selected + direction + this.candidates.length) %
      this.candidates.length;
    this.variant = this.selectedLook().variant;
    this.render();
    this.root
      ?.querySelector<HTMLButtonElement>(
        direction === 1 ? "#studio-next-design" : "#studio-previous-design",
      )
      ?.focus();
  }

  private resetOptions(): void {
    this.requestId++;
    this.state = "Empty";
    this.candidates = [];
    this.selected = 0;
    this.step = "Describe";
    this.render();
  }

  private async explore(): Promise<void> {
    const requestId = ++this.requestId;
    this.candidates = presetCandidates(this.variant, this.palette);
    this.selected = 0;
    this.state = "Pending";
    this.step = "Choose";
    this.render();
    try {
      await Promise.all(
        this.candidates.flatMap((candidate) => {
          const preset = facadePreset(this.type, candidate.variant, this.level);
          return [
            preload(facadeAssetUrl(preset.sprite, preset.spriteHash)),
            preload(facadeAssetUrl(preset.paletteMask, preset.paletteMaskHash)),
          ];
        }),
      );
      if (requestId !== this.requestId) return;
      this.state = "Ready";
    } catch (error) {
      if (requestId !== this.requestId) return;
      this.state = "Error";
      this.error = error instanceof Error ? error.message : "Please retry.";
    }
    this.render();
  }
}
