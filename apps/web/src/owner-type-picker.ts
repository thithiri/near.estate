import { BuildingType } from "@estate/shared";
import { paletteName, PRESET_PALETTES } from "./preset-catalog.js";
import { buildingMarkup } from "./studio-screen.js";

export function ownerTypePickerMarkup(
  selectedType: (typeof BuildingType.options)[number],
  variant: 1 | 2,
  level: number,
  palette: string,
): string {
  return `<div class="owner-type-picker" role="group" aria-label="Choose building type">
    <strong>Choose a building type</strong>
    <div class="owner-type-grid">${BuildingType.options.map((type) => `<button type="button" class="owner-type-card" data-owner-building-type="${type}" aria-label="Preview ${type} building" aria-pressed="${type === selectedType}"><span class="owner-type-art" aria-hidden="true">${buildingMarkup(type, variant, level, palette)}</span><span class="owner-type-label">${type}</span></button>`).join("")}</div>
    <p class="muted">Selecting a type only changes this preview. Use the action below to change your plot.</p>
  </div>`;
}

export function ownerPalettePickerMarkup(selectedPalette: string): string {
  return `<fieldset class="owner-palette-picker"><legend>Colour</legend><div class="owner-palette-choices">${PRESET_PALETTES.map((palette) => `<button type="button" data-owner-building-palette="${palette}" aria-label="${paletteName(palette)} colour" aria-pressed="${palette === selectedPalette}"><span class="owner-palette-swatch" style="background:${palette}" aria-hidden="true"></span><span>${paletteName(palette)}</span></button>`).join("")}</div></fieldset>`;
}
