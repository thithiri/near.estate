# near.estate

V1 implementation workspace for a NEAR testnet parking city. The full [specification and numbered plan](docs/V1_SPEC.md) is the scope of this project; this checkout is work in progress.

## Run locally

```sh
npm ci
npm run dev:guest
```

`dev:guest` starts the instant local city with hot reload. To inspect the deployed testnet city and its approved artwork, stop that command and run `API_DATA_DIR=/absolute/path/to/private/media npm run dev:city`. The city command reads the contract ID from `deployments/testnet.json`, builds and watches shared game code, starts the web app and API, and keeps parking statistics current with the event indexer. Its starting block comes from the matching verified backfill record; for another contract, set `INDEXER_START_HEIGHT` to that contract's creation height. Set `DEV_INDEXER=0` for offline city work. The app opens at `http://localhost:5173`. Without `API_DATA_DIR`, it uses ignored `data/local-dev`; previously approved uploads from another API volume will be unavailable. If ports are occupied, set `WEB_PORT` and `API_PORT` together, for example `WEB_PORT=5176 API_PORT=3001 npm run dev:city`. Both commands require only one terminal and stop their local processes with Ctrl-C.

For the quick edit loop, keep the chosen dev command running: Vite refreshes street/UI changes, the API and indexer restart after service edits, and shared game code recompiles on change. Run `npm run test -w @estate/web` or `npm run test -w @estate/api` for the part you changed. Run `npm run check`, `npm run assets:check`, and `npm run contract:test` at the relevant phase gate; Rust contract changes still need a new testnet deployment before Live city can show them.

`npm ci` applies the two small Meteor dependency manifest patches in `patches/` so the scoped fixed versions satisfy their declared ranges. Keep install scripts enabled; `npm ls` and the production audit are checked in the [release checklist](docs/RELEASE_CHECKLIST.md).

The web app starts in guest mode with local mock state. Guest actions do not affect shared ownership or rewards. To show the separate **Live city** screen after deploying the contract, set `VITE_ESTATE_CONTRACT_ID` to the deployed `.testnet` account before starting or building the web app. The live screen reads the selected street side and supports wallet-backed registration, purchases, curb and tower parking, collection, tickets, and repairs. The illustrated Street has an explicit testnet switch: it renders chain-backed buildings, rules, occupancy, selected car and balance, and uses the restricted key for parking, collection and owner tickets. Guest mode stays local. Wallet actions have not yet been verified with two testnet accounts.

## Testnet deployment

`npm run deploy:plan` builds the exact release WebAssembly, validates the city seed, and prints its SHA-256 without contacting testnet. The disposable testnet city is recorded in [deployments/testnet.json](deployments/testnet.json): 80 plots and seven game-owned sites were verified on-chain. A separate [two-account chain journey](deployments/testnet-journey.json) passed meter, ticket, contested-slot, expiry and signer-reconnect checks. A [restricted-key check](deployments/testnet-gameplay-key.json) passed method, deposit and receiver limits, allowance exhaustion and on-chain revocation. An [event-source probe](deployments/testnet-event-source.json) matched a finalized contract receipt between Neardata and archival RPC and rediscovered its transaction from the archived block. Wallet UI transactions still need testing with MyNearWallet and Meteor. The deployment and credential procedure is in [deployments/README.md](deployments/README.md).

The contract restricts first initialization to the contract account. The seeded testnet city now runs this binary after a [state-preserving upgrade](deployments/testnet-code-upgrade-007f67a531c87671f57a96660b4a61f3b7fca6a60681944c5b8227eaf0549c59.json) that kept every state key/value unchanged.

## Trust boundary

Ownership, parking capacity and terms, game coins, rules, tickets, building levels and approved appearance hashes belong on-chain. The operator controls image hosting, prompt generation, moderation decisions, impression estimates, the event indexer and the inspector account. The inspector account is limited by contract rules, but can still choose or omit targets. No game coin has a redemption or transfer method in V1.

Operator setup, incident procedures and state recovery are documented in [Operations](docs/OPERATIONS.md), [Incidents](docs/INCIDENTS.md) and [Recovery](docs/RECOVERY.md).

The VPS deployment uses [the production Compose override](infra/compose.prod.yaml) and [domain Caddyfile](infra/Caddyfile.prod); public TLS issuance and invite-beta release remain unverified.

## Layout

Phone driving uses landscape; menus and the building studio also work in portrait. Desktop has a wide scene and a dismissible plot panel. The [phone](docs/images/near-estate-phone-layout-v1.png) and [computer](docs/images/near-estate-computer-layout-v1.png) sheets are references, not screenshots of the app.

## Status

The [numbered progress tracker](docs/PROGRESS.md), [decisions](docs/DECISIONS.md) and [invite-beta release checklist](docs/RELEASE_CHECKLIST.md) show verified work and unverified gates. The [recovery runbook](docs/RECOVERY.md) covers the shared SQLite volume, immutable artwork and deployment records. Do not use a local build as evidence of a completed testnet or paid-generation phase.
