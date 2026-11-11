import rawCatalog from "./preset-catalog.json";

export type FacadePreset = (typeof rawCatalog.facades)[number];

export { CURATED_PALETTES as PRESET_PALETTES } from "@estate/shared";

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
  return `${import.meta.env.BASE_URL}presets/${filename}?v=${hash.slice(0, 16)}`;
}
