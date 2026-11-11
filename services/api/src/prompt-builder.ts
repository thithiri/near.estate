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

export const PROMPT_BUILDER_VERSION = 4 as const;

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
  // Older jobs retain their stored prompt and hash while new jobs use version 4.
  version: 1 | 2 | 3 | typeof PROMPT_BUILDER_VERSION;
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
    "Corner shop: an asymmetric brick tower on the left joined to a shop wing with a striped awning, with the entrance in the wing",
    "Market hall: a broad low brick market with two sawtooth roof peaks, a central entrance and display bays",
  ],
  Cafe: [
    "Glasshouse: a broad triangular greenhouse with a central timber door and plants behind glass ribs",
    "Pergola: a horizontal timber cafe with a slatted canopy, a left-offset entrance, two glazed bays and hanging plants",
  ],
  Restaurant: [
    "Diner: a rounded red-and-silver enamel diner with a central double door, wraparound windows and a blank rooftop ad sign",
    "Bistro: a cream stucco courtyard restaurant with a tiled left gable, offset entrance, planted right terrace and warm arched windows",
  ],
  Office: [
    "Glass block: a narrow blue-framed glass office with a pale left structural pier, slanted blue canopy and central glazed entrance",
    "Studio: a wide blue-glass office with stacked flat concrete bands, a right-recessed entrance and restrained roof planting",
  ],
  Homes: [
    "Terrace: two joined residences, cream stucco on the left and coral brick on the right, paired doors, flower balconies and a stepped terracotta parapet",
    "Townhouse: one narrow cream-stucco residence with a centered green door, a steep coral-tiled gable and flower boxes",
  ],
};

const materials: Record<z.infer<typeof BuildingType>, string> = {
  Retail: "warm brick, canvas awning and large display glass",
  Cafe: "glass greenhouse ribs or timber pergola, warm wood and plants",
  Restaurant: "enamel trim, broad windows and warm dining lights",
  Office: "blue framed glazing and pale concrete",
  Homes: "warm plaster, brick, balconies and planters",
};

const levelFeatures: Record<
  z.infer<typeof BuildingType>,
  readonly [
    readonly [string, string, string, string],
    readonly [string, string, string, string],
  ]
> = {
  Retail: [
    [
      "One shop floor, a short left brick pier, striped awning and clear display windows.",
      "A taller corner frontage with a display wing and stronger striped awning.",
      "A second-floor showroom and balcony above the shop; the left brick tower rises higher.",
      "A third-floor setback showroom and an ornamental cap on the left brick tower.",
    ],
    [
      "One low market floor beneath two simple sawtooth roof peaks.",
      "A broad market frontage with several display bays and a clear sign band.",
      "An upper glazed gallery beneath the two sawtooth peaks.",
      "A third market section and planted upper display gallery while keeping the sawtooth silhouette.",
    ],
  ],
  Cafe: [
    [
      "One low greenhouse room, central door, simple glass ribs and planting.",
      "A broader greenhouse facade with stronger ribs and planting.",
      "A glazed dining mezzanine beneath a taller triangular glass roof.",
      "A third section with a setback conservatory and planted upper decks.",
    ],
    [
      "One low timber kiosk, left door and two glazed bays beneath a short pergola.",
      "A wider horizontal pergola facade, blank sign band and hanging plants.",
      "An upper glazed dining floor with a planted balcony under the pergola roof.",
      "A setback rooftop garden room beneath a second short pergola.",
    ],
  ],
  Restaurant: [
    [
      "One low dining floor beneath the rounded enamel roof and a blank rooftop ad sign.",
      "A broader rounded dining frontage with wraparound windows.",
      "An upper glazed dining floor beneath the separate blank rooftop sign.",
      "A third glazed dining section and a larger separate blank rooftop sign.",
    ],
    [
      "One low stucco dining floor with outdoor tables beside the tiled left gable.",
      "A wider courtyard with warm windows, vines and planters.",
      "An upper dining balcony over the planted courtyard.",
      "A setback roof dining pavilion and two planted balconies beneath tiled roofs.",
    ],
  ],
  Office: [
    [
      "One glazed office floor beneath the slanted canopy, with a small right planter.",
      "A slim two-floor glass office with the left pier and slanted canopy.",
      "Three glazed office sections with a small right balcony.",
      "A tall glass tower with a setback roof studio, keeping the slanted canopy and left pier.",
    ],
    [
      "One broad office floor beneath a flat concrete slab, with a recessed right door.",
      "A wide two-floor concrete slab with blue glazing and roof planting.",
      "Three horizontal office floors separated by cantilevered concrete bands.",
      "Four broad work floors and a planted roof terrace, still defined by flat concrete bands.",
    ],
  ],
  Homes: [
    [
      "Two low joined one-floor homes with cream and coral fronts and separate doors.",
      "Paired two-level facades with flower balconies and a stepped parapet.",
      "A third residential tier with upper terrace and windows above the paired homes.",
      "A setback roof pavilion above the paired homes, with more balconies and planting.",
    ],
    [
      "One compact ground-floor home beneath the steep tiled gable, with one central door.",
      "A narrow two-level home with one flower balcony beneath the gable.",
      "Three narrow residential tiers and a flower balcony beneath the same gable.",
      "Four narrow tiers with two flower balconies and an upper arched window beneath the gable.",
    ],
  ],
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
  const variantIndex = parsed.variant === 1 ? 0 : 1;
  const levelFeature =
    levelFeatures[parsed.buildingType][variantIndex][level - 1];
  if (!levelFeature) throw new Error("Invalid building shape or level");
  const referenceManifestHash = parsed.referenceManifestHash;
  const prompt = [
    `near.estate facade prompt profile v${PROMPT_BUILDER_VERSION}`,
    `Create one static 2D ${parsed.buildingType.toLowerCase()} facade in strict front elevation. Use ${shapes[parsed.buildingType][variantIndex]} as the architectural starting point. Keep its massing, entrance and roof shape distinct from the other variant and adjacent plots.`,
    `Paid building level: ${level}. The visible facade must fit within 140 logical pixels wide and ${maxHeight} logical pixels tall. Keep approximately 5 logical pixels of clear side margin where possible. Align its bottom center to (70, 160) on a 140 × 160 logical canvas, with transparent padding above shorter buildings. The normalization target is a transparent 560 × 640 PNG at 4× scale; provider output size may differ and will be normalized later. Level-specific feature: ${levelFeature} Treat this level as a height limit; preserve the chosen shape and add its feature instead of stretching an earlier image. One plot owns two curb spaces, but this architectural image contains no curb geometry.`,
    `Visual style: friendly hand-inked 2D city illustration, confident dark navy outlines, broad flat colors, restrained highlights and warm cream details. Make the entrance and roofline legible at 140 logical pixels of game display width. Type materials: ${materials[parsed.buildingType]}. Palette accent: ${parsed.palette}; keep the type materials recognizable if the accent changes.`,
    parsed.buildingType === "Homes"
      ? "Leave one clean front-facing 20 × 20 logical-pixel area for a separately rendered owner logo on a blank wall without covering a window or door. Do not include a billboard surface on residential buildings. Do not draw text or logos; the game adds approved media later."
      : "Leave one clean front-facing 20 × 20 logical-pixel area for a separately rendered owner logo. If a billboard is included, reserve a different blank, nearly flat 48 × 24 logical-pixel surface. Keep any architectural name sign blank and separate from the billboard. Do not draw text or ad content on these surfaces; the game adds approved media later.",
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
