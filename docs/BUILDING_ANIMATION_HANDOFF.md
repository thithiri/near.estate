# Building animation handoff · variable-width city

Use the current version-2 plot geometry in [`packages/shared/src/variable-media.ts`](../packages/shared/src/variable-media.ts) and the asset rules in [`ART_GENERATION_SPEC_V2.md`](ART_GENERATION_SPEC_V2.md). The older `BUILDING_IMAGE_SPEC.md` describes the original fixed-width city and is not the geometry used by the current street.

## Size and placement

The street uses a 300-logical-pixel reference height. Building images live in the top 190 logical pixels and sit on the sidewalk baseline at **y = 190**. One plot is one deed, and its width determines both its building frontage and its curb capacity:

| Plot    | Logical image canvas | PNG/frame at 4× | Maximum visible facade width | Curb spaces |
| ------- | -------------------: | --------------: | ---------------------------: | ----------: |
| 1 unit  |             85 × 190 |       340 × 760 |                        79 px |           1 |
| 2 units |            170 × 190 |       680 × 760 |                       164 px |           2 |
| 3 units |            255 × 190 |      1020 × 760 |                       249 px |           3 |

The 3-pixel gap on each side belongs to the plot, so adjacent buildings have only a small visual gap. Keep the visible facade centered and at least 85% of its plot width. The facade bottom stays at y = 190 in every frame; transparent padding above a shorter building is intentional. Levels 1, 2, 3 and 4 cap facade height at **70, 100, 130 and 160 logical pixels** respectively. Upgrades add architecture within the same width. A taller level must not grow into a neighboring deed.

Do not stretch a 1-unit image across 2 or 3 units, or use a 3-unit image for a smaller plot. Do not set every image to a common CSS width. Choose art by **plot units + design choice + level**, then draw its full transparent frame at `source width / 4` and `source height / 4`, with its left edge at the plot's x and its top at y = 0. The current Pixi street already does this in [`apps/web/src/guest-frontage.ts`](../apps/web/src/guest-frontage.ts). The five designs for each width are listed in `FRONTAGE_DESIGN_IDS_V2`; one design index means a different design at each width.

## Animation frames

- Start from the final normalized building PNGs in [`apps/web/public/guest-buildings`](../apps/web/public/guest-buildings), or their source strips in [`art/source/guest-building-strips`](../art/source/guest-building-strips). Keep every frame at the exact PNG dimensions in the table, with the same bottom baseline and the same plot-local origin. Animate details such as light, steam, doors, awnings or window activity inside the existing silhouette.
- Keep the facade's outline, roof and entrance stable. Do not move the entire building, scale its width during a loop, or enlarge shadows beyond the three-pixel side margins. A frame must still obey its level's height cap and the 85%-width minimum.
- Leave storefront sign panels and eligible billboard panels blank and in the same place in every frame. The game draws the owner's logo, name and approved ad as separate layers. Do not bake any text, logo or ad into the animation frames. The only current billboard surfaces are the **2-unit Diner and Arcade at levels 3–4**, each **88 × 20 logical pixels**. Other designs have no approved billboard surface yet.
- Export transparent PNG frames or an atlas with frame rectangles that preserve these exact full-canvas dimensions. In Pixi, change the facade texture at the existing **0.25 scale**. Keep the logo/name/ad sprites above the animated facade. Animation timing must not alter parking capacity, collision/selection rectangles, or where the car parks.

Review one 1-unit, one 2-unit and one 3-unit loop side by side with their neighbors at the actual phone street scale before applying the animation to all buildings. The source art was normalized to these widths; reusing a generic width or recropping each frame independently will visibly distort proportions or make the building jump.
