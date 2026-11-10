import { z } from "zod";

export const ThemeHint = z.enum([
  "None",
  "Playful",
  "Garden",
  "Industrial",
  "Classic",
  "Minimal",
]);
export type ThemeHint = z.infer<typeof ThemeHint>;

export const MaterialHint = z.enum([
  "Brick",
  "Timber",
  "Glass",
  "Concrete",
  "Metal",
  "Tile",
]);
export type MaterialHint = z.infer<typeof MaterialHint>;
