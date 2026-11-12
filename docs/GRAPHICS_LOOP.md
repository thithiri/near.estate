# Street graphics and variable-plot iteration plan

This is the local art pass requested on 12 November 2026. Keep the guest preview fast to change, and keep live testnet geometry and parking authority tied to the deployed contract until a coordinated migration is ready. No paid image calls or hosted build are part of this loop.

**Current checkpoint:** G1 and G2 are in the playable guest city. Each street side has ten player plots in the exact 6 / 3 / 1 width mix, with one usable curb space per unit. G3 now has five code-drawn choices per width, an in-game size-filtered picker and a local logo preview on the actual street. The [graphics lab](../apps/web/graphics-lab.html) remains a fast comparison sheet. Open `http://127.0.0.1:5173/` for the game or `/graphics-lab.html` for the sheet after starting the local web dev server. A local `?preview-plot=plot-main-n-7` URL starts beside a chosen guest plot for visual review.

**Current art checkpoint:** All fifteen width-specific choices have levels 1–4, with 70 / 100 / 130 / 160 logical-pixel height limits. The illustrated Diner and Arcade have reviewed billboard panels at levels 3–4; other designs need art changes before billboards can be placed without covering windows. The owner logo remains on the storefront sign. G4 is specified in [the testnet transition plan](VARIABLE_CITY_TESTNET_PLAN.md); the live testnet city still uses the existing two-space deeds.

**Illustrated pass:** The playable guest picker, street and graphics lab now load 60 transparent building sprites: nine newly generated four-level strips plus six matching earlier illustrated sets. All six car bodies have red, blue, yellow and green sprites, for 24 looks. Ordinary curb rules are painted into vacant parking spaces instead of being posted on poles. The [asset and prompt specification](ART_GENERATION_SPEC_V2.md) records the source map, image constraints and future owner prompt fields. The game continues to fall back to code-drawn art if an illustration fails to load.

## Shared scale

- One frontage unit is **85 logical pixels** and fits **one 64-pixel curb stall** with room for paint and a curb sign. This is a screen-space rule, not a real-world metre.
- Player parcel sizes are 1 unit (85 px, 1 curb space), 2 units (170 px, 2 spaces), and 3 units (255 px, 3 spaces). Guest building art stays inside a centered frontage envelope with 3 px clear on each side: 79 / 164 / 249 px visible width. Height remains capped separately at each guest level. Live testnet geometry and paid building limits have not changed.
- For an exact **60% / 30% / 10%** size mix, each street side will have 10 player plots: six 2-unit, three 1-unit, one 3-unit. That is 18 player frontage units and 18 curb spaces per side, or 100 player plots and 180 player curb spaces across five streets. NPC sites occupy separate civic frontage and do not count in this percentage. The later city-wide earning capacity would be 180 curb plus 96 NPC tower spaces = 276 if tower capacity stays as it is.
- The 1/2/3-unit number describes one deed and its curb allocation. A 3-unit building belongs to one 3-unit deed; it does not consume a neighbour's property. A future multi-deed merge is a separate feature.

## Fast local loop

1. Run the guest web app locally with image generation off. Change code-native street graphics, let Vite reload, and capture a desktop and landscape-phone view from the actual canvas.
2. Check every change at the 300-logical-pixel reference height: car and stall remain readable, sign text is legible, crossing is visibly separate from parking, and controls remain usable. Keep one before/after capture in `docs/images` for each accepted pass.
3. Run the focused web type check and street browser journey. Stop optional checks when the visual and interaction risk is covered. Record the chosen look and remaining concerns in `docs/DECISIONS.md`.

For the version-2 street and approved-media path, run `npm run test:browser:city` from the repository root. It starts a temporary local web server with the testnet contract ID from `deployments/testnet.json`, replaces RPC and image responses with checked local fixtures, runs the two playable-canvas checks, and stops the server. It makes no wallet signature or testnet change. Ordinary `npm run test:browser` still starts the guest-only server.

## Numbered tasks

### G1 — Street surface and wayfinding

1. Draw a tiled pavement, curb edge and drainage detail without obscuring building entrances or rule signs.
2. Draw parking stalls as curb spaces with clear side markings and one readable space per unit. Preserve the current two-space live geometry during this art pass.
3. Replace the floating yellow intersection label with a green, white-lettered street sign on a post, a directional arrow and a visible junction gap. Make end connections match.
4. Draw a zebra crossing, stop line and curb ramps at intersections. Keep crossing paint out of parking slots.
5. Capture the actual street at desktop and landscape-phone sizes; check sign taps, parking taps, driving and cross-side controls.

### G2 — Mixed parcel frontage in the guest city

6. Add a versioned size field to the visual seed and a layout function that sums unit widths instead of multiplying by a fixed pitch. Place intersections, NPC frontage, cars, map anchors and camera targets from the same layout.
7. Seed 10 player parcels per side per street with the exact 6 / 3 / 1 mix. Use a varied but deterministic order; keep street sides aligned at junctions. Show deed boundaries and 1/2/3-space occupancy in the guest street and plot details.
8. Extend the in-memory parking model to 1–3 spaces per guest parcel and test selection, expiry, full-curb behavior and driving across variable frontages.

### G3 — Size-specific building choices

9. Prototype at least three visibly different building silhouettes at each frontage size in a local choice sheet: 1-unit kiosks/narrow homes, 2-unit storefronts and studios, 3-unit halls/courtyard buildings. Keep NPC cinema, garage and parking towers as civic art.
10. Set per-size transparent sprite canvases and logo/billboard safe areas. Review each at game scale beside a narrow and wide neighbour; avoid stretching the existing 2-unit facades.
11. Add a size filter and comparison to the guest builder. A player sees only choices that fit their deed; the type, shape, level and size labels must match the street result.

Custom signs use the current separate-media model: the owner uploads a square logo, the service normalizes and hashes it, and a moderator approves that exact image for the building layout. The renderer places it in a blank, manifest-defined logo rectangle and draws the owner-entered name in a separate sign band. Initial visual targets are a 14 × 14 logical badge for 1 unit, a 20 × 20 sign space for 2 units, and a 24 × 24 mark on a wider sign for 3 units. These are art targets, not current contract limits. An optional billboard is a separate approved media slot on a building that visibly has room for it; small buildings may have none. Changing size or facade revision requires media placement to be reviewed again. Generated art must leave the sign blank rather than baking a logo or lettering into the pixels.

### G4 — Authoritative city migration, after the graphic grammar is accepted

12. Update shared seed, plot IDs and slot schemas, contract storage and economic quotes for 1–3-unit parcels. Decide and document price per unit and storage reserve before minting. Keep NPC tower capacity independent.
13. Rehearse a versioned storage migration that preserves account/car balances and maps existing owned 2-unit deeds to reviewed 2-unit destinations. The exact new ratio cannot keep all eight old 2-unit deed IDs at the same width on each side. Freeze purchases and settle sessions before the one-time move; see [the transition plan](VARIABLE_CITY_TESTNET_PLAN.md).
14. Update the live client, API/indexer and tests together; deploy a verified testnet migration and run two-account parking, ticket and expiry journeys on all three parcel sizes.

G1–G3 are visual and guest-game work. The live city continues to use its current two-space deeds until G4 passes its migration and shared testnet checks.
