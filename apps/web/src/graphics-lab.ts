import {
  DRAFT_STREETS,
  draftParcelLayout,
  type DraftStreetId,
  type DraftSide,
} from "./parcel-layout.js";
import { choices, type Choice } from "./frontage-art.js";
import type { BuildingLevel } from "./frontage-layout.js";
import {
  paintGuestChoice,
  preloadGuestBuilding,
} from "./guest-illustration.js";

const choiceById = new Map(choices.map((choice) => [choice.id, choice]));
const canvas = document.querySelector<HTMLCanvasElement>("#street")!;
let ctx = canvas.getContext("2d")!;
const streetSelect =
  document.querySelector<HTMLSelectElement>("#street-choice")!;
const levelSelect = document.querySelector<HTMLSelectElement>("#level-choice")!;
const sideButton = document.querySelector<HTMLButtonElement>("#flip-side")!;
const label = document.querySelector<HTMLElement>("#selection-label")!;
const detail = document.querySelector<HTMLElement>("#selection-detail")!;
const logoStatus = document.querySelector<HTMLElement>("#logo-status")!;
let street: DraftStreetId = "main";
let side: DraftSide = "North";
let level: BuildingLevel = 2;
let selected = 0;
let logo: ImageBitmap | null = null;
const custom = new Map<string, string>();

function key(index: number): string {
  return `${street}:${side}:${index}`;
}
function rect(x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}
function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 1,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
function roundRect(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
}
function drawBuilding(
  choice: Choice,
  x: number,
  base: number,
  logoImage: ImageBitmap | null,
  selectedBuilding: boolean,
): void {
  ctx.save();
  ctx.translate(x, base - 190);
  paintGuestChoice(ctx, choice, level, logoImage, selectedBuilding);
  ctx.restore();
}

function drawStreet(): void {
  const layout = draftParcelLayout(street, side);
  canvas.width = layout.width;
  canvas.style.width = `${layout.width}px`;
  rect(0, 0, layout.width, 300, "#d7eff4");
  rect(0, 146, layout.width, 44, "#e6d7bf");
  rect(0, 190, layout.width, 16, "#bbb4a4");
  rect(0, 206, layout.width, 40, "#68747b");
  rect(0, 246, layout.width, 54, "#555f67");
  for (let x = 0; x < layout.width; x += 42) {
    line(x, 190, x + 13, 190, "#f5ecd6");
    line(x, 199, x, 205, "#c1b49c");
  }
  line(0, 205, layout.width, 205, "#f8f0d7", 2);
  for (let x = 27; x < layout.width; x += 56) rect(x, 271, 29, 2, "#e9e7cf");
  for (const gap of layout.crossings) {
    rect(gap.x, 143, 76, 157, "#55616a");
    for (let n = 0; n < 5; n++) rect(gap.x + 7 + n * 13, 209, 8, 38, "#f5f0dc");
    line(gap.x - 5, 249, gap.x - 5, 286, "#e9e7cf", 2);
    line(gap.x + 81, 249, gap.x + 81, 286, "#e9e7cf", 2);
    roundRect(gap.x + 8, 153, 61, 22, 3, "#19634f");
    ctx.fillStyle = "#fff";
    ctx.font = "bold 8px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(gap.name.replace(" Avenue", " Ave"), gap.x + 38, 164, 55);
    rect(gap.x + 37, 175, 2, 15, "#566b66");
  }
  for (const parcel of layout.parcels) {
    const all = choices.filter((c) => c.units === parcel.units);
    const choice = choiceById.get(
      custom.get(key(parcel.index)) ?? all[parcel.index % all.length]!.id,
    )!;
    rect(
      parcel.x + 2,
      160,
      parcel.width - 4,
      31,
      parcel.index === selected ? "#e9d4a7" : "#d9cfb8",
    );
    drawBuilding(choice, parcel.x, 190, logo, parcel.index === selected);
    line(parcel.x, 155, parcel.x, 205, "#a49379", 1);
    for (let slot = 0; slot < parcel.spaces; slot++) {
      const sx = parcel.x + 10 + slot * 85;
      line(sx, 211, sx, 243, "#f4f0dd", 2);
      line(sx + 64, 211, sx + 64, 243, "#f4f0dd", 2);
      line(sx, 243, sx + 64, 243, "#f4f0dd", 2);
      roundRect(sx + 7, 213, 50, 11, 2, "#266d70");
      ctx.fillStyle = "#fff";
      ctx.font = "bold 7px Trebuchet MS, Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("FREE", sx + 32, 219);
    }
    if (parcel.index === selected) {
      ctx.strokeStyle = "#f3b84c";
      ctx.lineWidth = 3;
      ctx.strokeRect(parcel.x + 2, 147, parcel.width - 4, 99);
    }
  }
  const parcel = layout.parcels[selected]!;
  const eligible = choices.filter((entry) => entry.units === parcel.units);
  const choice = choiceById.get(
    custom.get(key(selected)) ?? eligible[selected % eligible.length]!.id,
  )!;
  label.textContent = `Plot ${selected + 1} · ${parcel.units} ${parcel.units === 1 ? "unit" : "units"} · ${parcel.spaces} ${parcel.spaces === 1 ? "space" : "spaces"}`;
  detail.textContent = `${choice.name} · Level ${level} on ${DRAFT_STREETS.find((s) => s.id === street)!.name}, ${side} side. Click a plot in the street or a building choice below.`;
  document
    .querySelectorAll<HTMLButtonElement>(".choice-card")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.choice === choice.id),
      ),
    );
}

function drawCard(canvasElement: HTMLCanvasElement, choice: Choice): void {
  const cardCtx = canvasElement.getContext("2d")!;
  cardCtx.clearRect(0, 0, 236, 200);
  cardCtx.fillStyle = "#d9eef2";
  cardCtx.fillRect(0, 0, 236, 200);
  cardCtx.fillStyle = "#d8cdb8";
  cardCtx.fillRect(0, 175, 236, 25);
  // Building drawing is shared with the street, so copy its pixels at native scale.
  const scratch = document.createElement("canvas");
  scratch.width = choice.units * 85;
  scratch.height = 190;
  const original = ctx;
  const scratchCtx = scratch.getContext("2d")!;
  ctx = scratchCtx;
  drawBuilding(choice, 0, 186, logo, true);
  ctx = original;
  const scale = Math.min(220 / scratch.width, 176 / scratch.height);
  const drawW = scratch.width * scale;
  const drawH = scratch.height * scale;
  cardCtx.drawImage(scratch, (236 - drawW) / 2, 176 - drawH, drawW, drawH);
  cardCtx.fillStyle = "#566e79";
  cardCtx.font = "bold 11px Arial";
  cardCtx.textAlign = "center";
  cardCtx.fillText(
    `${choice.units} UNIT${choice.units === 1 ? "" : "S"}`,
    118,
    192,
  );
}

const grid = document.querySelector<HTMLElement>("#choice-grid")!;
function redrawCards(): void {
  grid.querySelectorAll<HTMLButtonElement>(".choice-card").forEach((button) => {
    const choice = choiceById.get(button.dataset.choice ?? "");
    const cardCanvas = button.querySelector("canvas");
    if (choice && cardCanvas) drawCard(cardCanvas, choice);
  });
}
for (const units of [1, 2, 3] as const) {
  const section = document.createElement("section");
  section.className = "panel choice-column";
  section.innerHTML = `<h3>${units} ${units === 1 ? "unit" : "units"}</h3><p class="size-note">${units} curb ${units === 1 ? "space" : "spaces"} · ${units * 85} px frontage</p>`;
  for (const choice of choices.filter((entry) => entry.units === units)) {
    const button = document.createElement("button");
    button.className = "choice-card";
    button.type = "button";
    button.dataset.choice = choice.id;
    button.setAttribute("aria-label", `Preview ${choice.name}`);
    const image = document.createElement("canvas");
    image.width = 236;
    image.height = 200;
    const words = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = choice.name;
    const desc = document.createElement("small");
    desc.textContent = choice.description;
    words.append(name, desc);
    button.append(image, words);
    button.addEventListener("click", () => {
      const layout = draftParcelLayout(street, side);
      if (layout.parcels[selected]?.units !== units)
        selected = layout.parcels.findIndex((parcel) => parcel.units === units);
      custom.set(key(selected), choice.id);
      drawStreet();
      document.querySelector(".street-window")?.scrollTo({
        left: Math.max(0, layout.parcels[selected]!.x - 200),
        behavior: "smooth",
      });
    });
    section.append(button);
    drawCard(image, choice);
  }
  grid.append(section);
}
streetSelect.addEventListener("change", () => {
  street = streetSelect.value as DraftStreetId;
  selected = 0;
  drawStreet();
});
levelSelect.addEventListener("change", () => {
  level = Number(levelSelect.value) as BuildingLevel;
  drawStreet();
  redrawCards();
  requestIllustrations();
});
sideButton.addEventListener("click", () => {
  side = side === "North" ? "South" : "North";
  sideButton.textContent = `${side} side ↔ ${side === "North" ? "South" : "North"} side`;
  selected = 0;
  drawStreet();
});
canvas.addEventListener("click", (event) => {
  const bounds = canvas.getBoundingClientRect();
  const x = ((event.clientX - bounds.left) * canvas.width) / bounds.width;
  const parcel = draftParcelLayout(street, side).parcels.find(
    (entry) => x >= entry.x && x < entry.x + entry.width,
  );
  if (parcel) {
    selected = parcel.index;
    drawStreet();
  }
});
document
  .querySelector<HTMLInputElement>("#logo-file")!
  .addEventListener("change", async (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 1_000_000
    ) {
      logoStatus.textContent = "Choose PNG, JPEG or WebP under 1 MB.";
      return;
    }
    try {
      const next = await createImageBitmap(file);
      logo?.close();
      logo = next;
      logoStatus.textContent = `Previewing ${file.name} locally. No image was uploaded.`;
      drawStreet();
      redrawCards();
    } catch {
      logoStatus.textContent = "This image could not be opened.";
    }
  });
document
  .querySelector<HTMLButtonElement>("#clear-logo")!
  .addEventListener("click", () => {
    logo?.close();
    logo = null;
    document.querySelector<HTMLInputElement>("#logo-file")!.value = "";
    logoStatus.textContent = "Local preview only. Images are not saved.";
    drawStreet();
    redrawCards();
  });
drawStreet();
function requestIllustrations(): void {
  const requestedLevel = level;
  void Promise.all(
    choices.map((choice) => preloadGuestBuilding(choice, requestedLevel)),
  ).then(() => {
    if (level !== requestedLevel) return;
    drawStreet();
    redrawCards();
  });
}
requestIllustrations();
