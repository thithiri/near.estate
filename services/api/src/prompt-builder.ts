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

export const PROMPT_BUILDER_VERSION = 3 as const;

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
  // Older jobs retain their stored prompt and hash while new jobs use version 3.
  version: 1 | 2 | typeof PROMPT_BUILDER_VERSION;
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
  Retail: [
    "an asymmetric brick corner tower joined to a low wide shop wing, with the entrance in the wing",
    "a low sawtooth market hall with a central entrance and broad display bays",
  ],
  Cafe: [
    "a broad triangular greenhouse with a central timber door and visible plants behind glass ribs",
    "a low timber cafe with a pergola canopy and an off-center service entrance",
  ],
  Restaurant: [
    "a low rounded retro diner with a central double door and wraparound windows",
    "a courtyard bistro with an offset entrance and open terrace frontage",
  ],
  Office: [
    "a tall narrow glass work studio with an angled flat roof and a clear front entrance",
    "a wide cantilevered concrete studio with horizontal glazing and a recessed entrance",
  ],
  Homes: [
    "a stepped residential terrace with attached sections, staggered heights, several narrow entrances and planted upper levels",
    "a narrow standalone townhouse with one centered entrance and a pitched roof",
  ],
};

const materials: Record<z.infer<typeof BuildingType>, string> = {
  Retail: "warm brick, canvas awning and large display glass",
  Cafe: "glass greenhouse ribs or timber pergola, warm wood and plants",
  Restaurant: "enamel trim, broad windows and warm dining lights",
  Office: "blue framed glazing and pale concrete",
  Homes: "warm plaster, brick, balconies and planters",
};

const levelDirection = [
  "Keep the architecture simple and low, with one unmistakable entrance and roofline.",
  "Add one type-specific feature, such as a display awning, garden canopy, diner marquee, planted terrace or balcony.",
  "Add a stronger type-specific roof, terrace or upper-level feature while preserving the chosen silhouette.",
  "Use the full decoration budget for type-specific roof and facade detail; a low concept may stay low if its identity is clearer that way.",
] as const;

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
    `Create one static 2D ${parsed.buildingType.toLowerCase()} facade in strict front elevation. Use ${shapes[parsed.buildingType][parsed.variant - 1]} as the architectural starting point. Keep its massing, entrance and roof shape distinct from the other variant and adjacent plots.`,
    `Paid building level: ${level}. The visible facade must fit within 140 logical pixels wide and ${maxHeight} logical pixels tall. Keep approximately 5 logical pixels of clear side margin where possible. Align its bottom center to (70, 160) on a 140 × 160 logical canvas, with transparent padding above shorter buildings. The normalization target is a transparent 560 × 640 PNG at 4× scale; provider output size may differ and will be normalized later. ${levelDirection[level - 1]}`,
    `Visual style: friendly hand-inked 2D city illustration, confident dark navy outlines, broad flat colors, restrained highlights and warm cream details. Make the entrance and roofline legible at 140 logical pixels of game display width. Type materials: ${materials[parsed.buildingType]}. Palette accent: ${parsed.palette}; keep the type materials recognizable if the accent changes.`,
    "Leave one clean front-facing 20 × 20 logical-pixel area for a separately rendered owner logo. If a billboard is included, reserve a different blank, nearly flat 48 × 24 logical-pixel surface. Do not draw text or ad content on either surface; the game adds approved media later.",
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
    "Hard constraints: static building only; no street, sidewalk, parking spaces, cars, people, backgrounds, cast shadows, UI, rewards, service roles, lettering, names, logos, advertisements, or watermarks. Use a genuinely transparent background and a level bottom edge; no perspective or isometric view. Keep every projection and roof attachment inside the width and level height limits. Geometry, alpha bounds, placement, content, and file format will be checked after generation; the prompt is not proof of validity.",
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
