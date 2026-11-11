# Building image specification · draft 1

This is the art direction for illustrated player buildings. The first five images are operator-created guest previews, one level-2 facade per type. They demonstrate a possible look in the running street; they are not published owner appearances. The existing curated library and on-chain approval flow remain the live path. Future owner generation can reuse this specification after provider, moderation and budget checks are enabled.

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
| Homes      | Offset paired townhouses              | Narrow stepped terrace           | Warm plaster, balconies, planters       |

The two variants must differ in massing, entrance position and roof shape. Level upgrades should add a type-specific feature instead of uniformly stretching the source image. The initial illustrated guest samples cover only one direction at level 2; the remaining variant and level images need separate artwork.

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

The backend prompt builder uses profile v2 of this art direction. Its image normalizer now reserves five logical pixels on each side. All five draft sources pass the actual level-2 geometry/alpha validator. Automatic logo and billboard rectangles are only geometric suggestions: they can land over windows or decoration. The moderator's candidate view outlines them, and a human must reject poor placements. Reliable editable placement, and a rule that suppresses a billboard when no suitable blank area exists, remain necessary before owner-generated art is offered.

## First illustrated guest set

The raw images live in [`art/source/illustrated`](../art/source/illustrated). [`prepare-illustrated-facades.mjs`](../scripts/prepare-illustrated-facades.mjs) normalizes them into [`apps/web/public/illustrated`](../apps/web/public/illustrated) and writes the hash catalog to [`apps/web/src/illustrated-catalog.json`](../apps/web/src/illustrated-catalog.json). The five demonstration plots are level-2 examples: Main Street retail and cafe, Market Street restaurant, River Street office, and Central Avenue homes. The game uses these images only in guest mode and falls back to the procedural preset if an image fails to load. No generated image is submitted on-chain by this preview.

Before owner generation goes live, require the existing wallet-bound job, exact plot/type/level/revision checks, private candidate review beside neighbours, geometry validation, moderator approval and hash-addressed publication described in [V1_SPEC](V1_SPEC.md#prompted-building-creation). Do not treat a player's freeform prompt as a change to ownership, parking rules or billboard approval.
