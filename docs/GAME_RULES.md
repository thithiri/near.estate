# Game rules

The authoritative V1 rules are in [V1_SPEC](V1_SPEC.md#parking-economy-and-rules). Defaults and bounds live in `packages/shared/src/config.ts` and are mirrored into the contract config. One displayed coin is 1,000,000 integer subunits; JSON uses decimal strings.

| Rule                          |                                        Default |
| ----------------------------- | ---------------------------------------------: |
| Starter grant                 | 100 coins and full-durability tier-1 hatchback |
| Car limit / earning limit     |                            3 owned / 1 earning |
| Legal base earnings           |                                  60 coins/hour |
| Tier multipliers              |                                 1×, 1.5×, 2.2× |
| Illegal / tower factors       |                                    1.5× / 0.5× |
| Earn cap / release grace      |                                 30 min / 2 min |
| Park durability / repair      |                    2 points / 1 coin per point |
| Car purchase / upgrades       |                          150 / 200 / 500 coins |
| Building upgrades             |                        200 / 600 / 1,500 coins |
| Type change                   |                                      100 coins |
| Meter maximum                 |                30 coins/hour; fee ≤ half gross |
| Rule delay / ticket cooldown  |                                  5 min / 5 min |
| Ticket recipient / forfeiture |                                      70% / 30% |
| Inspector                     |   25% success, 5-min age, 8 attempts per 5 min |
| Plot price                    |      1 testnet NEAR; corners 2×; storage extra |
| Towers                        |                                  3 × 32 spaces |
| Burger decal                  |                                       30 coins |
| Logo / facade cooldowns       |                                    72 h / 24 h |

Parking terms are snapshotted when a session starts. Later config, rule, or plot ownership changes cannot rewrite an existing payout. Expired sessions remain settleable while new economic actions are paused.

Storage funding defaults to 4,096 reserved bytes per registered player and 4,096 bytes per purchased plot, charged at the chain's current storage-byte price. The plot reserve covers two bounded logo/billboard records and their moderation history. Sandbox measurements found a maximal plot uses 3,493 reserved bytes, and registration and purchase deltas fit their reserves. These sizes are configurable within documented bounds; longer account IDs and future schema growth still need review.
