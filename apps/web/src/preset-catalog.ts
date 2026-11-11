import rawCatalog from "./preset-catalog.json";
import { CURATED_PALETTES } from "@estate/shared";

export type FacadePreset = (typeof rawCatalog.facades)[number];

export { CURATED_PALETTES as PRESET_PALETTES };

const paletteNames = ["Coral", "Sky blue", "Mint", "Yellow"] as const;

export function paletteName(palette: string): string {
  const index = CURATED_PALETTES.findIndex((entry) => entry === palette);
  return index < 0 ? palette : paletteNames[index]!;
}

const presets = new Map(
  rawCatalog.facades.map((entry) => [
    `${entry.buildingType}:${entry.variant}:${entry.level}`,
    entry,
  ]),
);

export function facadePreset(
  buildingType: string,
  variant: number,
  level: number,
): FacadePreset {
  const preset = presets.get(`${buildingType}:${variant}:${level}`);
  if (!preset)
    throw new Error(
      `Missing facade preset: ${buildingType} ${variant} ${level}`,
    );
  return preset;
}

export function facadeAssetUrl(filename: string, hash: string): string {
  return `${import.meta.env?.BASE_URL ?? "/"}presets/${filename}?v=${hash.slice(0, 16)}`;
}
