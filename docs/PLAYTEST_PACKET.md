# near.estate invited playtest packet

## What to ask five to ten players to do

Use the guest city first. Give each player the current web URL and ask them to try the game for 15 minutes without step-by-step coaching. They can drive with the arrow keys or the lower-right controller. Ask them to find the first stop on **Today's trip**, park nearby, finish its activity, collect the car, and start the second stop. Then let them explore a building choice and the garage. A separate wallet group can test the shared testnet city after the guest flow is clear.

For the plot-owner task, show the [local design-preview example](images/near-estate-owner-design-preview-v2.png) only after the player has tried the picker. It is a fixture screenshot, not evidence of a signed testnet edit.

Suggested invitation text:

> We're testing a small side-scrolling parking game. Could you play for about 15 minutes and tell us where you got stuck or wanted to keep going? The guest game does not require a wallet. In Menu, you may choose **Start recording** to keep a small playtest log on your own device. It is off by default and is never sent automatically. If you choose to share it, use **Download my playtest log** and send that file to the team. You can pause or clear it at any time.

## Observe, then ask

Record whether the player can find a legal space, understand why a space is legal or risky, notice that parking earns coins, reach and finish an activity, collect the car, and choose the next stop. Do not explain the controls unless they ask or are blocked for two minutes.

After play, ask:

1. What did you think you were trying to do first?
2. Where did the car or street controls surprise you?
3. What made a parking space feel worth choosing?
4. Was the reason to visit a destination clear? Would you make a second trip?
5. For plot owners: could you tell what changing the building would show on the street before confirming?

## Small, consented event log

The Menu's optional guest log records only action names and elapsed minutes: legal or illegal park, collect, repair, upgrade, garage opening, burger visit, finished cinema/practice/horse activity, completed trip stop, and return on a later UTC day. It stores at most 120 events in browser local storage. It does not contain account IDs, plot IDs, coordinates, images, links, or coin balances. The player downloads and shares the JSON manually. Use the first legal park, first collect, second park, first repair or upgrade, destination completion, and return-day events to compare the flow across participants. Keep operator coin issuance and spending data separate from this local log.

For each participant, note device and browser family, orientation, whether they used a wallet, a 1–5 ease-of-control score, the first place they paused, and whether they voluntarily started a second stop. Do not collect names or wallet addresses in the analysis sheet. Report a median time for each milestone and counts of players who reached it. With fewer than five players, treat results as qualitative problems to fix rather than evidence for an economy change.

## Release checks and boundaries

- The local browser tests cover guest phone portrait/landscape layouts, the map-to-park-to-activity-to-collect path, and owner preview controls. The city fixture covers the approved-media testnet canvas. A read-only RPC audit confirms the deployed five roads, 100 plots, 180 curb spaces, and eight civic sites. These are not a physical-device or signed-wallet journey.
- Before calling the wallet path complete, run the same journey on a physical phone with an actual testnet account and a restricted gameplay key. Record the phone model, browser, action receipts, and any wallet popups or failed returns. The design application is a separate wallet-confirmed owner action.
- Keep horse betting disabled in the playtest. The free spectator race is enough to test whether the destination is fun; the betting proposal has separate fairness, bankroll, and legal gates.
