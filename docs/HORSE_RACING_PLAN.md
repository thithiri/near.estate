# Harbor Horse Course — destination and house betting plan

**Status:** Phase 1 is deployed on testnet: Harbor South frontage 10 is the eighth game-owned destination. The guest and testnet clients render its entrance, map card and free spectator race. A separate, browser-only demo can simulate coin bets with `?horse-betting-demo=1` in Vite development mode. It cannot spend parking coins. No on-chain bet methods or real betting are enabled. Phase 2 tasks 5–8, other than a small local ledger model, remain open.

## First-version design

- Add **Harbor Horse Course** as a game-owned destination at `harbor` South frontage 10, opposite the Harbor Cinema area. Its street facade is a compact grandstand entrance and track sign; the race takes place on a separate side-view destination screen. It consumes no player plot or curb space.
- Show four fictional horses, a short animated race, a results board, and a replay. The animation follows the already determined outcome; client frame timing never determines a payout.
- The betting mode uses existing **nontransferable game coins** only. Players cannot buy coins with NEAR, transfer winnings, cash out, or receive plots, cars, NFTs, or prizes of outside value from a race. Plot purchases remain separate NEAR transactions.
- Pilot rule proposal: one winner bet per player per race; four equally likely horses; fixed **3.8× total return including stake** on a win, equivalent to a 5% house edge before rounding. Start with 1–5 coin stakes and a 20-coin daily stake ceiling. All figures are configurable proposals and must pass economic simulation and product review before enabling bets.
- Display the chance, total return, net profit, maximum loss, house edge, cutoff time, and remaining daily limit before a bet is signed. Offer a one-click betting pause and no streak, jackpot, loss-chasing prompt, or betting notification.

## Accounting and fairness

A placed stake moves from the player's balance to race escrow. A losing stake moves from escrow to the house treasury. A winner receives the original stake from escrow plus the locked house profit from treasury. A cancelled race refunds every stake. Thus `sum(player balances) + treasury + race escrow` stays constant for every bet and settlement; any initial house reserve must be a separately authorized, capped coin issuance with its own event and supply-audit rule. Do not assume the existing treasury can underwrite a useful race.

At bet acceptance, reserve the **maximum possible house profit exposure** for the open race and reject bets that exceed available treasury. Use checked integer coin-subunit arithmetic and floor only once at final payout. Snapshot the quote and rule version on each bet. A permissionless `settle_bet` pays or refunds exactly once; an unresolved race keeps its obligations locked. No operator-only call may select a winner after bets close.

For betting, the winner must come from a verifiable future randomness source chosen and committed **before** bets open. Test proof verification, liveness, and a deterministic refund timeout in the sandbox. The contract's current `env::random_seed()` inspection draw is not a sufficient design for a house race: the caller's choice of when to invoke resolution creates a selection opportunity. NEAR exposes a block random seed, but the [near-sdk reference](https://docs.rs/near-sdk/latest/near_sdk/env/fn.random_seed.html) does not by itself solve the timing and operator incentive problem. The randomness-provider choice remains an open task; no paid wager ships until it is reviewed.

Treat the legal boundary as a release gate. Noncash, nontransferable coins reduce one category of risk but do not establish that this feature is lawful everywhere. Jurisdictions, ages, secondary markets, and any future coin or item transferability need review before enabling bets. For example, the [UK Gambling Commission's virtual-currency guidance](https://www.gamblingcommission.gov.uk/licensees-and-businesses/guide/page/digital-and-virtual-currencies) ties real-world value and transferability to licensing analysis, while its [virtual-event rules guidance](https://www.gamblingcommission.gov.uk/guidance/guidance-to-licensing-authorities/rts-3-rules-game-descriptions-and-the-likelihood-of-winning) calls for clear odds and payout information. These UK sources are design inputs, not a conclusion about where near.estate may operate.

## Phases and numbered tasks

### Phase 1 — Destination and free spectator race

1. **City data:** append `HorseCourse` to the Rust and shared `ServiceRole` enums without changing existing Borsh variant order. Add `npc-harbor-horse-course` at Harbor South frontage 10 to the version-2 seed. Raise the active NPC-site bound from seven to eight and add an admin-only, idempotent seed path that charges the game contract for its storage. Keep historical seven-site migration records valid.
2. **Navigation:** add the entrance facade, map pin, destination card, and a clear return-to-street action. Keep the course within the current side-view visual language and away from the car controls.
3. **Spectator race:** render a 30–45 second four-horse race with a deterministic demo outcome, captions, reduced-motion result view, replay, and phone-landscape controls. No coin write or paid image generation in this phase.
4. **Verification:** test seed geometry, count assumptions, route and map navigation, small-screen layout, and a guarded testnet NPC-site update. Acceptance: the eighth destination is reachable on map and street, and a free race can be watched and replayed without changing any balance.

### Phase 2 — Betting model in a local sandbox

5. **Rules and math:** put stake bounds, odds, race cadence, daily limit, reserve threshold, cutoff, refund timeout, and pause switch in a versioned racing policy. Simulate many races and worst-case concentration of bets; choose a house seed reserve only after this model.
6. **Contract ledger:** add race IDs, horse IDs, immutable odds quotes, per-player bets, escrow, treasury exposure, player/day spend counters, and explicit events. Design storage funding for each new record. Keep the current city root layout stable through a sidecar or a separately rehearsed migration.
7. **Fair outcome:** compare a compatible proof-bearing randomness source with a reviewed future-block scheme. Publish the proof and mapping from random value to winner. Make race resolution and bet settlement permissionless, single-use, and independently reproducible.
8. **Invariant tests:** cover balance conservation, insufficient player balance or house reserve, bet cutoff, quote changes, duplicate settlement, capped spending, timeout refunds, delayed randomness, rounding, pause, and upgrade/rollback. Acceptance: no race can create coins implicitly, overdraw treasury, or let the operator pick a winner after accepting bets.

### Phase 3 — Testnet betting experience

9. **Bet slip:** add a separate, clearly labeled betting panel with four horses, probabilities, 3.8× proposed return, exact stake and payout preview, explicit confirmation, and transaction status. The free spectator race remains available without signing.
10. **Chain wiring:** add views and calls for open race, quote, bankroll/exposure, my bets, `place_bet`, `resolve_race`, `settle_bet`, refund, daily limit, and betting pause. Extend `docs/API.md`, event parsing, the indexer, and the supply audit to include escrow and a separately approved reserve issuance.
11. **Operator and controls:** run a bounded race scheduler with no winner-selection authority. Add an admin kill switch that stops new bets while preserving settlement and refunds, an account-level pause, no betting for accounts marked as ineligible, and alerts for low reserve or stalled results.
12. **Journey:** perform signed two-player testnet bets with a forced winner, loser, cancellation, low-reserve rejection, and restart recovery. Acceptance: the outcome, bet terms, balances, escrow and treasury reconcile at one finalized block, and the UI matches the chain result.

### Phase 4 — Limited release decision

13. **Review:** complete jurisdiction and age/access review, randomness and contract security review, and a small invited playtest. Verify the coin remains nontransferable and has no cash-out or redeemable prize path.
14. **Tune:** compare house reserve, stake volume, payout distribution, parking coin earning/spending, and player feedback. Keep the feature disabled by default until the reviewed limits and deployment controls are signed off.
15. **Agents:** keep `place_bet` outside the existing gameplay key and headless agent policy. A later agent-betting mode needs an explicit new restricted key, an on-chain per-account spending cap, a per-run preview, and separate opt-in. Agent views and spectator replays never count as ad impressions.

## Open decisions

- Which jurisdictions and age groups may use the betting mode?
- What proof-bearing randomness source meets NEAR compatibility, availability, cost, and independence requirements?
- What initial house reserve and stake caps survive economic simulation without making parking earnings irrelevant?
- Should horse form and unequal odds be a later feature? The first version keeps four equal probabilities so players can understand and verify the payout.
