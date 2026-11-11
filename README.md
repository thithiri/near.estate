# near.estate

V1 implementation workspace for a NEAR testnet parking city. The full [specification and numbered plan](docs/V1_SPEC.md) is the scope of this project; this checkout is work in progress.

## Run locally

```sh
npm ci
npm run dev:guest
```

`dev:guest` starts the instant local city with hot reload. To inspect the deployed testnet city and its approved artwork, stop that command and run `API_DATA_DIR=/absolute/path/to/private/media npm run dev:city`. The city command reads the contract ID from `deployments/testnet.json`, builds and watches shared game code, starts the web app and API, and keeps parking statistics current with the event indexer. Its starting block comes from the matching verified backfill record; for another contract, set `INDEXER_START_HEIGHT` to that contract's creation height. Set `DEV_INDEXER=0` for offline city work. The app opens at `http://localhost:5173`. Without `API_DATA_DIR`, it uses ignored `data/local-dev`; previously approved uploads from another API volume will be unavailable. If ports are occupied, set `WEB_PORT` and `API_PORT` together, for example `WEB_PORT=5176 API_PORT=3001 npm run dev:city`. Both commands require only one terminal and stop their local processes with Ctrl-C.

For the quick edit loop, keep the chosen dev command running: Vite refreshes street/UI changes, the API and indexer restart after service edits, and shared game code recompiles on change. Run `npm run test -w @estate/web` or `npm run test -w @estate/api` for the part you changed. With `dev:guest` already running, use `npm run test:browser:local` to check guest journeys without a second server or build; set `ESTATE_BROWSER_LOCAL_URL` if its port differs from 5173. `npm run test:browser` still starts and stops its own guest server on port 5187 for an independent run. The suite covers park/collect/repair/ticket, full-curb tower fallback, complete practice and cinema journeys, plus screen navigation and horizontal-overflow checks at desktop, phone landscape and phone portrait sizes; its first local run needs `npx playwright install chromium --only-shell`. Run browser tests separately from `npm run check` because both commands use the shared build output. Run `npm run check`, `npm run assets:check`, and `npm run contract:test` at the relevant phase gate. The repository's `.cargo/config.toml` supplies the NEAR host-function build flag for WASM, and the contract rejects a WASM build that omits it. Rust contract changes still need a new testnet deployment before Live city can show them.

With `dev:guest` running, use `npm run profile:street` in another terminal for an eight-second driving sample at desktop and phone-sized browser viewports. Set `ESTATE_PROFILE_URL` if the dev server uses another port; `--out /path/to/report.json` saves the result. This local browser check does not measure a physical phone or GPU memory.

For a contract code swap, `npm run contract:layout:check` runs the frozen storage-layout tests locally. The testnet code-upgrade tool runs this guard automatically before its sandbox rehearsal or live apply. A changed layout needs a migration procedure instead of the ordinary code-upgrade path.

With `dev:city` running, `ESTATE_BROWSER_LIVE_URL=http://localhost:5173 npm run test:browser:live` checks the public testnet street and advertiser stats in Chromium. It uses the running city and API, makes no wallet transaction and fails if the indexed block is over ten minutes old. Set the URL to your chosen `WEB_PORT` when different.

For the second-wallet compatibility spike, start a separate local city with `VITE_EXPERIMENTAL_INTEAR=1 npm run dev:city`. This adds Intear to the local wallet chooser; normal builds show Meteor only. With that city running, set `ESTATE_EXPERIMENTAL_INTEAR=1` alongside `ESTATE_BROWSER_LIVE_URL` to check that Intear's connection screen opens. Sign-in, artwork signing and gameplay-key approval still need a real-wallet test before this option can be released.

The repeatable two-account testnet ticket journey uses separate private owner and driver credential files. Set `ESTATE_OWNER_KEY_FILE` and `ESTATE_DRIVER_KEY_FILE` to absolute paths outside this repository, run `npm run testnet:two-account:plan`, then `npm run testnet:two-account:apply`. Apply buys one dedicated shared-city plot at the quoted testnet NEAR price, schedules NoParking, and exits until the five-minute rule delay passes. Run apply again after that deadline to park the driver's car illegally, ticket it from the owner account, and schedule Free as the restored rule. After Free becomes effective, `npm run testnet:two-account:verify` checks the final state and transaction outcomes. The private journal lets an interrupted run check the exact signed transaction before continuing. This tests direct signed contract calls; named browser wallets have a separate release gate.

With the same two private credential paths, `npm run testnet:contested-curb:plan` checks an unowned Free curb and both cars, then `npm run testnet:contested-curb:apply` signs and broadcasts two park attempts for that one slot, verifies one winner and one loser, and collects the winner. Its private journal retains exact signed bytes if a network reply is lost. Set `API_DATA_DIR` to the running city's SQLite data directory and run `npm run testnet:contested-curb:indexed` to verify exactly one park and one collection reached the event index.

`npm ci` applies two Meteor dependency manifest patches and an experimental Intear browser-message guard from `patches/`. Keep install scripts enabled; `npm ls` and the production audit are checked in the [release checklist](docs/RELEASE_CHECKLIST.md).

The web app starts in guest mode with local mock state. Guest actions do not affect shared ownership or rewards. To show the separate **Live city** screen after deploying the contract, set `VITE_ESTATE_CONTRACT_ID` to the deployed `.testnet` account before starting or building the web app. The live screen reads the selected street side and supports wallet-backed registration, purchases, curb and tower parking, collection, tickets, and repairs. The illustrated Street has an explicit testnet switch: it renders chain-backed buildings, rules, occupancy, selected car and balance, and uses the restricted key for parking, collection and owner tickets. Guest mode stays local. Wallet actions have not yet been verified with two testnet accounts.

## Testnet deployment

`npm run deploy:plan` builds the exact release WebAssembly, validates the city seed, and prints its SHA-256 without contacting testnet. The disposable testnet city is recorded in [deployments/testnet.json](deployments/testnet.json): 80 plots and seven game-owned sites were verified on-chain. A separate [two-account chain journey](deployments/testnet-journey.json) passed meter, ticket, contested-slot, expiry and signer-reconnect checks. A [restricted-key check](deployments/testnet-gameplay-key.json) passed method, deposit and receiver limits, allowance exhaustion and on-chain revocation. An [event-source probe](deployments/testnet-event-source.json) matched a finalized contract receipt between Neardata and archival RPC and rediscovered its transaction from the archived block. Wallet UI transactions still need testing with Meteor and a second active wallet. The deployment and credential procedure is in [deployments/README.md](deployments/README.md).

The contract restricts first initialization to the contract account. The seeded testnet city now runs this binary after a [state-preserving upgrade](deployments/testnet-code-upgrade-007f67a531c87671f57a96660b4a61f3b7fca6a60681944c5b8227eaf0549c59.json) that kept every state key/value unchanged.

## Trust boundary

Ownership, parking capacity and terms, game coins, rules, tickets, building levels and approved appearance hashes belong on-chain. The operator controls image hosting, prompt generation, moderation decisions, impression estimates, the event indexer, the inspector account and the expiry sweep. The inspector account is limited by contract rules, but can still choose or omit targets. The expiry account can only call the public `settle_expired` method through its runtime key; the contract decides whether a session has expired and what it pays. No game coin has a redemption or transfer method in V1.

Operator setup, incident procedures and state recovery are documented in [Operations](docs/OPERATIONS.md), [Incidents](docs/INCIDENTS.md) and [Recovery](docs/RECOVERY.md).

The VPS deployment uses [the production Compose override](infra/compose.prod.yaml), [optional expiry sweep](infra/compose.expiry.example.yaml) and [domain Caddyfile](infra/Caddyfile.prod); public TLS issuance and invite-beta release remain unverified.

## Layout

Phone driving uses landscape; menus and the building studio also work in portrait. Desktop has a wide scene and a dismissible plot panel. The [phone](docs/images/near-estate-phone-layout-v1.png) and [computer](docs/images/near-estate-computer-layout-v1.png) sheets are references, not screenshots of the app.

See the [current game visuals](docs/VISUALS.md) for street and building studio captures, plus the illustrated building draft sheet. The [building image specification](docs/BUILDING_IMAGE_SPEC.md) records the prompt and size rules. The five illustrated images are guest-only demonstrations; live owner publication still uses the approval flow.

## Status

The [numbered progress tracker](docs/PROGRESS.md), [decisions](docs/DECISIONS.md) and [invite-beta release checklist](docs/RELEASE_CHECKLIST.md) show verified work and unverified gates. The [recovery runbook](docs/RECOVERY.md) covers the shared SQLite volume, immutable artwork and deployment records. Do not use a local build as evidence of a completed testnet or paid-generation phase.
