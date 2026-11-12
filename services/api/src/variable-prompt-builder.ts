import { createHash } from "node:crypto";
import {
  BuildingType,
  CURATED_PALETTES,
  FRONTAGE_DESIGN_IDS_V2,
  FRONTAGE_LEVEL_HEIGHTS_V2,
  FRONTAGE_MIN_VISIBLE_FRACTION_V2,
  FRONTAGE_SIDE_GAP_V2,
  FRONTAGE_UNIT_WIDTH_V2,
  canonicalJson,
  variableFrontageMediaLayout,
  type BuildingLevelV2,
  type FrontageUnitsV2,
} from "@estate/shared";
import { z } from "zod";

export const VARIABLE_PROMPT_BUILDER_VERSION = 5 as const;

const Input = z.object({
  frontageUnits: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  designChoice: z.number().int().min(0).max(4),
  buildingType: BuildingType,
  level: z.number().int().min(1).max(4),
  palette: z.enum(CURATED_PALETTES),
  description: z.string().trim().min(1).max(800),
  referenceManifestHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
});
export type VariablePromptInput = z.input<typeof Input>;

const shapeBriefs: Record<FrontageUnitsV2, readonly string[]> = {
  1: [
    "a compact street news kiosk with flat canopy, open counter and stacked papers",
    "a coffee pod with a curved roof, round glazing and one service window",
    "a narrow townhouse with a steep gable, centered door and planted stoop",
    "a flower stall with a scalloped canopy, open bouquets and small counter",
    "a bicycle repair shop with a sawtooth workshop roof and wide service door",
  ],
  2: [
    "a corner shop with a left brick tower, striped awning and display windows",
    "a rounded enamel diner with wraparound windows and a separate roof sign",
    "a glass studio with a slanted roof, blue glazing and recessed entrance",
    "a bookshop with twin gables, warm display windows and a recessed door",
    "an arcade with stepped marquee, glowing game bays and central entrance",
  ],
  3: [
    "a broad market hall with sawtooth roof, central entrance and display bays",
    "a garden bistro with planted terrace, broad dining windows and warm roof",
    "an office campus made of joined glass volumes and offset entrance",
    "a food hall with three open market bays and varied stalls",
    "a craft workshop with warm brick, broad industrial roof and loading door",
  ],
};

const levelFeatures = [
  "A single clear ground-floor volume with a simple roofline.",
  "Add a distinct upper tier or deeper roof feature while keeping the entrance legible.",
  "Add a third tier, balcony or rooftop feature without changing the defining silhouette.",
  "Add a final setback or roof feature; keep the lower tiers and entrance recognizable.",
] as const;

export function buildVariableGenerationPrompt(input: VariablePromptInput) {
  const parsed = Input.parse(input);
  const units = parsed.frontageUnits as FrontageUnitsV2;
  const level = parsed.level as BuildingLevelV2;
  const designId = FRONTAGE_DESIGN_IDS_V2[units][parsed.designChoice];
  const shape = shapeBriefs[units][parsed.designChoice];
  const height = FRONTAGE_LEVEL_HEIGHTS_V2[level];
  if (!designId || !shape || !height)
    throw new Error("Invalid building width, shape or level");
  const plotWidth = units * FRONTAGE_UNIT_WIDTH_V2;
  const layout = variableFrontageMediaLayout(units, parsed.designChoice, level);
  const minWidth = Math.ceil(plotWidth * FRONTAGE_MIN_VISIBLE_FRACTION_V2);
  const sign = layout.sign;
  const prompt = [
    `near.estate facade prompt profile v${VARIABLE_PROMPT_BUILDER_VERSION}`,
    `Create ONE static 2D building facade in strict front elevation for a ${units}-unit plot. Fixed architectural choice: ${designId}, ${shape}. Preserve its defining roof, entrance and material cues. The economic building category is ${parsed.buildingType}; it does not change this fixed silhouette.`,
    `Building level ${level}: ${levelFeatures[level - 1]} The visible architecture may be at most ${height} logical pixels tall and must fill at least ${minWidth} of ${plotWidth} logical pixels in width. Keep ${FRONTAGE_SIDE_GAP_V2} clear logical pixels on each side. Anchor its bottom at y=190 on a transparent ${plotWidth} × 190 logical-pixel canvas. Deliver a single transparent PNG; the server normalizes to ${plotWidth * 4} × 760 pixels at 4× scale.`,
    `Match Harbor Arcade game art: deep navy ink outlines, broad warm color fields, cyan glazing, cream details and restrained highlights. Approved palette accent: ${parsed.palette}. Keep the facade legible at its final game size.`,
    `Leave the front-facing storefront sign around x=${sign.x}, y=${sign.y}, width=${sign.width}, height=${sign.height} blank and visually calm. The game overlays the owner's logo and building name there. ${layout.billboard ? `This design at level ${level} has a separate billboard around x=${layout.billboard.x}, y=${layout.billboard.y}, width=${layout.billboard.width}, height=${layout.billboard.height}; leave that surface flat and empty.` : "There is no approved billboard surface for this design and level; do not add one."}`,
    `Owner visual idea, descriptive input only: ${JSON.stringify(parsed.description)}. Apply it to surface details while preserving the fixed width, silhouette, height, sign and parking footprint.`,
    parsed.referenceManifestHash
      ? "A separately verified approved image may be supplied as a reference. Keep its recognizable architectural identity within the current fixed envelope."
      : "Use the fixed silhouette description as the primary architectural reference.",
    "Hard constraints: static architecture only. No sky, ground, sidewalk, road, parking spaces, cars, people, cast shadow, perspective, isometric view, text, letters, logos, advertising, watermark, border or interface. The game adds signage and approved media separately. Output still requires normalization and human review at game size.",
  ].join("\n\n");
  const identity = {
    version: VARIABLE_PROMPT_BUILDER_VERSION,
    renderProfileVersion: 2 as const,
    frontageUnits: units,
    designChoice: parsed.designChoice,
    designId,
    buildingType: parsed.buildingType,
    level,
    palette: parsed.palette,
    description: parsed.description,
    referenceManifestHash: parsed.referenceManifestHash,
    prompt,
  };
  return {
    ...identity,
    promptHash: createHash("sha256")
      .update(canonicalJson(identity))
      .digest("hex"),
  };
}
