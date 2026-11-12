# near.estate illustrated asset specification · local version 2

This is the base visual grammar for the variable-width guest city and a future owner image prompt. The local game uses 60 illustrated building sprites: fifteen designs at four levels. All fifteen current four-level source strips were newly generated with the built-in image generator. The preceding nine source strips, 60 game sprites and early box-style choice sheet are preserved in [`art/archive/2026-11-12-before-new-building-art`](../art/archive/2026-11-12-before-new-building-art). Six four-color car strips provide all 24 body/color combinations. The current sources are in [`art/source/guest-building-strips`](../art/source/guest-building-strips) and [`art/source/guest-car-strips`](../art/source/guest-car-strips). [`prepare-guest-illustrations.mjs`](../scripts/prepare-guest-illustrations.mjs) trims, fits and hashes the game assets; [`render-guest-building-sheet.mjs`](../scripts/render-guest-building-sheet.mjs) builds the review sheet from those exact sprites.

## Game art direction

**Theme: Harbor Arcade.** A friendly coastal city drawn as crisp front-elevation illustrations. Use deep navy ink contours, warm cream sign surfaces, cyan glazing, sparing highlights and distinct material colors. Keep the city playful without making every facade an awning shop. In the interface, use navy navigation, cream paper panels, amber action buttons and teal wayfinding. UI text uses a rounded system sans with heavier display headings; road and curb information must remain legible on a phone.

One frontage unit is 85 logical pixels and holds one curb space. A building image is bottom anchored at sidewalk y=190. The transparent output canvas is `units × 85 × 190` logical pixels at 4× resolution; the visible facade stays centered inside these width and height limits:

| Plot    | Visible art width | Curb spaces |  Logo mark |
| ------- | ----------------: | ----------: | ---------: |
| 1 unit  |             79 px |           1 | 14 × 14 px |
| 2 units |            164 px |           2 | 20 × 20 px |
| 3 units |            249 px |           3 | 24 × 24 px |

Levels 1–4 cap visible height at **70 / 100 / 130 / 160 logical pixels**. A level adds an architectural tier or feature and retains the silhouette. Each source is trimmed and scaled within its plot width and height cap. Current sources are widened to fill the frontage after fitting within the height cap; Craft Works was regenerated with proportionate garage doors and windows, so it no longer needs a special width limit. Future source art should be drawn close to its target plot ratio. Each image keeps a blank, front-facing storefront sign. The Diner and Arcade reserve rooftop billboard placements at levels 3–4, with the approved ad drawn over the facade. The [placement review](images/near-estate-new-media-placement-review-v1.png) shows those exact shared rectangles on the new art. Other designs need design-specific media surfaces before billboard uploads are offered. The game overlays the owner logo and building name separately; the generated pixels must contain no logo, business name or ad copy. A moderator must inspect exact media rectangles against each final image before owner publication. A blank shape in an image is not by itself an approved media slot.

## Building prompt base

The operator fills the fixed fields. A player may add only a bounded visual idea, such as a roof garden or window trim, that does not change width, level, footprint, safe media areas or gameplay rules. For a future owner request, generate **one building at one level**. The current local source strips used four adjacent levels as an efficient art-production format; owner output should remain individually reviewable.

```text
Use case: stylized-concept.
Asset type: transparent 2D front-elevation building sprite for near.estate, a side-scrolling parking city game.
Create ONE [DESIGN] building on a [1|2|3]-unit frontage at level [1|2|3|4].
Defining silhouette: [FIXED_DESIGN_BRIEF]. Level feature: [FIXED_LEVEL_BRIEF].
Player visual idea: [SANITIZED_IDEA]. Palette: [APPROVED_PALETTE].
Straight-on elevation, centered, full building visible, level bottom edge. Preserve the defining roof, entrance and material cues. Fill most of the [79|164|249] logical-pixel frontage while fitting within [70|100|130|160] logical pixels of height after normalization. Match the Harbor Arcade style: deep navy ink outlines, broad warm color fields, cyan glazing, cream details, restrained highlights. Leave a clear blank storefront sign for a separately rendered owner logo and name. Only if eligible and level 3–4, leave a second, distinct blank billboard surface.
Genuinely transparent background. No sky, ground, sidewalk, road, car, person, cast shadow, text, letters, advertising, logo, watermark, border or UI.
```

| Width | Designs and defining silhouette                                                                                                                                                                                                 | Source                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1     | News kiosk: flat canopy and open counter; Coffee pod: curved roof and round glazing; Townhouse: steep gable and planted stoop; Flower stall: scalloped canopy and flowers; Bike repair: sawtooth workshop roof and service door | Five new four-level strips |
| 2     | Corner shop: left brick corner tower; Diner: rounded enamel body; Glass studio: slanted roof and blue glazing; Bookshop: twin gables and recessed door; Arcade: stepped marquee and glowing bays                                | Five new four-level strips |
| 3     | Market hall: sawtooth roof and central entrance; Garden bistro: planted terrace; Office campus: joined glass volumes; Food hall: three open market bays; Craft works: brick workshop and industrial roof                        | Five new four-level strips |

The version-2 contract stores `design_choice` as a number from 0 to 4; plot width selects the column. This fixed order is shared with the client catalog:

| Choice | 1 unit       | 2 units      | 3 units       |
| -----: | ------------ | ------------ | ------------- |
|      0 | News kiosk   | Corner shop  | Market hall   |
|      1 | Coffee pod   | Diner        | Garden bistro |
|      2 | Townhouse    | Glass studio | Office campus |
|      3 | Flower stall | Bookshop     | Food hall     |
|      4 | Bike repair  | Arcade       | Craft works   |

The initial value follows the guest street's deterministic layout. An owner can choose another entry within the same width without changing plot size or parking capacity. Choosing a design resets the current custom facade and advances the media layout revision; any existing logo or billboard needs review for the new facade before it appears again. The version-2 owner screen offers this choice on the currently deployed testnet city.

### Current source-strip briefs

The fifteen new sources use the same Harbor Arcade prompt base above, with four adjacent straight-on elevations ordered level 1 to 4, common baseline, separate transparent quarters and empty sign surfaces. The design and growth briefs used for the current art are:

| Design        | Distinct source features                                | Level growth                                                    |
| ------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| News kiosk    | Red canopy, open counter and paper racks                | Booth → larger display → enclosed loft → upper room             |
| Coffee pod    | Curved teal enamel roof, round window, espresso counter | Capsule → canopy → upper nook → domed upper room                |
| Townhouse     | Narrow red brick, steep gable, planted stoop            | Single story → upper floor → three stories → dormer             |
| Flower stall  | Coral awning, flowers and glazed greenhouse             | Stall → glazed shop → greenhouse mezzanine → taller greenhouse  |
| Bike repair   | Sawtooth metal roof, garage door, bike tools            | Workshop → clerestory → upper repair floor → rooftop workshop   |
| Corner shop   | Left brick tower, striped awning, green window frames   | Low shop → raised tower → second story → clock tower            |
| Diner         | Rounded enamel and chrome roof, long window, booths     | Low diner → marquee → terrace → rooftop lounge                  |
| Glass studio  | Slanted copper roof, blue glazing, visible work tables  | Studio → clerestory → glass floor → stepped rooftop             |
| Bookshop      | Twin blue gables, book windows, recessed green door     | Low shop → loft → second floor → taller dormered gables         |
| Arcade        | Purple stepped marquee, cyan/amber glowing bays         | Low arcade → raised marquee → play floor → taller stepped roof  |
| Market hall   | Triple sawtooth roof, ochre brick, three market bays    | Low hall → monitors → trading loft → upper windows              |
| Garden bistro | Green pergola, planted terrace, open courtyard          | Dining hall → higher pergola → upper room → greenhouse pavilion |
| Office campus | Offset blue-glass volumes, slanted roofs, breezeway     | Single floor → clerestory → stacked floor → stepped third floor |
| Food hall     | Three vendor bays, copper roof, colored counters        | One floor → clerestory → mezzanine → dining balcony             |
| Craft works   | Terracotta workshop, blue sawtooth roof, garage door    | Workshop → roof monitors → workroom floor → chimney             |

Reject a source with a painted backdrop or cloudy alpha halo. The first Bookshop generation had one and was replaced by a transparent edit before normalization. The review sheet should be checked before accepting new sources because it exposed three misnamed files in this refresh.

## Owner-generated facade format under development

The separate version-2 manifest records `frontageUnits`, `designChoice`, economic `buildingType`, level, immutable sprite and thumbnail hashes, alpha bounds, and the exact shared sign and eligible billboard rectangles. The render profile is version 2, so a version-1 `140 × 160` facade cannot be mistaken for a variable-width building. A generated PNG is cropped to its visible pixels and fitted within the selected level's height and width. A source that would occupy less than 85% of its plot width is rejected. Accepted art is then widened to the same three-pixel side margins as the illustrated buildings and bottom-anchored on a transparent `units × 85 × 190` logical canvas at 4× resolution. Widening can alter proportions, so the moderator checks the final image at game size. Transparent background and image size are checked before normalization; the final manifest is canonically hashed.

The deterministic prompt builder uses the fixed design order above, the plot's exact width and level, the current Harbor Arcade style and a bounded owner idea. It names the exact sign and eligible billboard rectangles but still requires a moderator to inspect the final image and media overlay at game size. The API can serve a version-2 manifest and image from an approved job, the moderator preview can place approved media over that image, and the version-gated street can render it with a curated fallback. Those read paths have fixture-backed tests. A version-2 job retains its prompt snapshot through SQLite restart, checks width and design during selection and reconciliation, and can reach an exact moderator preview and approval. The owner editor can restore an existing job, inspect its candidates at the plot width and submit the chosen image through the shared proposal action; a changed design disables submission. Owner requests and image processing pass through the existing budgeted queue in local fake-provider tests. Paid provider calls remain deferred, and a named-wallet version-2 journey is still required.

For the built-in four-level strips, keep each design in four equal-width columns, ordered level 1 to 4, with bottom edges aligned and generous transparent gaps. The normalization step cuts those columns, trims alpha and fits each level to its cap. The source art should be reviewed for missing transparency, text, duplicate signs and silhouette drift before it enters the game.

## Car prompt base

```text
Use case: stylized-concept.
Asset type: transparent 2D side-view car sprite for near.estate.
Create ONE [CAR_BODY] in [PALETTE], facing right. Entire vehicle visible. Keep the body silhouette distinct from other car types at 64 × 32 logical pixels. Match Harbor Arcade: deep navy outline, broad clean color fields, cream wheel centers, cyan glass and restrained highlights. Center with transparent padding.
No perspective, driver, road, ground, shadow, text, brand mark, border, UI or watermark.
```

The current car library has six distinct silhouettes: Hatchback, Sedan, Sports Coupe, SUV, Pickup and Microvan. Each comes in Red, Blue, Yellow and Green. The six source strips place those colors in that order in four equal columns; normalization cuts them into 24 transparent 256 × 128 PNGs displayed at 64 × 32 logical pixels. Each source and output is hashed in the local catalog. Procedural art remains a load-failure fallback.

## Media and parking surface rules

- The building sprite is architecture only. Logo and name stay separate so a user can change them without regenerating the building. A proposed billboard is a separate approved media slot and cannot replace the logo sign. The guest preview shows blank ad surfaces only; a version-2 owner can upload a logo or eligible billboard for moderator approval when that contract version is active.
- Rule information is painted **inside each vacant curb space**, along the rear edge: Free, Meter, Color or No P. No pole marks an ordinary parking space. A parked car covers that marking; the plot panel still shows the rule. Street-name signs remain at crossings and road ends.
- Driving left places the car in the upper road lane and mirrors its sprite; driving right places it in the lower lane. The lower-left and lower-right quarters of the street are holdable drive zones with small visible cues. Park, Collect, Ticket and Cross Street remain explicit buttons above the scene.
- Normalize, hash and review each accepted image at actual game size. Reject opaque backgrounds, text baked into art, overflow, overlapping media regions or a facade whose level is visually misleading. The current local images are previews, not on-chain owner assets. Future generated owner art must pass the existing wallet-bound, moderator-approved publication flow.
