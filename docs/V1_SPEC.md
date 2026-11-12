# near.estate V1 Game Specification and Implementation Plan

near.estate V1 is a playable NEAR testnet city where players drive, park for coins, improve cars, buy plots, and create distinctive buildings from constrained prompts. Parking towers, repair garages, cinemas, and other civic activities are game-operated destinations. Player buildings are Retail, Cafe, Restaurant, Office, and Homes.

This is the proposed implementation baseline dated 10 November 2026. The ownership model and visual direction follow the agreed concept; prices, durations, quotas, and capacity below are initial playtest settings. The implementation tasks are planned work, not completed features.

# Product scope

The main loop is **drive and explore → park → collect coins → improve cars or buildings → customize a place → return to the city**. The first successful parking action should be possible within two minutes after registration, and activities remain available while parking earns.

**Included in V1:** desktop and mobile browser play; a shared five-road city; two street sides; intersections and a map; on-chain cars, plots, coins, rules and parking; NPC parking towers; car repair and upgrades; five player building types with four levels; preset and prompt-generated facades; owner logos and one billboard; moderation; estimated advertiser statistics; a simple solo practice race; a curated cinema; a free burger-stop interaction and optional cosmetic purchase.

**Deferred:** real-money coins, USDC, cash-out, paid advertising settlement, asset resale or transfers, multiplayer racing, authoritative race leaderboards or coin prizes, player-operated business simulations, generated interiors, animated generated buildings, 3D, Telegram packaging, gasless relaying, Harberger tax, DAOs and agent storefronts. A player choosing a restaurant appearance does not become an NPC service operator.

A player can own up to three cars, with one earning parking session at a time. Other unparked cars remain available for driving or practice races. With the only car parked, the player can browse the street and map and visit free activities; collection is always available.

# World and ownership

| Element | V1 definition |
| --- | --- |
| Roads | Main Street, Market Street, River Street, Central Avenue, Harbor Avenue |
| Player property | Eight plots on each side of each road: 80 purchasable plots |
| Player curb parking | Two spaces per plot: 160 unique spaces |
| NPC earning parking | Three game-owned towers with 32 spaces each: 96 additional spaces |
| Total earning capacity | 256 physical spaces; no duplicated earning spaces in parallel city instances |
| Other NPC destinations | One repair garage, one cinema, one Near & Far Burgers stop, one practice-course entrance |
| Private car storage | Unparked cars are stored without occupying a city space and earn nothing |

NPC sites occupy separately seeded frontages and cannot be bought or selected as player building types. Tower capacity is fixed by the game configuration, not inferred from its image. Repair garages provide repair/upgrade menus; they do not add earning spaces.

Street data contains ordered frontage entries for player plots, NPC sites, intersections and open areas. A connection records destination road, entry position, side and facing direction; end connections are explicit. Seed validation rejects overlapping frontages and broken links. Start with North-side rendering and a cross-street control for South; the map can jump between roads.

Plot ownership is an internal on-chain registry. V1 does not claim NFT marketplace compatibility. Plot prices start at 1 testnet NEAR, with corners at 2×, plus the quoted storage reserve. NPC parcels are never offered for sale. Native NEAR funds gas, storage and plot purchases; game coins are a separate balance.

Driving position is a client presentation mechanic. The contract enforces parking ownership and capacity, not travel distance or proof that an advertisement was seen.

# Parking economy and rules

All monetary game amounts use integer subunits: 1 displayed coin equals 1,000,000 internal units. Multipliers use basis points. Prices and rewards are bounded, checked integers; JSON exposes large values as decimal strings. Configuration changes are versioned, with each parking session retaining its original economic terms.

| Setting | Proposed V1 default |
| --- | --- |
| Registration | Once per account; 100 coins and a full-durability tier-1 hatchback |
| Car colours | Red, Blue, Yellow, Green |
| Car body types | Hatchback, Sedan, Sports Coupe, SUV, Pickup, Microvan |
| Car ownership and earning limit | Three owned; one earning session per account |
| Legal curb earnings | 60 coins/hour × tier multiplier |
| Tier multipliers | 1.0 / 1.5 / 2.2 |
| Illegal multiplier | 1.5 |
| NPC tower earnings | 50% of the normal legal rate; no additional meter charge |
| Earn cap and space expiry | Earn for 30 minutes; release eligibility after a further 2 minutes |
| Durability | Maximum 100; parking requires and consumes 2 |
| Repair | 1 coin per restored point; owner chooses an amount up to full |
| Additional tier-1 car | 150 coins; body type and colour are chosen at purchase |
| Car upgrades | 200 coins for tier 2; 500 for tier 3 |
| Building upgrades | 200 / 600 / 1,500 coins for levels 2 / 3 / 4 |
| Meter rate | Owner chooses 0–30 coins/hour; fee capped at 50% of gross reward |
| Rule delay | 5 minutes |
| Owner ticket cooldown | 5 minutes per plot |
| Ticket allocation | 70% recipient; remaining 30% forfeited |
| Inspector | 25% success; eligible after 5 minutes; one attempt per session |
| Inspector patrol limit | At most 8 attempts per five-minute interval globally |
| Logo and billboard replacement cooldown | 72 hours after an approved replacement |
| Custom facade publication cooldown | 24 hours after approval; one exemption per paid level upgrade |
| Starter emergency repair | Restore to the configured parking durability cost once per rolling 24 hours under the conditions below |

A five-minute tier-1 free curb park earns 5 coins gross, leaving 3 after replacing durability. A full 30-minute free park earns 30 gross, or 28 after repair. A full NPC tower park earns 15 gross, or 13 after repair. The colour and body type are cosmetic except that colour determines access to ColorOnly rules. Tier changes earnings and practice-race performance.

Driving, exploring, cinema visits and the basic burger interaction are free and consume no durability. A burger decal costs 30 coins once per account; cosmetics do not improve income. Building type, level, artwork and impression counts do not multiply parking income. Owners receive meter deductions or ticket proceeds. There is no direct coin transfer method, although cooperating accounts can move value indirectly through owner payouts.

**Parking.** Only a car owner may park it. First settle any expired session belonging to that account and any expired session occupying the requested space, paying their original recipients. Then validate car availability, account earning limit, space ID, occupancy and durability. Reject earning parking on a plot owned by that same account. Store a unique session ID, car, driver, space, start, earn-until, expire-at, legality, exact earning terms, meter rate, payout recipient and applicable economic version. NPC spaces are always legal. Curbs use Free, Meter, ColorOnly or NoParking.

**Settlement.** Let t be elapsed whole seconds, clamped from zero to the snapshotted earn cap. Gross coin subunits equal floor(base hourly subunits × tier basis points × legality basis points × facility basis points × t / (3,600 × 10,000³)). Legal and ordinary-curb factors are 10,000; illegal is 15,000 and NPC facility is 5,000. Keep those factors snapshotted and apply only the final floor. A legal Meter fee is min(floor(meter hourly subunits × t / 3,600), floor(gross / 2)); the driver receives gross minus fee. Ticket recipient payout is floor(gross × 7,000 / 10,000), with the exact remainder forfeited. Every multiplication is checked and configuration is bounded. Fees on an unowned plot, if ever introduced, go to the treasury; V1 unowned plots are Free. A purchase during an existing park does not change that session's recipient or terms.

**Collection and expiry.** Only the car owner may collect a nonexpired session. Collection uses the expected session ID, pays and clears it atomically. At or after expire-at, anyone may call settle_expired; reusing that space performs the same settlement before parking the next car. A worker also clears expired sessions. The previous driver retains capped earnings and their car returns to private storage. Chain state does not change merely because a timer reaches zero. Collecting, ticketing and expiring the same session can pay at most once.

**Tickets.** Only the current plot owner calls the player ticket method, with the expected session ID. The session must have been illegal when parked, must still be present, and must not be expired. The owner receives 70% of accrued gross; the remainder is forfeited and the car is released. Self-ticketing is forbidden. Ticketing within the two-minute post-cap grace is permitted. The recorded cooldown deadline is not shortened by a later config change.

**Rules.** Legality and meter terms are fixed at park time. Views and writes use the same effective-rule calculation. Before replacing a pending rule, promote one that has already matured; then schedule the new rule from the current time. Expired sessions remain settleable while purchases or new parking are administratively paused.

**Inspector.** The inspector cannot call the owner's ticket method. Inspection requires the expected session ID and a present, illegal, nonexpired session at least five minutes old. Its restricted method uses env::random_seed() for the success roll and records every valid attempt, including failures, against the session and the fixed five-minute global patrol window. Success settles to the treasury using the ticket split. It is an operator-run NPC with contract-enforced limits; random success does not prevent the operator from choosing targets or withholding patrols.

**Recovery.** Emergency repair is allowed only when all owned cars have less durability than parking requires, the balance cannot pay for the cheapest repair that would make any car parkable, no car is parked, and the rolling cooldown has elapsed. It tops up the original starter car to the configured parking cost without minting coins. At the defaults, a car at zero durability needs two coins to park; a car at one durability needs one. Cars must be unparked for normal repair or upgrades.

These settings intentionally replace the original 24-hour cap, 10-coin hourly base rate and 5-durability parking cost. Short sessions and explicit expiry make scarce parking usable in a small city. Per-account limits are not proof of one human; V1 remains a nonredeemable testnet economy.

# Player buildings and art direction

Players choose **type → architectural variant or prompt → palette → name and logo → approved appearance**. A level increases the allowed envelope and decoration budget; it does not require another identical floor.

| Type | Two curated architectural directions | Upgrade character |
| --- | --- | --- |
| Retail | Asymmetric general store; sawtooth market hall | Displays, roof detail, facade advertising |
| Cafe | Glasshouse; timber kiosk with pergola | Garden, seating, canopy or conservatory |
| Restaurant | Low retro diner; courtyard bistro | Terrace, dining detail, distinctive signage |
| Office | Slender glass block; cantilevered concrete studio | Floors, glazing, planted terraces |
| Homes | Stepped terrace homes; narrow townhouse | Balconies, terraces, roof details |

The full preset library contains 5 types × 2 variants × 4 levels = 40 approved facades, with deterministic palette masks for coral, sky blue, mint and yellow accents. V1 also has 24 car body/colour combinations. Silhouette, roof shape, material and proportions distinguish buildings; they do not all share arches, awnings or circular signs.

A plot purchase includes a level-1 preset. Choosing among presets, colours and variants is free. Switching the player type costs 100 coins, preserves the paid level, activates that type's preset, and invalidates incompatible proposals. Upgrades immediately activate the new level's selected preset; a custom upgrade can then use the previous approved image as an identity reference. A low building can stay low at a high level. No downgrade/refund flow is included.

The 24-hour timer applies to publishing custom facades. Preset and preset-palette changes can apply immediately, but they and type changes never reset that timer. Each paid level upgrade grants one custom-publication exemption at that new level. Logo and billboard content have independent 72-hour replacement timers that survive type changes, level upgrades and appearance revisions; a new link counts as new content. First publication is immediate, removal is always allowed, and removal does not erase the last replacement time. Revalidating unchanged content for a new building layout neither resets nor bypasses its replacement timer.

| Building level | Maximum logical height | Maximum source height at 4× |
| --- | ---: | ---: |
| 1 | 70 px | 280 px |
| 2 | 100 px | 400 px |
| 3 | 130 px | 520 px |
| 4 | 160 px | 640 px |

Each plot has a 170px pitch. A facade fits within a centered 140px-wide envelope, leaving 15px on each side. All visible pixels, projections and rooftop attachments stay inside that envelope and the level's height cap. The source sprite is a transparent 560 × 640px PNG, corresponding to a 140 × 160 logical canvas; shorter buildings are padded above. Its bottom-center anchor is (70,160), positioned at (plot origin + 85,190) in the 300px reference scene.

The street keeps the established sidewalk at y190–206, curb lane at y206–246 and driving lane at y246–290. Car sprites fit within 64 × 32 logical pixels. Ads, logos and sign text are separate rendered elements. V1 permits one owner logo/name surface and one optional billboard surface. Validated axis-aligned placement rectangles remain inside the level envelope. The version-2 two-unit Diner and Arcade billboard uses an 88 × 20 logical-pixel image area, matched to the illustrated sign; review any future ad surface at game scale before enabling upload.

The facade is static raster art in strict front elevation. It contains no street, cars, functional buttons, active code, or authoritative gameplay geometry. Generated decorative lettering or advertisements are rejected: the renderer adds approved text and ad artwork separately.

Selecting a plot on the live street shows a logo or billboard destination link only when that media is currently approved for the building's layout. The player chooses whether to open the HTTPS destination in a new tab; loading the street never opens it automatically.

# Prompted building creation

The owner enters a description of at most 800 characters, such as “A mint greenhouse cafe with a tall glass peak, timber entrance and lots of plants.” They can select architectural hints, materials and palette. Level, plot dimensions, camera, asset format and service permissions are supplied by the game.

1. Verify the wallet-backed API session and current finalized ownership, type, level and appearance revision.
2. Build the generation request from the versioned style guide, render profile, selected preset or previous approved appearance, palette and user description.
3. Reserve generation quota and operator budget; queue a durable job that aims to deliver three acceptable candidates.
4. Generate raster art using a backend-only provider adapter, then decode, normalize, inspect alpha bounds and generate a thumbnail.
5. Validate image limits, dimensions, height, anchor, clear ad surfaces, content and architectural quality. A model's promise that an image fits is not validation.
6. Show candidate previews privately and on a real street beside neighbouring buildings. The owner chooses one; selecting none leaves the existing building untouched.
7. The owner submits the exact chosen image/manifest revision as a pending on-chain appearance proposal.
8. The moderator reviews the final composited preview. Approval compares the complete pending revision, ownership, type and paid level, then activates it on-chain.
9. The client loads the approved immutable asset by hash. The previous valid appearance or a preset remains visible through queue delays, failures or rejection.

Jobs are bound to account, plot, type, level and appearance revision. Recheck that tuple before spending, selection, submission and approval. A type change, upgrade or newer appearance makes stale jobs ineligible to publish. A parking-rule edit does not invalidate artwork. Superseded results may remain in private history, but cannot replace the current building.

The provider adapter is an explicit exception to self-hosting: the game API, queue, moderation, assets and database run on the VPS; image inference may use a paid external API. Development uses a deterministic mock adapter. Select and pin an accessible model during the technical spike rather than relying on a floating latest alias. OpenAI supports image generation, edits and transparent raster outputs, but masks are guidance and are not exact geometry enforcement. [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation)

Generate at a provider-supported size and normalize to the game sprite canvas; do not assume the provider accepts the final 560 × 640 dimensions. Custom recolouring is a new generation/edit request unless validated material masks exist. Preset recolouring uses authored masks.

**Initial generation limits:** three candidates per batch; at most two batches per account and one batch per plot per UTC day; one active job per account; two provider calls concurrently; maximum four paid attempts per batch including retries; 60 paid image calls per UTC day globally. Beta access to generation is invite-controlled. Reserve the maximum estimated batch cost before enqueueing. A separate operator-set currency budget is required before real inference is enabled. Never charge game coins for an AI request in V1.

Provider errors release unused reservations, not money already spent. Timeouts are reconciled where the provider permits; do not blindly resend an uncertain request. Finite retries and the global budget bound duplicate-charge risk. A batch that cannot produce three validated choices within its attempt limit reports a partial or failed result; it never fabricates missing candidates. Candidate previews expire after seven days if unselected. Published asset history is retained while referenced.

An immutable manifest records schema and render-profile versions, type, level, sprite and thumbnail hashes, logical dimensions, bottom anchor, alpha bounds, and logo/billboard placements. A documented canonical serialization yields the manifest hash. The chain stores the approved manifest hash and revision; prompts, API responses, moderation notes and cost accounting stay off-chain. All served locations are derived from hashes, not arbitrary client-supplied URLs.

Logo and ad approval includes the asset hash, building revision and outbound HTTPS link. A changed link needs new approval. Revocation changes eligibility rather than overwriting a file; clients stop displaying the revoked content and use the preset or initials fallback. All names are bounded text, colours are validated values, and published media is decoded raster content.

# Client screens and NPC activities

| Screen | Required interactions |
| --- | --- |
| Street | Drive or browse, switch active car, inspect a rule, park, collect, ticket, enter a destination |
| Map | Road graph, current location, own plots, earning car, tower availability and jumps |
| Cars | Three-car collection, body/colour, durability, repair, tier upgrades and cosmetics |
| My plots | Ownership, income, active/pending rules, level, presets and building studio |
| Building studio | Prompt controls, job status, three candidates, neighbour preview, publish/rejection history |
| NPC tower | Floor/space list, legal rate, occupancy, park/collect and expiry information |
| NPC garage | The existing repair, car purchase and upgrade controls |
| Cinema | Curated original or properly licensed short media; playback is off-chain and gives no coins |
| Near & Far Burgers | Free short interaction; optional 30-coin burger decal |
| Practice course | One local timed driving course, checkpoints and personal best; no coin prizes or public ranked rewards |
| Advertiser statistics | Estimated visible impressions, time in view, parks, tickets and data freshness |

Car tiers may increase practice-course top speed and acceleration through a separate bounded configuration; body types do not create performance advantages. The phase-0 playtest fixes those movement values. Race times are local and unverified in V1.

Guest mode supports driving a demo car and exploring mock state. It cannot mutate shared ownership, parking or rewards. Wallet-backed play has explicit pending, confirmed, failed and stale-state states. Reconcile transaction status before retrying a purchase; account switching clears pending identity-specific UI. A failed parking attempt never leaves a phantom parked car.

Impressions count approved ad surfaces, not every decorative facade. Require the full ad surface on-screen for one continuous second while the tab is visible. Flush batches every ten seconds; dedupe retries by event ID, count at most one impression per session/plot/minute, and aggregate capped visibility duration separately. Use server-issued anonymous sessions, bounded batches and rate limits. Metrics are estimated client-reported exposure; they are not billing-grade proof and never mint coins.

# Screen layout and orientation

Visual references: [Phone layouts](images/near-estate-phone-layout-v1.png) and [Computer layouts](images/near-estate-computer-layout-v1.png). These are layout concepts; implementation must satisfy the interaction and sizing rules below.

Current browser captures: [compact landscape street](mobile-landscape.jpg), [portrait arrival with bottom navigation](mobile-portrait-bottom-nav.png), [portrait menu](mobile-menu.jpg), and [desktop street](desktop-street.jpg). These show the playable preview rather than the final art direction. The updated portrait capture is from a 320 × 568 CSS-pixel Chrome viewport, not a physical phone.

**Phone driving and racing use landscape. Menus and the building studio support portrait and landscape. Desktop uses a responsive wide layout.** Portrait arrival shows a rotation prompt with working Map, Cars and My Plots links. A five-destination bottom navigation stays visible while portrait pages scroll; the landscape street keeps its existing driving controls. Login, wallet callbacks, registration, map browsing, car management and building prompts never require rotation to finish. Rotation or window resizing preserves the selected car, prompt draft, generation job, candidate choice and pending transaction.

| Surface | Layout |
| --- | --- |
| Phone street | Compact top HUD; road-corner drive zones; explicit floating context actions |
| Phone portrait arrival | Rotate-to-drive message with access to menus and account status |
| Phone building studio | One column and one step at a time: Describe, Choose, Preview |
| Desktop street | Top navigation, wide scene, optional contextual right panel, keyboard hint bar |
| Desktop building studio | Prompt/settings column; three candidates across the workspace; neighbourhood preview below |
| Narrow desktop window | Reflow menus and editor; offer an expand-window message if the driving scene becomes unusable |

Phone HUD shows the active car and coins on the left, street name centrally where space permits, and Map, Cars and Menu on the right. Tapping the lower-left or lower-right quarter of the street nudges the car in that direction; holding drives continuously. Each zone has a small visible cue. Park, Collect, Ticket and Cross Street stay as explicit floating actions above the road, so a drive gesture cannot trigger them. Minimum touch targets are 44 CSS pixels. The owner Ticket action appears only after explicitly selecting an illegal parked car and is separate from the driver's context action. The parking lane and selected stall remain unobstructed.

Respect safe areas, browser chrome and the on-screen keyboard. The target phone references are 844 × 390 landscape and 390 × 844 portrait CSS pixels, with additional checks at 667 × 375 and 320 × 568. Compact HUD labels on smaller landscape screens rather than shrinking touch targets. If the available scene becomes too short, show an expand/fullscreen suggestion with usable menu access. Do not assume forced browser orientation is available; the layout must work with a rotation prompt alone.

In the phone studio, Describe contains type, prompt and palette controls. Choose shows one large candidate with three selectable thumbnails and explicit previous/next controls. Preview shows the selected building beside real neighbours and its curb spaces. Submission says Submit for Review and retains the existing building while approval is pending. Keep text fields and the primary action reachable when the keyboard is open. Support this same step flow in landscape without forcing another rotation.

Desktop uses Arrow keys or A/D for driving, Space for the context action when a text field is not focused, and clickable equivalents. The right plot panel is dismissible; opening it resizes the scene and recenters the selected car/stall instead of covering them. Candidate comparison uses three columns when space permits and reflows to a single large candidate at narrower widths. The reference desktop viewports are 1366 × 768 and 1440 × 900 CSS pixels.

The world keeps a 300-logical-pixel reference height and uniform scaling. Calculate visible world width from the actual scene rectangle after HUD, controls, safe areas and panels; never stretch sprites to match a device. Keep the player's car and nearby target stall visible during camera movement, orientation changes and panel opening. Prefer a 40% horizontal car anchor while driving right and 60% while driving left, with a smooth transition.

Orientation acceptance includes portrait wallet returns, rotation while signing or generating, portrait text entry, notch-safe controls, two-thumb input, desktop panel resizing, browser zoom, keyboard focus and all four building height limits without obscuring the curb.

# Architecture and interfaces

Use one Rust near-sdk contract, Vite + TypeScript + PixiJS for the client, and a Node + TypeScript Hono API with SQLite. Run Caddy, API, worker and static web assets on a single VPS through Docker Compose. Use a persistent SQLite job table with leases, WAL and bounded retries; no separate queue service is necessary for V1.

| Area | Responsibility |
| --- | --- |
| contracts/estate | Config, accounts, coins, car and plot registries, NPC space capacity, sessions, settlement, rules, building levels, appearance approvals |
| apps/web | Scene rendering, movement, menus, wallet client, state reconciliation, studio previews and visibility measurement |
| services/api | Wallet authentication, generation jobs, uploads, moderator UI, asset delivery and stats |
| services/worker | Durable image jobs, finalized event indexing, expiry sweeps and inspector patrol |
| packages/shared | Generated or checked interface types, schemas and event definitions |
| assets | Curated facades, car sprites, masks, service buildings and render profiles |
| infra | Compose, Caddy, volumes, health checks, backup and restore scripts |
| docs | GAME_RULES, API, ART_SPEC, DECISIONS, ASSET_PIPELINE and OPERATIONS |

The contract is authoritative for ownership, coin changes, parking, capacity, paid levels and approval status under admin-configurable rules. Artwork quality decisions, media hosting, generation, impressions and NPC patrol operation remain trusted services. The operator's upgrade authority and key roles are documented. Full-access deployment keys are kept out of the running API.

Core records include AccountState, Car, PlayerPlot, NPCSite, ParkingSession, BuildingState, PendingAppearance, VersionedConfig and immutable AssetManifest. ParkingSpaceId distinguishes a two-slot player curb from an indexed NPC tower space. ServiceRole is explicit and separate from player BuildingType. Authorize writes with the immediate caller's account and checked role/ownership.

| Contract method group | Calls and access |
| --- | --- |
| Registration and storage | register_player with wallet-funded prepaid storage; one starter grant |
| Gameplay | park, collect, settle_expired, ticket, inspect; explicit owner/permissionless/inspector checks |
| Cars | buy_car, repair, upgrade_car, emergency_repair, buy_cosmetic |
| Plots | buy_plot, set_rule, choose_preset, change_building_type, upgrade_building |
| Appearance | propose_appearance, approve_appearance, reject_appearance, revoke_appearance; owner versus moderator roles |
| Administration | Seed streets/sites/plots, bounded config updates, role rotation, pause new economic actions |
| Views | Paginated streets, plots, NPC spaces, cars, sessions, balances, storage quotes, appearance and effective-rule status |

All mutating targets that can be reused, including a parking slot, carry an expected session or revision guard. The one-contract design uses internal lookups and custom versioned NEP-297 events under a near_estate namespace; event shape alone does not implement an NFT standard. Include events for registration, car changes, plot purchase, park, collect, expire, ticket, rule scheduling, building levels, appearance decisions and config changes.

Prepay bounded account storage for three cars and one active session during registration. Quote and charge a plot/building reserve at purchase. Subsequent gameplay methods attach zero NEAR; purchases and storage funding use the wallet. Normal NEAR function-call keys cannot attach deposits, so the session-key allowlist and storage model must be tested together. [NEAR access keys](https://docs.near.org/protocol/accounts-contracts/access-keys)

Use Meteor on testnet and select a second active wallet after a compatibility spike. As of November 2026, MyNearWallet refuses new app connections. Evaluate the documented NEAR Connect integration against restricted access-key needs; retain Wallet Selector while it remains the working choice. Record tested package versions, key permissions, allowance and renewal behaviour in DECISIONS. [NEAR Connect](https://docs.near.org/tools/near-connect)

The initial gameplay key allowlist is park, park_tower, collect, settle_expired, ticket, repair, emergency_repair and set_rule. Keep purchases, building upgrades and appearance publishing behind wallet signing. Use finite gas allowance, recovery on exhaustion, account-scoped storage and a wallet-assisted on-chain revoke action. Clearing local storage alone is not key revocation.

API routes cover auth challenge/verify/logout; generation create/status/select; appearance proposal status; logo/ad upload; immutable asset retrieval; impression batches; plot stats; and moderator approval/revocation. Authenticate uploads and generation, bind jobs to ownership, limit body bytes and decoded pixels, and protect administrative actions from cross-site requests. Worker keys are method-restricted and loaded from protected runtime configuration.

The event indexer processes finalized successful contract execution logs, with a durable cursor, transactionally committed event identities and replay-safe aggregates. Pin a testnet-capable block-data source during phase 0; NEAR currently documents Neardata for hosted block streams. External RPC/block data is permitted even though application services are self-hosted. [NEAR indexer guidance](https://docs.near.org/data-infrastructure/indexers)

# Acceptance and release requirements

**Contract invariants:** one starter grant; at most three cars and one earning session per account; one car per space and one space per car; all payouts occur once; expiry preserves earnings; fees plus driver payout equal gross; ticket recipient plus forfeited amount equal gross; paused admission does not block exit; NPC capacity is real; ownership and moderator roles cannot be bypassed.

**Adversarial cases:** competing parks, collect versus ticket versus expiry, stale session IDs, unauthorized car actions, pending-rule replacement at its deadline, config changes during a park, inspection retries, self-ticketing, slot reuse, arithmetic bounds and rounding, insufficient storage, exhausted access keys, and emergency-repair abuse.

**Asset cases:** every level fits its height/width envelope; alpha and placement bounds are checked after normalization; every type has distinguishable silhouettes; generation cannot grant a level or service role; changing owner/type/level/revision prevents stale publication; changed links cannot reuse approval; revocation invalidates cached eligibility; failed jobs preserve the current building.

**Service cases:** duplicate job and approval requests, crashes before/after chain submission, uncertain provider timeouts, API budget exhaustion, malformed/oversized uploads, failed moderation, revoked media, indexer backfill and restart, and restore from a database-plus-assets backup.

**Experience targets:** smooth scrolling at a target 60 FPS on the agreed desktop reference and at least 30 FPS on the agreed mid-range mobile device; only current and neighbouring street data loaded; lazy image textures and bounded GPU cache; no per-frame RPC calls. Phase 0 records the actual devices and measurements. Dynamic facade atlases are added only if profiling justifies them.

A release candidate passes unit and sandbox contract tests, API integration tests, a two-account end-to-end browser journey, asset-envelope validation, wallet tests for both supported wallets, and a fresh-VPS backup/restore drill. The first invite beta uses curated facades and keeps paid image generation disabled, as requested. Paid generation through approval on testnet remains required before a later release can offer owner-prompted buildings; mock-only generation is not proof of that feature.

# Implementation phases and numbered tasks

Tasks use stable numbers for implementation and review. Phases 2 and 3 can proceed in parallel after the shared interfaces in phase 1. Phase 4 joins them. City/NPC work in phase 7 can run alongside image-provider work once the required contract and client interfaces exist. At every phase gate, demonstrate the result, update DECISIONS with choices and sources, and list unresolved items. Do not silently skip a gate or implement stretch scope.

## Phase 0 Validate the riskiest assumptions

Start here.

1. Record the V1 scope, NPC/player ownership boundary, five building types and proposed economy; list every deliberate change from the original handoff.
2. Run a minimal testnet wallet spike for Meteor and a second active wallet: login, restricted key creation, zero-deposit call, allowance exhaustion and key revocation. Confirm the replacement supports the artwork signing flow before adding it to the chooser.
3. Before any later paid image spike, configure a finite spend ceiling and a maximum of six image calls. Then test transparent generation, reference-based editing and normalization; record model/version access, actual latency and measured cost. Deferred at the user's request for the curated-only beta.
4. Before enabling paid art, validate generated samples for every type against all four height envelopes; prove that different silhouettes remain readable at actual game scale. Curated samples cover the initial beta's scale review.
5. Confirm a testnet event-data source with finalized successful execution logs, historical replay and receipt-level event identity.
6. Fix the reference devices, movement settings, image quota/budget configuration and seed graph; document package versions and unresolved limitations.

**Phase gate for the curated-only beta:** Wallet gameplay can sign without repeated popups; curated facades render inside their envelopes; chain events can be replayed; paid generation remains disabled. Tasks 3–4 must pass before enabling the later paid-art release. No exact model price or API behaviour is guessed.

## Phase 1 Establish the project and shared contracts

After phase 0.

7. Create the monorepo, package/workspace tooling, Rust toolchain, lint/format commands, reproducible lockfiles and CI.
8. Define shared request, response, error and event schemas; serialize coin amounts safely and add paginated view shapes.
9. Implement versioned game configuration with validation, economic snapshot fields and a deterministic mock clock.
10. Define player plot, NPC site, street connection and parking-space schemas; validate the five-road seed and separate civic frontages.
11. Define the asset manifest, render profiles, hash canonicalization, appearance revisions and moderation state transitions.
12. Create Docker Compose development services and the GAME_RULES, API, ART_SPEC, DECISIONS, ASSET_PIPELINE and OPERATIONS documents.

**Phase gate:** Web and contract skeletons build in CI; shared schemas and seed validation pass; every tuneable has units, a default and bounds.

## Phase 2 Build the playable client with presets

After phase 1; can run alongside phase 3.

13. Implement sky, parallax backdrop, facade, sidewalk, curb and driving layers with the shared coordinates and camera scaling.
14. Produce/import the 40 curated building facades, their palette masks and validated logo/ad placements; keep the ten base silhouettes distinct.
15. Produce/import the six car bodies in four colours and the game-owned destination assets; enforce common sprite anchors and size limits.
16. Implement keyboard/touch driving, car selection, street browsing while parked and destination interaction zones.
17. Implement in-memory park, collect, ticket, expiry and tower parking through the same client interface planned for the contract, keeping the action target separate from driving controls.
18. Build the Street, Cars, Map, My Plots and initial stats/studio screens, including pending/error/empty states, landscape phone gameplay, portrait-capable menus and the desktop panel layouts.
19. Implement street switching, cross-street views, map travel and current-car location recovery.
20. Profile reference devices, add lazy asset loading and bounded texture caching, and verify all levels next to neighbouring plots.

**Phase gate:** A tester can drive, park, collect, change cars and explore with mock state; all preset buildings fit and remain visually distinct.

## Phase 3 Implement authoritative game rules

After phase 1; can run alongside phase 2.

21. Implement initialization, admin/moderator/inspector roles, pause behaviour, bounded config updates and versioned state.
22. Implement paid storage registration, the one-time starter grant, fixed-point coin balances and storage quote/refund rules.
23. Implement cars, ownership limits, purchases, partial repair, tier upgrades, emergency repair and cosmetic purchase.
24. Implement player plot purchases, corner pricing and NPC sites that cannot be purchased by players.
25. Implement effective rules, delayed replacements, session creation and complete snapshots of parking terms.
26. Implement atomic collect and expire settlement, lazy reuse of expired spaces, and the one-earning-car restriction.
27. Implement owner tickets, cooldowns, inspector-only attempts, failure consumption, patrol bounds and treasury allocation.
28. Implement building type/preset changes, paid levels, pending appearance revisions, exact approval/rejection and revocation checks.
29. Emit versioned events and complete unit plus near-workspaces sandbox tests for arithmetic, permissions, races and state invariants.

**Phase gate:** The specified economy examples and adversarial cases pass; no session can pay twice, exceed capacity, or gain a level through artwork.

## Phase 4 Connect a real testnet street

After phases 2 and 3.

30. Deploy a reproducible testnet contract build and idempotent seed scripts; publish the account IDs and version checks.
31. Integrate wallet registration, native storage funding, starter selection and the restricted gameplay key flow.
32. Replace mock mutations and reads with typed contract calls; preserve the mock adapter for tests.
33. Implement transaction reconciliation, serialized session-key signing, refreshed nonces, account switching and stale-session guards.
34. Wire real car purchase, repair, upgrades, curb parking and one NPC tower.
35. Implement refreshed state polling and confirmed-state reconciliation without per-frame network calls.
36. Run a two-account journey covering a contested slot, meter fee, owner ticket, expiry and reconnect.

**Phase gate:** Two wallets can play the core loop on one shared testnet street, with popup-free allowed gameplay and reliable failure recovery.

## Phase 5 Deliver plot ownership and a mock building studio

After phase 4; uses the appearance methods from phase 3.

37. Build the plot purchase view with total testnet NEAR price, storage reserve and unavailable/NPC parcel handling.
38. Build owner rule controls, pending-rule countdown, balance/current-rate displays and effective-rule signs; historical plot income follows the indexer in phase 7.
39. Build preset/type/colour selection and paid building upgrades with immediate valid preset fallback.
40. Implement wallet-backed API authentication, ownership checks and bounded logo/ad uploads.
41. Implement a durable mock generation job returning three candidate bundles, private previews and a real neighbour comparison.
42. Implement selection, owner proposal submission, moderator review, chain approval/rejection and approval-state reconciliation.
43. Implement revocation, initials/preset fallback, appearance history and rejection reasons; test stale approvals after type/level changes.

**Phase gate:** An owner buys a plot, changes its rules, upgrades it, selects a mock candidate and sees exactly the approved revision in the shared city.

## Phase 6 Enable prompt-generated buildings (later paid-art release)

After the applicable phase-0 wallet and event checks and phase 5. Implementation and fake-provider tests may proceed now; the real-provider gate remains deferred by the user.

44. Implement the versioned prompt builder with type, paid level, theme/material hints, palette, render envelope and optional approved identity reference.
45. Implement the real provider adapter behind backend credentials, invite eligibility and an operator-controlled generation switch.
46. Implement per-account/per-plot quotas, global call and currency budgets, reservations, concurrency limits and finite paid retries.
47. Implement request idempotency, leased jobs, timeout reconciliation, restart recovery, cancellation and superseded-job handling.
48. Normalize images, verify decoded dimensions/alpha bounds, validate placement manifests, create thumbnails and store immutable content hashes.
49. Add candidate content/style review and human moderation of the exact final facade plus logo/ad/link combination.
50. Implement private candidate retention, published-asset retention, new-revision recolouring and upgrades using prior art as reference.
51. Test real jobs plus forced failures: oversized media, incorrect perspective, provider outage, budget exhaustion, duplicate callbacks, upgrade during generation and revocation after caching.

**Phase gate:** An invited owner prompts, compares three valid candidates and publishes an approved building on testnet; failures cannot spend without bounds or alter current gameplay state.

## Phase 7 Complete the city and lightweight activities

After phase 4; owner stats require phase 5. Can overlap phase 6.

52. Seed and validate the full five-road city, 80 player plots and separately placed NPC destinations.
53. Enable all three 32-space NPC towers with floor selection, capacity counters, reduced earnings and expiry sweeps.
54. Complete the NPC garage menus and tower/map navigation; ensure civic capabilities come from service roles.
55. Add curated cinema playback and the Near & Far free interaction plus optional burger decal.
56. Add one solo practice course, tier-sensitive movement, checkpoints and local personal bests without coin rewards.
57. Implement the finalized event indexer, durable cursor, idempotent aggregates and historical backfill.
58. Implement ad-surface visibility measurement, retry-safe batches, per-minute impression dedupe and capped dwell aggregation.
59. Build read-only plot statistics with freshness indicators; enable bounded inspector patrols and economy telemetry.

**Phase gate:** The complete city remains playable when curb parking is full; activities work, NPC capacity is accurate, and stats survive a worker restart.

## Phase 8 Harden and release the curated-only invite beta

After phases 5 and 7. Phase 6 is a separate gate before enabling paid art.

60. Complete focused security review of contract roles, storage funding, key handling, API authentication, media ingestion and moderator actions.
61. Run the full invariant/race suite and end-to-end journeys for both supported wallets across reference desktop/mobile devices.
62. Measure first-play onboarding, earning/spending pacing, parking occupancy and NPC usage. For a later paid-art release, also measure generation approval rate, latency and actual cost.
63. Tune only documented configuration values; rerun checks affected by changes and preserve active-session economic terms.
64. Deploy on the target VPS with TLS, persistent volumes, protected runtime secrets, health checks, logs and budget/indexer alerts.
65. Run a clean backup/restore drill including SQLite, immutable assets, deploy metadata and worker cursors; prove restart-safe processing.
66. Complete operator runbooks for moderation, revocation, generation suspension, RPC failure, key rotation and contract rollback/migration.
67. Publish the invite-beta build and a release checklist; record known limits and explicitly leave deferred features out.

**Phase gate:** A fresh account can complete the driver and owner journeys, including a curated building with reviewed logo and billboard, on the deployed testnet game; paid generation is off and recovery procedures have been demonstrated. A real generated building remains required before enabling paid art.

# Definition of release completion

For the curated-only invite beta, a new player registers, drives, parks, earns, collects, repairs and upgrades a car. A plot buyer chooses a distinctive building type and preset, changes parking rules, upgrades within the level envelope, and sees the approved curated building, logo and billboard in the shared city. Another account can park at that plot and see its approved media. Full parking lots never block access to free activities, expired cars cannot permanently occupy spaces, and paid generation is disabled.

Full V1 also requires an owner to prompt for three generated alternatives, select one and see its approved building in the shared city after real inference, cost, quality and recovery tests pass. The first playable testnet milestone is phase 4; the curated-only invite beta is phase 8. The promised prompt-and-choose experience follows the separate phase-6 paid-art gate. Building appearance remains independent from the authority to grant coins, parking capacity or NPC services.
