# Owner logos on building signs

## Player experience

1. A plot owner chooses a building and sees its blank sign position in the builder.
2. They choose a PNG, JPEG or WebP logo up to 1 MB. A local preview shows its fit before submission. The actual owner upload remains private while it is reviewed.
3. The owner uses their wallet to propose that exact image and, optionally, a destination link. A moderator sees the processed logo composited on the exact facade and approves or rejects it.
4. Once approved, the street displays the logo in the sign position. Before approval, or when the image cannot load, the game displays the building initials. The building name is separate text.
5. A changed building layout hides the old logo until it is approved for the new placement. An approved image can be reused through the owner screen. The current contract applies a default 72-hour replacement cooldown.

The upload flow, moderation queue, on-chain approval reference, fallback initials and rendered overlay already exist for the current two-space testnet buildings. The playable guest city and [graphics lab](../apps/web/graphics-lab.html) now preview logo placement on 1-, 2- and 3-unit frontages. In the guest design picker, the image stays in the browser session and appears on the chosen building in the street. Guest previews do not create an approved media record. The variable-width plots are not yet live testnet plot types.

## Art contract for variable widths

Keep the facade image free of baked-in logos, business names and ad copy. Every building choice declares one blank, front-facing `logoRect` in its visual manifest. The approved, processed square PNG is overlaid inside that rectangle at render time, preserving aspect ratio and transparency. The name is drawn in its own sign band. A billboard is a separate media surface and approval; small or residential buildings may have no billboard.

| Deed width         | Facade art envelope | Initial square mark target | Sign treatment                                    |
| ------------------ | ------------------: | -------------------------: | ------------------------------------------------- |
| 1 unit / 1 space   |       55 logical px |                 14 × 14 px | Compact badge beside or above a short name        |
| 2 units / 2 spaces |      140 logical px |                 20 × 20 px | Shop fascia with separate name text               |
| 3 units / 3 spaces |      225 logical px |                 24 × 24 px | Wider fascia or entrance sign; billboard optional |

These targets are for the art review. The current generated-facade manifest and moderation tools use the two-unit coordinate system. Before publishing variable-width buildings, update manifest validation, prompt templates, sign overlay placement, media moderation previews and game-size checks together. A logo with a bold symbol or initials will read more clearly at street scale than one that contains small print.

The current guest art reserves a separate billboard only for Diner, Arcade, Market hall, Office campus, Food hall and Craft works at levels 3–4. One-unit designs, level-1 and level-2 buildings, and the other designs have no ad panel. The 2-unit panel is 48 × 20 logical pixels; the 3-unit panel is 72 × 24. The logo is never placed in the billboard. These rectangles are a code-drawn visual proposal; each real owner asset still needs manifest validation and moderator review at game size.

The new illustrated guest sprites keep sign and possible billboard surfaces blank. The local picker and street draw the sample owner mark as a separate overlay. Their visual panels do **not** authorize a billboard or determine an owner media rectangle; real publication requires a versioned per-image manifest and moderator placement review. The [illustrated asset specification](ART_GENERATION_SPEC_V2.md) gives the future prompt base.

The API already converts accepted uploads to a 256 × 256 transparent PNG using contain fitting, strips metadata through re-encoding, hashes the processed bytes and stores them off-chain. The on-chain media reference binds the approved image to the plot and building layout revision; the renderer loads the approved asset only. The operator's moderation decision and image hosting remain trusted parts of the game.
