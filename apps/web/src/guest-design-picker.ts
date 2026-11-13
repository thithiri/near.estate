import type { PlayerPlot } from "@estate/shared";
import { choices } from "./frontage-art.js";
import { LEVEL_HEIGHTS, type BuildingLevel } from "./frontage-layout.js";
import {
  paintGuestChoice,
  preloadGuestBuilding,
} from "./guest-illustration.js";
import {
  streetDesignPreviewMarkup,
  type StreetPreviewBuilding,
} from "./street-design-preview.js";

export function mountGuestDesignPicker(
  root: HTMLElement,
  plot: PlayerPlot,
  currentId: string,
  currentLevel: BuildingLevel,
  currentLogo: ImageBitmap | null,
  onLogo: (logo: ImageBitmap | null) => void,
  currentAd: ImageBitmap | null,
  onAd: (ad: ImageBitmap | null) => void,
  neighbours: StreetPreviewBuilding[],
  roadName: string,
  onChoose: (id: string, level: BuildingLevel) => void,
  onBack: () => void,
): void {
  const units = plot.frontageUnits ?? 2;
  const eligible = choices.filter((choice) => choice.units === units);
  const wrapper = document.createElement("div");
  wrapper.className = "guest-design-screen";
  const heading = document.createElement("div");
  heading.className = "guest-design-heading";
  const back = document.createElement("button");
  back.textContent = "← Street";
  back.addEventListener("click", onBack);
  const title = document.createElement("div");
  const h1 = document.createElement("h1");
  h1.textContent = `Choose a ${units}-unit building`;
  const description = document.createElement("p");
  description.textContent = `Plot ${plot.index + 1} · ${units} curb ${units === 1 ? "space" : "spaces"} · guest design preview`;
  title.append(h1, description);
  heading.append(back, title);
  const intro = document.createElement("p");
  intro.className = "muted";
  intro.textContent =
    "Select a height and shape, compare it with the neighbouring plots, then show it on the playable street. This is a local visual preview.";
  let level = currentLevel;
  let selectedId = currentId;
  const levels = document.createElement("fieldset");
  levels.className = "guest-design-levels";
  const legend = document.createElement("legend");
  legend.textContent = "Upgrade level and height limit";
  levels.append(legend);
  for (const candidate of [1, 2, 3, 4] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.level = String(candidate);
    button.textContent = `Level ${candidate} · ${LEVEL_HEIGHTS[candidate]}px`;
    button.setAttribute("aria-pressed", String(candidate === level));
    button.addEventListener("click", () => {
      level = candidate;
      levels
        .querySelectorAll<HTMLButtonElement>("button[data-level]")
        .forEach((entry) =>
          entry.setAttribute("aria-pressed", String(entry === button)),
        );
      redraw();
      requestIllustrations();
    });
    levels.append(button);
  }
  const billboardNote = document.createElement("p");
  billboardNote.textContent =
    "Marked designs have a separate blank billboard panel at levels 3–4. The logo stays on the storefront sign.";
  levels.append(billboardNote);
  let previewLogo = currentLogo;
  let previewAd = currentAd;
  const logoTools = document.createElement("div");
  logoTools.className = "guest-design-logo-tools";
  const fileLabel = document.createElement("label");
  fileLabel.textContent = "Preview your logo ";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/webp";
  fileInput.setAttribute(
    "aria-label",
    "Preview your logo on the building choices",
  );
  fileLabel.append(fileInput);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear logo";
  const logoStatus = document.createElement("small");
  logoStatus.setAttribute("role", "status");
  logoStatus.textContent = "Local preview only · image stays on this device";
  const grid = document.createElement("div");
  grid.className = "guest-design-grid";
  const contextPreview = document.createElement("div");
  const showOnStreet = document.createElement("button");
  showOnStreet.type = "button";
  showOnStreet.className = "primary guest-design-apply";
  showOnStreet.addEventListener("click", () => onChoose(selectedId, level));
  const redrawContext = () => {
    const selected = eligible.find((choice) => choice.id === selectedId)!;
    contextPreview.innerHTML = streetDesignPreviewMarkup(roadName, plot.side, [
      ...neighbours,
      { plotIndex: plot.index, choice: selected, level, selected: true },
    ]);
    showOnStreet.textContent = `Show ${selected.name} on my street`;
  };
  const redraw = () => {
    grid
      .querySelectorAll<HTMLButtonElement>(".guest-design-card")
      .forEach((button) => {
        const choice = eligible.find(
          (entry) => entry.id === button.dataset.choice,
        );
        const context = button.querySelector("canvas")?.getContext("2d");
        if (choice && context) {
          context.clearRect(0, 0, units * 85, 190);
          paintGuestChoice(
            context,
            choice,
            level,
            previewLogo,
            true,
            previewAd,
          );
        }
      });
    redrawContext();
  };
  const requestIllustrations = () => {
    const requestedLevel = level;
    void Promise.all(
      eligible.map((choice) => preloadGuestBuilding(choice, requestedLevel)),
    ).then(() => {
      if (level === requestedLevel) redraw();
    });
  };
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 1_000_000
    ) {
      logoStatus.textContent = "Choose PNG, JPEG or WebP under 1 MB.";
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      onLogo(bitmap);
      previewLogo = bitmap;
      redraw();
      logoStatus.textContent = `Previewing ${file.name} locally · no image uploaded`;
    } catch {
      logoStatus.textContent = "This image could not be opened.";
    }
  });
  clear.addEventListener("click", () => {
    onLogo(null);
    previewLogo = null;
    fileInput.value = "";
    redraw();
    logoStatus.textContent = "Local preview only · image stays on this device";
  });
  logoTools.append(fileLabel, clear, logoStatus);
  const adTools = document.createElement("div");
  adTools.className = "guest-design-logo-tools";
  if (eligible.some((choice) => choice.billboard)) {
    const adLabel = document.createElement("label");
    adLabel.textContent = "Try an ad image ";
    const adInput = document.createElement("input");
    adInput.type = "file";
    adInput.accept = "image/png,image/jpeg,image/webp";
    adInput.setAttribute("aria-label", "Preview an ad on billboard designs");
    adLabel.append(adInput);
    const clearAd = document.createElement("button");
    clearAd.type = "button";
    clearAd.textContent = "Clear ad";
    const adStatus = document.createElement("small");
    adStatus.setAttribute("aria-live", "polite");
    adStatus.textContent =
      "Local preview · appears on Diner or Arcade at level 3–4";
    adInput.addEventListener("change", async () => {
      const file = adInput.files?.[0];
      if (!file) return;
      if (
        !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size > 1_000_000
      ) {
        adStatus.textContent = "Choose PNG, JPEG or WebP under 1 MB.";
        return;
      }
      try {
        const bitmap = await createImageBitmap(file);
        onAd(bitmap);
        previewAd = bitmap;
        redraw();
        adStatus.textContent = `Previewing ${file.name} locally · no image uploaded`;
      } catch {
        adStatus.textContent = "This ad image could not be opened.";
      }
    });
    clearAd.addEventListener("click", () => {
      onAd(null);
      previewAd = null;
      adInput.value = "";
      redraw();
      adStatus.textContent =
        "Local preview · appears on Diner or Arcade at level 3–4";
    });
    adTools.append(adLabel, clearAd, adStatus);
  }
  for (const choice of eligible) {
    const button = document.createElement("button");
    button.className = "guest-design-card";
    button.dataset.choice = choice.id;
    button.type = "button";
    button.setAttribute("aria-pressed", String(choice.id === currentId));
    button.setAttribute(
      "aria-label",
      `Preview ${choice.name} on plot ${plot.index + 1}`,
    );
    const canvas = document.createElement("canvas");
    canvas.width = units * 85;
    canvas.height = 190;
    const context = canvas.getContext("2d");
    if (context)
      paintGuestChoice(context, choice, level, previewLogo, true, previewAd);
    const caption = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = choice.name;
    const detail = document.createElement("small");
    detail.textContent = choice.description;
    caption.append(name, detail);
    if (choice.billboard) {
      const ad = document.createElement("small");
      ad.textContent = "Billboard from level 3";
      caption.append(ad);
    }
    button.append(canvas, caption);
    button.addEventListener("click", () => {
      selectedId = choice.id;
      grid
        .querySelectorAll<HTMLButtonElement>(".guest-design-card")
        .forEach((card) =>
          card.setAttribute("aria-pressed", String(card === button)),
        );
      redrawContext();
    });
    grid.append(button);
  }
  redrawContext();
  wrapper.append(
    heading,
    intro,
    levels,
    grid,
    contextPreview,
    showOnStreet,
    logoTools,
  );
  if (adTools.childElementCount) wrapper.append(adTools);
  root.replaceChildren(wrapper);
  requestIllustrations();
}
