# Screen layout proposal

## Direction

Use landscape for the street and other driving scenes on phones. Keep the map,
garage, plot editor, building studio, cinema selection, and account screens usable
in portrait. On desktop, use a responsive wide layout with the street in the
center and a contextual plot panel on the right. The game does not lock device
orientation; portrait street view shows a short rotate prompt with links to the
portrait-friendly screens.

The current guest street uses this landscape layout and portrait rotate prompt.
Its lower-right street controller groups Cross above Left, Park and Right. A
tap on an arrow nudges the car; holding drives continuously. The Park button
changes to **C · Collect** after parking, or to Ticket, Visit or Turn when those
actions are available. Left and Right dim while the active car is parked. The car
uses the upper road lane when travelling left and the lower lane when travelling
right. Keyboard arrows and A/D remain available on desktop.

The street camera shows the buildings and parking on one curb at a time. The
header names that curb. **Cross road** keeps the same position along the street, moves
the car toward the far curb during a short transition, then shows the opposite
buildings and confirms the destination. A different plot number may be directly
across when the plots have different widths. Reduced-motion preference skips the
movement. If the selected car is
parked or unavailable, the action says **View other curb** and leaves the car
where it is. Junction signs say **Turn onto** the connected road. Main, Market
and River use north/south labels; the vertical Central and Harbor avenues use
west/east labels. The map dot sits on the selected side of each road, with a
north arrow for orientation. The scene keeps screen-left and screen-right
controls consistent across both curb views. The camera still shows only one
side at a time, so crossing is a brief visual transition rather than a fully
continuous street view.

The map screen places the road diagram beside street cards on desktop and
stacks them on portrait phones. Its marker says You, Parked or View according
to the selected car state. Road lines, tower pins and city-stop pins can be tapped, with named
cards for the same destinations. Towers and free activities have separate
cards below the map. A 320 CSS px width has no horizontal overflow.
In landscape phone Safari, the map and its route panel keep clear of the
device's left and right cutouts using safe-area padding.

The portrait prompt now offers a direct **Open city map** action as well as Cars
and My Plots. The five-destination bottom navigation is implemented in portrait.
In landscape, tapping a player building or its curb opens a compact bottom plot
sheet; driving closes it. Tower floors retain a scrollable side drawer because
each floor lists eight numbered spaces. The remaining camera details below are
proposals.

## Phone landscape: street

Reference viewport: 844 × 390 CSS px, including safe areas. Support widths down
to 667 px and heights down to 320 px without clipping essential controls.

1. Top strip (40–48 px): street and side, active car, coin balance, compact Map
   and Menu buttons. Do not show a full navigation row during driving.
2. Street viewport: fill the remaining height. Keep the
   car near the horizontal center while the street scrolls. Show approximately
   3–4 facades at once at the reference width; signs and spaces must remain
   tappable. Center the nearest legal/illegal parking target.
3. Controller: use a two-row pad in the lower-right road area. Cross is the
   upper button; Left, the context action and Right sit below it. The main
   action shows **P** for parking, **C** for collection, **T** for ticketing and
   a matching symbol for turning or visiting. Each button has a 48 px touch target. Tap an arrow for
   a small nudge, hold to keep driving, and stop on release or cancellation.
   Keep the pad translucent and below junction signs; the car and most curb
   spaces remain visible. Put Collect, durability, tower floor and Details in
   the small top strip. Tapping a marked parking space still parks directly.
4. Tapping a plot opens a short bottom sheet with its current rule, owner,
   purchase price if unowned, projected new-park cap payout, availability and
   one primary action. The payout shows meter deductions and illegal ticket risk.
   Close it on driving so the road and thumb controls remain usable. The
   detailed purchase flow remains in the separate My Plots and Live city views.

## Phone portrait: supporting screens

Use one-column pages with a compact header and bottom navigation for Street,
Map, Cars, Plots, and Menu. The map gets most of the available height; garage
and plot cards scroll vertically. Form fields and moderation details use the full
width. From the Street tab, show an illustrated rotate prompt and a clear
Continue to map button. Preserve the selected street and car across rotation.

The curated building studio keeps the selected facade and both neighbours in
its portrait Preview step, scaling the three facades together at narrow widths.
The [390 px capture](images/near-estate-studio-preview-phone-v2.png) and
[320 px capture](images/near-estate-studio-preview-narrow-v2.png) show the actual
guest renderer without horizontal clipping. These are browser viewport checks;
physical phone readability is still open.

The wallet-backed owner's candidate cards and three-building comparison use a
smaller art scale at widths up to 375 px so none of the facade sides are clipped. A
[320 px layout fixture](images/near-estate-owner-preview-narrow-layout-v1.png)
shows the CSS with representative candidate images. It is a layout check, not
an authenticated owner session or a paid-generation result.

If later playtesting shows strong demand for portrait driving, make it a distinct
camera/layout mode with a shorter visible street span and one focused building,
not a scaled-down version of the landscape scene. Defer that additional mode
until the landscape controls have been tested on real phones.

## Desktop and laptop

Reference content width: 1280 px; support 1024 px wide laptop windows. Keep a
top navigation bar. Use a flexible central street canvas and a 280–320 px plot
panel only when a plot is selected. Keep the viewport aspect near 16:9 to 21:9;
letterbox the game world rather than stretching buildings. Keyboard A/D or arrow
keys drive, Space takes the context action, and tapping an empty curb stall
parks in that exact space when the car is nearby. An occupied stall opens its
plot details. Current car status stays in the header; action feedback appears
over the scene rather than in a permanent instruction row.

At widths below about 1100 px, change the plot panel to an overlay/drawer so
the street remains wide enough to read. The Map, Cars, My Plots, and advertiser
stats screens use ordinary responsive desktop pages rather than a game canvas.

## Shared layout rules

- Keep wallet and coin information visible, but avoid transaction details while
  driving.
- Use one context action at a time; show a reason when parking is unavailable.
- Keep touch targets at least 44 × 44 CSS px with safe-area padding.
- Keep billboards and building names above the curb and outside controls.
- Never place the logo, rule sign, or parking availability under a persistent
  overlay.
- Use the same city position, car, and selected plot when switching screen size
  or orientation.
- Check the design at 667 × 375, 844 × 390, 390 × 844, 1024 × 768, and
  1440 × 900 CSS px, including a phone with a bottom safe area.
