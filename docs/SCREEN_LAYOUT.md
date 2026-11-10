# Screen layout proposal

## Direction

Use landscape for the street and other driving scenes on phones. Keep the map,
garage, plot editor, building studio, cinema selection, and account screens usable
in portrait. On desktop, use a responsive wide layout with the street in the
center and a contextual plot panel on the right. The game does not lock device
orientation; portrait street view shows a short rotate prompt with links to the
portrait-friendly screens.

This matches the current MVP's landscape street view and portrait rotate prompt.
It is a layout decision for the next UI pass, not a claim that every screen below
has been implemented to this specification.

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
2. Street viewport: fill the remaining height above the control strip. Keep the
   car near the horizontal center while the street scrolls. Show approximately
   3–4 facades at once at the reference width; signs and spaces must remain
   tappable. Center the nearest legal/illegal parking target.
3. Bottom controls (64–72 px plus safe area): left/right under the left thumb,
   one large context action under the right thumb. The action changes between
   Park, Collect, Ticket, Enter, or Cross street. Put car durability and tower
   floor choice in the top strip or a compact action sheet, never between the
   thumb controls.
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

If later playtesting shows strong demand for portrait driving, make it a distinct
camera/layout mode with a shorter visible street span and one focused building,
not a scaled-down version of the landscape scene. Defer that additional mode
until the landscape controls have been tested on real phones.

## Desktop and laptop

Reference content width: 1280 px; support 1024 px wide laptop windows. Keep a
top navigation bar. Use a flexible central street canvas and a 280–320 px plot
panel only when a plot is selected. Keep the viewport aspect near 16:9 to 21:9;
letterbox the game world rather than stretching buildings. Keyboard A/D or arrow
keys drive, Space takes the context action, and clicking a building or stall
selects it. The bottom strip shows the active controls and current car status.

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
