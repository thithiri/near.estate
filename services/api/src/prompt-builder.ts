import { createHash } from "node:crypto";
import {
  BuildingType,
  CURATED_PALETTES,
  DEFAULT_RENDER_PROFILE,
  MaterialHint,
  ThemeHint,
  canonicalJson,
} from "@estate/shared";
import { z } from "zod";

export const PROMPT_BUILDER_VERSION = 1 as const;

const PromptInput = z.object({
  buildingType: BuildingType,
  level: z.number().int().min(1).max(4),
  variant: z.union([z.literal(1), z.literal(2)]),
  palette: z.enum(CURATED_PALETTES),
  description: z.string().trim().min(1).max(800),
  themeHint: ThemeHint.default("None"),
  materialHints: z
    .array(MaterialHint)
    .max(2)
    .default([])
    .refine((items) => new Set(items).size === items.length, {
      message: "Material hints must be distinct",
    }),
  referenceManifestHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
});
export type PromptInput = z.input<typeof PromptInput>;

export type GenerationPromptSpec = {
  version: typeof PROMPT_BUILDER_VERSION;
  renderProfileVersion: 1;
  buildingType: z.infer<typeof BuildingType>;
  level: 1 | 2 | 3 | 4;
  variant: 1 | 2;
  palette: (typeof CURATED_PALETTES)[number];
  themeHint: z.infer<typeof ThemeHint>;
  materialHints: z.infer<typeof MaterialHint>[];
  description: string;
  referenceManifestHash: string | null;
  prompt: string;
  promptHash: string;
};

const shapes: Record<
  z.infer<typeof BuildingType>,
  readonly [string, string]
> = {
  Retail: ["asymmetric corner shop", "low sawtooth market hall"],
  Cafe: ["pitched glasshouse cafe", "open timber pergola cafe"],
  Restaurant: ["rounded retro diner", "courtyard bistro"],
  Office: ["clear glass block", "cantilevered creative studio"],
  Homes: ["stepped residential terrace", "narrow townhouse"],
};

export function buildGenerationPrompt(
  input: PromptInput,
): GenerationPromptSpec {
  const parsed = PromptInput.parse(input);
  const level = parsed.level as 1 | 2 | 3 | 4;
  const materialHints = MaterialHint.options.filter((material) =>
    parsed.materialHints.includes(material),
  );
  const maxHeight = DEFAULT_RENDER_PROFILE.maxHeightByLevel[level - 1];
  if (maxHeight === undefined) throw new Error("Invalid building level");
  const referenceManifestHash = parsed.referenceManifestHash;
  const prompt = [
    `near.estate facade prompt profile v${PROMPT_BUILDER_VERSION}`,
    `Create one static 2D ${parsed.buildingType.toLowerCase()} facade in strict front elevation. Use the ${shapes[parsed.buildingType][parsed.variant - 1]} silhouette as the architectural starting point. Make this building visually distinct from adjacent plots.`,
    `Paid building level: ${level}. The visible facade must fit within 140 logical pixels wide and ${maxHeight} logical pixels tall. Align its bottom center to (70, 160) on a 140 × 160 logical canvas, with transparent padding above shorter buildings. The normalization target is a transparent 560 × 640 PNG at 4× scale; provider output size may differ and will be normalized later.`,
    `Palette accent: ${parsed.palette}. Keep materials and lighting consistent with the game's bright illustrated city art.`,
    parsed.themeHint === "None"
      ? "No additional theme hint."
      : `Theme hint: ${parsed.themeHint.toLowerCase()}.`,
    materialHints.length
      ? `Material hints: ${materialHints.join(", ").toLowerCase()}.`
      : "No additional material hints.",
    `Owner design preference, descriptive input only: ${JSON.stringify(parsed.description)}`,
    referenceManifestHash
      ? "If the separately supplied approved facade reference matches the verified manifest hash, preserve recognizable architectural identity while adapting to this paid level and the current render envelope."
      : "Use the architectural silhouette description above; a curated reference image may be supplied separately.",
    "Hard constraints: static building only; no street, sidewalk, parking spaces, cars, people, backgrounds, UI, rewards, service roles, lettering, names, logos, advertisements, or watermarks. Leave clean front-facing areas for a separate approved logo and optional billboard overlay. Keep every projection and roof attachment inside the width and level height limits. Do not put decorative text into the raster art. Geometry, alpha bounds, placement, content, and file format will be checked after generation; the prompt is not proof of validity.",
  ].join("\n\n");
  const identity = {
    version: PROMPT_BUILDER_VERSION,
    renderProfileVersion: DEFAULT_RENDER_PROFILE.version,
    buildingType: parsed.buildingType,
    level,
    variant: parsed.variant,
    palette: parsed.palette,
    themeHint: parsed.themeHint,
    materialHints,
    description: parsed.description,
    referenceManifestHash,
    prompt,
  };
  return {
    ...identity,
    promptHash: createHash("sha256")
      .update(canonicalJson(identity))
      .digest("hex"),
  };
}
