# Building image specification · draft 3

This is the art direction for illustrated player buildings. Ten operator-created level-2 images cover both shapes of all five player building types. Six more images complete levels 1, 3 and 4 for the two Cafe shapes. They demonstrate possible looks in the running guest street; they are not published owner appearances. The existing curated library and on-chain approval flow remain the live path. Future owner generation can reuse this specification after provider, moderation and budget checks are enabled.

## Game fit

- Camera: strict straight-on front elevation; no side wall, isometric angle or perspective street scene.
- Final sprite: transparent 560 × 640 PNG, bottom-center anchored at `(70, 160)` logical pixels. The game places that anchor at sidewalk y=190.
- Plot pitch: 170 logical pixels; all art fits inside the centered 140-pixel facade width. Keep the outer 5 logical pixels clear where possible.
- Height caps: level 1 = 70, level 2 = 100, level 3 = 130, level 4 = 160 logical pixels. A higher level may add roof detail, balconies, terraces or a floor; it must keep the type recognizable and fit its cap.
- At 140-pixel display width, the entrance, roofline and type-specific material must still read. Avoid tiny decorative text or dense window grids.
- Image contains only architectural art. The renderer adds building name, approved logo, approved billboard and rule sign. Leave a clear 20 × 20 logical-pixel logo area and, if the architecture can support one, a separate blank 48 × 24 billboard area. Never bake advertising, lettering, cars, pavement, people, buttons or gameplay geometry into the sprite.

## Style and variants

Use friendly, crisp 2D illustrated city art: dark navy outlines, flat color fields, restrained highlights, warm cream details and selective planted greenery. Four player accent palettes are coral, sky blue, mint and yellow; type materials remain recognizable after an accent changes. Do not make every building an arch-and-awning storefront.

| Type       | Main silhouette                       | Alternate silhouette             | Material cue                            |
| ---------- | ------------------------------------- | -------------------------------- | --------------------------------------- |
| Retail     | Brick corner tower beside a wide shop | Low sawtooth market hall         | Brick, canvas awning, display glass     |
| Cafe       | Broad triangular greenhouse           | Timber kiosk and pergola         | Glass ribs, timber, plants              |
| Restaurant | Low rounded diner                     | Courtyard bistro                 | Enamel trim, large windows, warm lights |
| Office     | Tall narrow glass studio              | Wide cantilevered concrete block | Blue framed glazing, pale concrete      |
| Homes      | Stepped residential terrace           | Narrow gabled townhouse          | Warm plaster, balconies, planters       |

The two variants must differ in massing, entrance position and roof shape. Their variant numbers follow the curated owner choices: Retail is Corner shop / Market hall; Cafe is Glasshouse / Pergola; Restaurant is Diner / Bistro; Office is Glass block / Studio; Homes is Terrace / Townhouse. Level upgrades should add a type-specific feature instead of uniformly stretching the source image. Cafe now covers all four levels in both directions; Retail, Restaurant, Office and Homes still need their level-1, level-3 and level-4 illustrations before this style could replace the complete curated library.

For each generation request, fill the shape description from the chosen type and variant before appending the player's idea. Use these fixed level instructions: level 1 has one clear entrance and one roof feature; level 2 may add a second bay, planter or sign band; level 3 adds a type-specific upper section; level 4 may add a terrace, balcony or setback. A level is a height limit, not a command to stretch the image. For Cafe specifically, Glasshouse uses a triangular glass roof and central entrance; Pergola uses a low horizontal timber roof, a left-offset entrance, two glazed bays and plants. Keep the sign band and logo patch blank so the game can add approved media later.

The level-2 alternate briefs used for the current visual set fill `[VARIANT_DESCRIPTION]` as follows. Their proportions are visual targets, never permission to exceed the 140 × 100 logical envelope:

| Type       | Variant 2 generation brief                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Retail     | Low market hall, two sawtooth peaks, central entrance, broad display windows, brick piers, blank sign band and separate logo patch. |
| Cafe       | Compact horizontal timber pergola, left-offset entrance, two glazed bays, hanging plants and distinct blank media panels.           |
| Restaurant | Cream stucco courtyard bistro, tiled gable over a left entrance, open planted terrace, warm windows and a small blank sign.         |
| Office     | Wide two-level concrete slab, blue glazing, recessed right entrance, planted roof edge and blank upper sign and logo panels.        |
| Homes      | Single narrow gabled townhouse, centered entrance, stacked windows, one balcony and flower boxes; no billboard surface.             |

Generate a fresh image for each type, variant and paid level. Do not scale a level-2 image up to pretend that the player bought a higher level. The low level-2 studies on taller guest plots stay within the height cap but are only a visual trial.

### Cafe upgrade progression

| Level | Glasshouse · triangular roof                                      | Pergola · horizontal roof                                |
| ----- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| 1     | One low greenhouse room, central door, simple planting            | One low timber kiosk, left door, two glazed bays         |
| 2     | Broad greenhouse facade, stronger ribs and planting               | Wider pergola facade, sign band and hanging plants       |
| 3     | Glazed dining mezzanine under a taller triangular roof            | Upper glazed dining floor and planted balcony            |
| 4     | Third section with a setback conservatory and planted upper decks | Setback rooftop garden room under a second short pergola |

All eight Cafe sources are separate images. The normalizer accepts their original files at the specified levels: height caps of 70, 100, 130 and 160 logical pixels. The guest builder switches the illustrated pair to the selected level; the other four building types continue to show their available level-2 studies with that level stated in the caption.

## Versioned generation prompt

The game supplies all bracketed fields; the player supplies only the bounded description. The operator controls the style instructions and output checks.

```text
Use case: stylized-concept.
Asset type: transparent 2D facade sprite for near.estate, a side-scrolling parking city game.
Create ONE [BUILDING_TYPE] building, architectural direction [VARIANT_DESCRIPTION], level [LEVEL].
Player idea: [SANITIZED_DESCRIPTION].
Strict straight-on front elevation, centered and isolated, entire building visible with a level bottom edge. No perspective.
Keep the silhouette, entrance and type materials distinct and legible at 140 logical pixels wide. Maximum final height after normalization: [70|100|130|160] logical pixels. Leave a clean 20 × 20 logical-pixel area for the game-rendered owner logo and, if possible, a separate blank 48 × 24 area for an optional billboard. Leave a clear name panel; do not draw any text or ad content.
Visual style: friendly hand-inked 2D city illustration, confident dark navy outlines, broad flat colors, restrained highlights, warm cream details. Accent palette: [PALETTE]. Architectural material: [TYPE_MATERIAL].
Genuinely transparent background. No sky, ground, sidewalk, road, cars, people, cast shadow, lettering, advertisement, logo, watermark, interface or floating objects.
```

This prompt is a direction, not proof of fit. Decode the result, reject opaque backgrounds or embedded text, trim transparent margins, fit inside the target level envelope, pad to 560 × 640, then inspect at actual phone and desktop game scale. Reject rather than distort a silhouette that cannot fit. Record the image hash and overlay rectangles; keep raw art private until selection and approval in the future owner flow.

The second Cafe study used the following filled shape brief alongside the shared prompt: “Cafe, Pergola, level 2: a low, broad timber pergola with a flat slatted roof, two turquoise glass bays, a left-offset single door, cream trim and hanging plants. Dark navy contour lines. Leave one blank square logo patch and one blank horizontal name band. Straight-on, compact enough to fit a 140 × 100 logical-pixel envelope.” At game size, its final alpha bounds are recorded in the generated catalog. This brief is an art example; the player idea must remain bounded by the fixed silhouette, height and media rules.

The current backend normalizer accepts the Pergola source at level 2, with visible bounds of 130 × 95.75 logical pixels. Its automatic logo and billboard suggestions land on the roof and glazing, despite the image's clear blank panels. The guest preview uses manually aligned rectangles. Future owner generation needs semantic placement review or editable overlay positions before publication; a successful geometry check alone is insufficient.

The backend prompt builder currently uses profile v3 with the same envelope, style and broad shape restrictions; v3 aligns the Homes variant numbers with the selectable curated shapes. It does not yet encode every exact brief in the table above. Before enabling owner generation from these illustrated directions, update and version the builder rather than silently changing v3. Saved v1 and v2 jobs keep their original prompt and hash. Its image normalizer reserves five logical pixels on each side. All ten draft sources pass the actual level-2 geometry/alpha validator. Automatic logo and billboard rectangles are only geometric suggestions: they can land over windows or decoration. The moderator's candidate view outlines them, and a human must reject poor placements. Reliable editable placement, and a rule that suppresses a billboard when no suitable blank area exists, remain necessary before owner-generated art is offered.

## First illustrated guest set

The raw images live in [`art/source/illustrated`](../art/source/illustrated). [`prepare-illustrated-facades.mjs`](../scripts/prepare-illustrated-facades.mjs) normalizes them into [`apps/web/public/illustrated`](../apps/web/public/illustrated) and writes the hash, variant and level catalog to [`apps/web/src/illustrated-catalog.json`](../apps/web/src/illustrated-catalog.json). The guest builder shows both shapes of each type side by side, using the selected level when an image exists. Main Street `plot-main-n-1` shows level-2 Cafe Pergola and `plot-main-n-6` shows level-3 Glasshouse; Market Street `plot-market-n-0` shows level-1 Glasshouse and Central Avenue `plot-central-n-3` shows level-4 Pergola. The other types currently use their level-2 images on matching level-3 guest plots, remaining under the height cap. The game uses these images only in guest mode and falls back to the procedural preset if an image fails to load. No generated image is submitted on-chain by this preview.

Before owner generation goes live, require the existing wallet-bound job, exact plot/type/level/revision checks, private candidate review beside neighbours, geometry validation, moderator approval and hash-addressed publication described in [V1_SPEC](V1_SPEC.md#prompted-building-creation). Do not treat a player's freeform prompt as a change to ownership, parking rules or billboard approval.
