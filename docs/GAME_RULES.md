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
| Owner ticket payout limit     |                  15 coins per plot per UTC day |
| Inspector                     |   25% success, 5-min age, 8 attempts per 5 min |
| Plot price                    |      1 testnet NEAR; corners 2×; storage extra |
| Towers                        |                                  3 × 32 spaces |
| Burger decal                  |                                       30 coins |
| Logo / facade cooldowns       |                                    72 h / 24 h |

Parking terms are snapshotted when a session starts. Later config, rule, or plot ownership changes cannot rewrite an existing payout. Expired sessions remain settleable while new game changes are paused. The local contract now also freezes plot seeding, owner media removal, moderator decisions and config updates during a pause; this tighter behavior has not been deployed to testnet.

Emergency repair is free once per rolling 24 hours only when every owned car lacks the durability to park and the player cannot afford the least expensive repair that would make one parkable. It restores the starter car to the current parking durability cost (two points by default).

Storage funding defaults to 4,096 reserved bytes per registered player and 4,096 bytes per purchased plot, charged at the chain's current storage-byte price. The plot reserve covers two bounded logo/billboard records and their moderation history. Sandbox measurements found a maximal plot uses 3,493 reserved bytes, and registration and purchase deltas fit their reserves. These sizes are configurable within documented bounds; longer account IDs and future schema growth still need review.

The owner ticket limit is a code-only-upgrade policy stored separately from the version-2 root config. An owner may still clear an illegal car after reaching the limit; the excess of the usual 70% ticket share enters the game treasury. The inspector's entire ticket share enters treasury. The limit resets at 00:00 UTC, is adjustable by the admin from 0 to 1,000 coins per plot per day, and does not retroactively change earlier settlements. This policy is live on testnet as of the [guarded release](../deployments/runtime-upgrade-live-490fcae6958c051d.json). Its bounded per-plot usage keys are funded by the game contract rather than a player's reserved storage.
