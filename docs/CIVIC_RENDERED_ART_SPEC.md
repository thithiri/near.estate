# Rendered game-owned destinations

Six game-owned facades are generated raster illustrations. Their transparent source PNGs live in `art/source/civic-rendered`; `scripts/generate-world-sprites.mjs` trims and fits them into 560 × 640 transparent sprites in `apps/web/public/world`. The visible base sits at logical y=160. The game draws each destination name over the blank sign panel using the `labelRect` in `apps/web/src/world-sprites.json`. The source SHA-256 and normalized sprite SHA-256 are recorded there and checked by `npm run assets:check`. Civic sprite URLs include a short hash query so browsers fetch the new art after deployment.

## Prompt set

Use case: `stylized-concept`. Asset type: transparent 2D facade sprite for the side-scrolling near.estate parking city. Draw a complete, isolated building in strict straight-on front elevation with a flat ground-level base, no visible side wall or perspective. Use polished hand-inked mobile city game art: crisp dark navy contours, broad bright color fields, warm cream details, restrained texture and highlights. Keep a distinct silhouette readable at 140 logical pixels. Include a completely blank cream sign panel for the game-rendered name. Use a genuine transparent background and clean alpha edges. No sky, road, cars, people, embedded lettering, logos, numbers, watermark, UI or cast shadow outside the silhouette.

Apply that common prompt separately to these six subjects:

1. **ParkingTower:** tall concrete and teal tower; four open, dark parking decks with rails and bay guides; turquoise glass side shafts; blank upper sign panel. Fill most of the height.
2. **RepairGarage:** low, wide blue-metal sawtooth workshop; broad central roll-up service door, two tool and tire windows, blank sign above the door.
3. **Cinema:** purple and deep-blue art-deco theater; stepped roof, circular film-reel medallion, glowing entrance and bulb-lined marquee; blank wide marquee panel.
4. **BurgerStop:** one-story coral diner with golden bun-shaped roof and green lettuce band, turquoise dining windows, teal central doors; blank cream sign band. This building is Near & Far Burgers.
5. **PracticeCourse:** wide, structured course gatehouse with cream pylons, red-orange canopy, dark open passage, checkered pennants and cone details; blank canopy sign.
6. **HorseCourse:** teal peaked equestrian grandstand gate with gold horseshoe relief, cream brick piers, arched entrance, visible bleachers, coral/yellow race flags and planted details; blank sign spanning the entrance.

The art was made with the built-in imagegen tool, not the paid local image API. The six prior flat civic sprites and their review sheet are retained in `art/archive/civic-vector-v1`. The [current review sheet](images/near-estate-civic-destinations-v2.png) shows all six normalized sprites; the [street review](images/near-estate-civic-street-review-v1.png) shows their names and scale in the running guest game. No contract or gameplay rules changed in this art pass.
