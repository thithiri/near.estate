import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Rectangle, Text } from "pixi.js";
import {
  CarBody,
  CarColor,
  DEFAULT_CONFIG,
  IMPRESSION_RULES,
  TOWER_FLOORS,
  TOWER_SPACES_PER_FLOOR,
  formatCoins,
  grossEarnings,
  manifestHash,
  manifestHashV2,
  validateAssetManifest,
  validateAssetManifestV2,
  validateCitySeed,
  type AssetManifest,
  type AssetManifestV2,
  type NPCSite,
  type ChainStreetSide,
} from "@estate/shared";
import rawSeed from "../../../contracts/estate/seed.json";
import rawGuestSeed from "../../../contracts/estate/seed-v2.json";
import {
  cityMapCurbPoint,
  connectionAtX,
  curbDirection,
  destination,
  endConnection,
  frontageAtX,
  frontageWidth,
  frontageX,
  FRONTAGE_PITCH,
  INTERSECTION_GAP,
  intersectionX,
  roadWidth,
  type Road,
  type RoadConnection,
} from "./city-navigation.js";
import { MockGame, type MockSession } from "./mock-game.js";
import { choices, paintBuilding } from "./frontage-art.js";
import {
  choiceForGuestPlot,
  createGuestFrontage,
  type GuestFrontage,
} from "./guest-frontage.js";
import { mountGuestDesignPicker } from "./guest-design-picker.js";
import type { BuildingLevel } from "./frontage-layout.js";
import { visibleMediaHash, visibleMediaLink } from "./media-view.js";
import { plotEarningPreview, towerEarningPreview } from "./plot-earnings.js";
import { streetSceneKey } from "./street-scene-key.js";
import type { ChainScreen } from "./chain-screen.js";
import type { ChainReader } from "./chain-reader.js";
import type { LiveStreet } from "./live-street.js";
import type { GameWalletClient } from "./wallet-client.js";
import { createPresetFacade, PresetTextureCache } from "./preset-renderer.js";
import { facadePreset } from "./preset-catalog.js";
import {
  illustratedPreviewForPlot,
  illustratedPreviewForType,
} from "./illustrated-preview.js";
import { buildingShapeName } from "./building-shapes.js";
import { MockStudio, type GuestBuildingPreview } from "./studio-screen.js";
import { mountCinemaShort } from "./cinema-short.js";
import { mountPracticeCourse } from "./practice-course.js";
import { AdvertiserStatsScreen } from "./advertiser-stats.js";
import { ImpressionReporter } from "./impressions.js";
import {
  carSpriteFile,
  createCarSprite,
  createNpcFacade,
  siteSpriteFile,
} from "./world-sprites.js";
import "./style.css";

const chainCity = validateCitySeed(rawSeed);
const guestCity = validateCitySeed(rawGuestSeed);
let city = guestCity;
const game = new MockGame(city);
if (
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).has("full-curbs")
) {
  const visitor = game.sessions.get(`c:${game.ownedPlotId}:0`);
  if (!visitor) throw new Error("Full-curb preview needs its visitor session");
  for (const plot of city.plots) {
    for (let space = 0; space < game.curbCapacity(plot.id); space++) {
      game.sessions.set(`c:${plot.id}:${space}`, {
        ...visitor,
        id: `full-curbs-${plot.id}-${space}`,
        locationId: plot.id,
        space,
        driver: `visitor-${plot.id}-${space}`,
      });
    }
  }
}
const canvasHost = document.querySelector<HTMLElement>("#street-canvas")!;
const guestBuildingBanner = document.querySelector<HTMLElement>(
  "#guest-building-preview",
)!;
const guestBuildingName = document.querySelector<HTMLElement>(
  "#guest-building-preview-name",
)!;
const otherScreen = document.querySelector<HTMLElement>("#other-screen")!;
const streetScreen = document.querySelector<HTMLElement>("#street-screen")!;
const plotPanel = document.querySelector<HTMLElement>("#plot-panel")!;
const plotLinks = document.querySelector<HTMLElement>("#plot-links")!;
const status = document.querySelector<HTMLElement>("#status")!;
const actionButton = document.querySelector<HTMLButtonElement>("#action")!;
const panelAction = document.querySelector<HTMLButtonElement>("#panel-action")!;
const collectButton = document.querySelector<HTMLButtonElement>("#collect")!;
const panelCollect =
  document.querySelector<HTMLButtonElement>("#panel-collect")!;
const towerFloorWrap =
  document.querySelector<HTMLElement>("#tower-floor-wrap")!;
const towerFloorSelect =
  document.querySelector<HTMLSelectElement>("#tower-floor")!;
const contextDetailsButton =
  document.querySelector<HTMLButtonElement>("#context-details")!;
const crossSideButton =
  document.querySelector<HTMLButtonElement>("#cross-side")!;
const networkButton =
  document.querySelector<HTMLButtonElement>("#network-button")!;
const modeButton = document.querySelector<HTMLButtonElement>("#mode-button")!;
const contractId = import.meta.env.VITE_ESTATE_CONTRACT_ID?.trim();
networkButton.hidden = !contractId;
modeButton.hidden = !contractId;
let chainScreen: ChainScreen | null = null;
let liveStreet: LiveStreet | null = null;
let liveMode = false;
let liveCityVersion: 1 | 2 = 1;
let chainOwnerFocus = false;
let readerPromise: Promise<ChainReader> | null = null;
let walletPromise: Promise<GameWalletClient> | null = null;
let roadId: string = "main";
let side: "North" | "South" = "North";
type Selection =
  | { kind: "Plot"; id: string }
  | { kind: "Site"; id: string }
  | { kind: "Connection"; connection: RoadConnection }
  | { kind: "None" };
let selection: Selection = { kind: "Plot", id: "plot-main-n-0" };
let carX = 85;
let selectedTowerFloor = 0;
let moving: -1 | 0 | 1 = 0;
let driveDirection: -1 | 1 = 1;
let curbFeedbackTimer: number | null = null;
let curbCrossing: {
  elapsedMs: number;
  destination: "North" | "South";
  swapped: boolean;
} | null = null;
const CURB_CROSSING_MS = 560;
const drivePointers = new Map<
  number,
  { direction: -1 | 1; pressedAt: number }
>();
const driveKeys = new Map<string, -1 | 1>();
const DRIVE_SPEED = 100;
const driveLaneY = (direction: -1 | 1): number => (direction < 0 ? 252 : 273);
const TAP_DRIVE_DISTANCE = 18;
let currentScreen = "Street";
let garageFeedback: { message: string; error: boolean } | null = null;
const portraitDriving = window.matchMedia(
  "(max-width: 700px) and (orientation: portrait)",
);
const compactStreet = window.matchMedia("(max-width: 900px)");
status.hidden = portraitDriving.matches;

function getReader(): Promise<ChainReader> {
  if (!contractId)
    return Promise.reject(new Error("No testnet contract configured"));
  readerPromise ??= import("./chain-reader.js").then(
    ({ ChainReader }) => new ChainReader(contractId),
  );
  return readerPromise;
}

function getWalletClient(): Promise<GameWalletClient> {
  walletPromise ??= Promise.all([getReader(), import("./wallet-client.js")])
    .then(([reader, { GameWalletClient }]) => GameWalletClient.create(reader))
    .catch((error) => {
      walletPromise = null;
      throw error;
    });
  return walletPromise;
}
let activeSiteId: string | null = null;
let burgerVisits = 0;
let unmountCinema: (() => void) | null = null;
let unmountPractice: (() => void) | null = null;
let carSprite: Container;
let backdrop: Container;
let world: Container;
let variableFacades: Array<{
  plotId: string;
  x: number;
  width: number;
  group: GuestFrontage;
}> = [];
let renderedLiveSceneKey: string | null = null;
const facadeTextures = new PresetTextureCache();
const impressionReporter = new ImpressionReporter();
const approvedManifests = new Map<string, AssetManifest | AssetManifestV2>();
const loadingManifests = new Set<string>();
const plotPriceCache = new Map<string, { text: string; fetchedAt: number }>();
const loadingPlotPrices = new Set<string>();

function formatTestnetNear(yocto: string): string {
  const value = BigInt(yocto);
  const whole = value / 10n ** 24n;
  const fraction = (value % 10n ** 24n)
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} testnet NEAR`;
}

function requestPlotPrice(plotId: string): void {
  const cached = plotPriceCache.get(plotId);
  if (cached && Date.now() - cached.fetchedAt < 15_000) return;
  if (loadingPlotPrices.has(plotId) || !liveStreet) return;
  loadingPlotPrices.add(plotId);
  void liveStreet.reader
    .plotPurchaseBreakdown(plotId)
    .then((quote) => {
      plotPriceCache.set(plotId, {
        text: `Unowned · ${formatTestnetNear(quote.price_yocto)} + storage (${formatTestnetNear(quote.total_yocto)} total)`,
        fetchedAt: Date.now(),
      });
    })
    .catch(() => {
      plotPriceCache.set(plotId, {
        text: "Unowned · purchase price unavailable",
        fetchedAt: Date.now(),
      });
    })
    .finally(() => {
      loadingPlotPrices.delete(plotId);
      if (
        liveMode &&
        currentScreen === "Street" &&
        selection.kind === "Plot" &&
        selection.id === plotId
      )
        updatePanel();
    });
}

function requestApprovedManifest(hash: string, version: 1 | 2): void {
  if (approvedManifests.has(hash) || loadingManifests.has(hash)) return;
  loadingManifests.add(hash);
  void fetch(`/api/manifests/${hash}`)
    .then(async (response) => {
      if (!response.ok) return;
      const value: unknown = await response.json();
      const manifest =
        version === 2
          ? validateAssetManifestV2(value)
          : validateAssetManifest(value);
      const digest =
        manifest.schemaVersion === 2
          ? await manifestHashV2(manifest)
          : await manifestHash(manifest);
      if (digest !== hash)
        throw new Error("Approved facade manifest hash mismatch");
      approvedManifests.set(hash, manifest);
      if (liveMode && currentScreen === "Street") drawWorld();
    })
    .catch((error: unknown) => {
      console.warn("Approved facade unavailable", error);
    })
    .finally(() => loadingManifests.delete(hash));
}
const ownedPlot = game.plot(game.ownedPlotId);
let guestBuildingPreview: GuestBuildingPreview | null = null;
const guestDesigns = new Map<string, string>();
const guestLogos = new Map<string, ImageBitmap>();
const guestAds = new Map<string, ImageBitmap>();
const guestLevels = new Map<string, BuildingLevel>();
let designTargetId = game.ownedPlotId;
function guestLevelForPlot(plot: typeof ownedPlot): BuildingLevel {
  const selected = guestLevels.get(plot.id);
  if (selected) return selected;
  if (plot.id === game.ownedPlotId) return 1;
  const streetOrder = ["main", "market", "river", "central", "harbor"].indexOf(
    plot.roadId,
  );
  return (((plot.index + streetOrder) % 4) + 1) as BuildingLevel;
}
function updateGuestBuildingBanner(): void {
  guestBuildingBanner.hidden = liveMode || guestBuildingPreview === null;
  if (!guestBuildingPreview) return;
  guestBuildingName.textContent = `Guest look · ${guestBuildingPreview.type} ${buildingShapeName(guestBuildingPreview.type, guestBuildingPreview.variant)} · Level ${guestBuildingPreview.level}`;
}
const studio = new MockStudio(
  ownedPlot,
  [
    city.plots.find((plot) => plot.id === "plot-main-n-2")!,
    city.plots.find((plot) => plot.id === "plot-main-n-4")!,
  ],
  () => showScreen("My Plots"),
  () => currentScreen === "Studio",
  (preview) => {
    guestBuildingPreview = preview;
    const road = city.streets.find((entry) => entry.id === ownedPlot.roadId)!;
    moveToRoad(
      road.id,
      ownedPlot.side,
      frontageCenter(road, ownedPlot.index, ownedPlot.side),
    );
    showScreen("Street");
    updateGuestBuildingBanner();
  },
);
let statsInitialPlotId: string | undefined;
const statsScreen = new AdvertiserStatsScreen(
  otherScreen,
  chainCity.plots.map((plot) => ({
    id: plot.id,
    label: `${chainCity.streets.find((street) => street.id === plot.roadId)?.name ?? plot.roadId} · ${curbDirection(plot.roadId, plot.side)} · Plot ${plot.index + 1} · ${plot.initialType}`,
  })),
  Boolean(contractId),
  () => showScreen("Map"),
);

function openStats(plotId?: string): void {
  statsInitialPlotId = plotId;
  showScreen("Stats");
}

function currentRoad(): Road {
  const road = city.streets.find((entry) => entry.id === roadId);
  if (!road) throw new Error("Current street is missing");
  return road;
}

function frontageCenter(
  road: Road,
  index: number,
  frontageSide: "North" | "South",
): number {
  return (
    frontageX(road, index, frontageSide) +
    frontageWidth(road, index, frontageSide) / 2
  );
}

if (import.meta.env.DEV) {
  const previewId = new URLSearchParams(window.location.search).get(
    "preview-plot",
  );
  const preview = guestCity.plots.find((plot) => plot.id === previewId);
  if (preview) {
    roadId = preview.roadId;
    side = preview.side;
    const road = guestCity.streets.find(
      (entry) => entry.id === preview.roadId,
    )!;
    carX = frontageCenter(road, preview.index, preview.side);
    selection = { kind: "Plot", id: preview.id };
  }
}

function selectionAtCar(): Selection {
  const road = currentRoad();
  const crossing = connectionAtX(road, carX);
  if (crossing) return { kind: "Connection", connection: crossing };
  const index = frontageAtX(road, carX, side);
  const plot = city.plots.find(
    (entry) =>
      entry.roadId === roadId && entry.side === side && entry.index === index,
  );
  if (plot) return { kind: "Plot", id: plot.id };
  const site = city.npcSites.find(
    (entry) =>
      entry.roadId === roadId &&
      entry.side === side &&
      entry.frontageIndex === index,
  );
  return site ? { kind: "Site", id: site.id } : { kind: "None" };
}

function selectionKey(value: Selection): string {
  if (value.kind === "Plot" || value.kind === "Site")
    return `${value.kind}:${value.id}`;
  if (value.kind === "Connection")
    return `${value.kind}:${value.connection.toRoadId}:${value.connection.at}`;
  return "None";
}

function livePlot(id: string): ChainStreetSide["plots"][number] | undefined {
  return liveStreet?.street?.plots.find((entry) => entry.plot.plot.id === id);
}

function activeCarIsParked(): boolean {
  return liveMode
    ? liveStreet?.selectedCar?.parked_session_id !== null &&
        liveStreet?.selectedCar?.parked_session_id !== undefined
    : Boolean(game.activeCarSession());
}

function canCrossWithCar(): boolean {
  return (
    !activeCarIsParked() && (!liveMode || Boolean(liveStreet?.selectedCar))
  );
}

function oppositeSide(): "North" | "South" {
  return side === "North" ? "South" : "North";
}

function updateCrossSideControl(): void {
  const next = oppositeSide();
  const nextDirection = curbDirection(currentRoad().id, next).toLowerCase();
  const crossingWithCar = canCrossWithCar();
  for (const id of ["left", "right"])
    document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled =
      !crossingWithCar;
  crossSideButton.textContent = crossingWithCar
    ? "Cross road"
    : "View other curb";
  crossSideButton.dataset.glyph = crossingWithCar ? "↑" : "↕";
  crossSideButton.dataset.short = crossingWithCar ? "Cross" : "View";
  crossSideButton.setAttribute(
    "aria-label",
    canCrossWithCar()
      ? `Cross ${currentRoad().name} to the ${nextDirection} curb`
      : `View the ${nextDirection} curb of ${currentRoad().name}`,
  );
}

function updateGamepadAction(mode: string): void {
  let glyph = "·";
  let short = "Wait";
  if (mode.startsWith("Park")) [glyph, short] = ["P", "Park"];
  else if (mode === "Collect") [glyph, short] = ["C", "Collect"];
  else if (mode === "Settle expired") [glyph, short] = ["C", "Settle"];
  else if (mode === "Ticket") [glyph, short] = ["T", "Ticket"];
  else if (mode === "Visit") [glyph, short] = ["★", "Visit"];
  else if (mode.startsWith("Turn onto")) [glyph, short] = ["↱", "Turn"];
  else if (mode === "Set up wallet") [glyph, short] = ["◉", "Wallet"];
  else if (mode === "Repair car") [glyph, short] = ["⚙", "Repair"];
  else if (mode === "Drive closer") [glyph, short] = ["P", "Near"];
  else if (mode.includes("full")) [glyph, short] = ["P", "Full"];
  else if (mode === "Car already earning") [glyph, short] = ["P", "Busy"];
  else if (mode === "Your curb") [glyph, short] = ["P", "Owned"];
  actionButton.dataset.glyph = glyph;
  actionButton.dataset.short = short;
  actionButton.title = mode;
  actionButton.setAttribute("aria-label", mode);
}

function updateDriveInput(): void {
  if (
    currentScreen !== "Street" ||
    portraitDriving.matches ||
    curbCrossing !== null ||
    activeCarIsParked()
  ) {
    moving = 0;
    return;
  }
  const pointer = [...drivePointers.values()].at(-1);
  const key = [...driveKeys.values()].at(-1);
  moving = pointer?.direction ?? key ?? 0;
  if (moving) driveDirection = moving;
}

function resetDriveInput(): void {
  drivePointers.clear();
  driveKeys.clear();
  moving = 0;
}

function openPlotPanel(): void {
  plotPanel.classList.remove("closed");
  if (compactStreet.matches && !portraitDriving.matches) {
    plotPanel.classList.add("mobile-open");
    contextDetailsButton.setAttribute("aria-expanded", "true");
  }
}

function closePlotPanelForDriving(): void {
  if (!compactStreet.matches || !plotPanel.classList.contains("mobile-open"))
    return;
  plotPanel.classList.remove("mobile-open");
  contextDetailsButton.setAttribute("aria-expanded", "false");
}

function moveToRoad(
  nextRoadId: string,
  nextSide: "North" | "South",
  x: number,
): void {
  curbCrossing = null;
  crossSideButton.disabled = false;
  roadId = nextRoadId;
  side = nextSide;
  carX = x;
  moving = 0;
  selection = selectionAtCar();
  drawWorld();
  updatePanel();
  if (liveMode) void liveStreet?.refresh();
}

function followConnection(connection: RoadConnection): void {
  const next = destination(city, connection);
  moveToRoad(next.roadId, next.side, next.x);
  status.textContent = `Now on ${currentRoad().name}.`;
}

function showCurb(destination: "North" | "South"): void {
  side = destination;
  selection = selectionAtCar();
  drawWorld();
  updatePanel();
  if (liveMode) void liveStreet?.refresh();
}

function announceCurb(crossingWithCar: boolean): void {
  const direction = curbDirection(currentRoad().id, side).toLowerCase();
  const message = crossingWithCar
    ? `Now on the ${direction} curb · directly across`
    : `Viewing the ${direction} curb${activeCarIsParked() ? " · car still parked" : ""}`;
  status.classList.add("curb-feedback");
  status.classList.toggle("viewing-curb", !crossingWithCar);
  status.textContent = message;
  if (curbFeedbackTimer !== null) window.clearTimeout(curbFeedbackTimer);
  curbFeedbackTimer = window.setTimeout(() => {
    if (status.textContent === message) status.textContent = "";
    status.classList.remove("curb-feedback", "viewing-curb");
    curbFeedbackTimer = null;
  }, 2_000);
}

function completeCurbCrossing(): void {
  const crossing = curbCrossing;
  if (!crossing) return;
  curbCrossing = null;
  if (!crossing.swapped) showCurb(crossing.destination);
  crossSideButton.disabled = false;
  carSprite.y = driveLaneY(driveDirection);
  carSprite.alpha = 1;
  announceCurb(true);
}

function crossStreet(): void {
  if (curbCrossing) return;
  const crossingWithCar = canCrossWithCar();
  const destination = oppositeSide();
  resetDriveInput();
  if (
    crossingWithCar &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    if (curbFeedbackTimer !== null) {
      window.clearTimeout(curbFeedbackTimer);
      curbFeedbackTimer = null;
    }
    curbCrossing = { elapsedMs: 0, destination, swapped: false };
    crossSideButton.disabled = true;
    status.classList.add("curb-feedback");
    status.classList.remove("viewing-curb");
    status.textContent = `Crossing to the ${curbDirection(currentRoad().id, destination).toLowerCase()} curb…`;
    return;
  }
  showCurb(destination);
  announceCurb(crossingWithCar);
}

function parkedLocation(
  session: Pick<MockSession, "facility" | "locationId">,
): {
  roadId: string;
  side: "North" | "South";
  x: number;
} {
  const frontage =
    session.facility === "Curb"
      ? city.plots.find((entry) => entry.id === session.locationId)
      : city.npcSites.find((entry) => entry.id === session.locationId);
  if (!frontage) throw new Error("Parked location is missing from the city");
  const road = city.streets.find((entry) => entry.id === frontage.roadId);
  if (!road) throw new Error("Parked street is missing from the city");
  const index = "index" in frontage ? frontage.index : frontage.frontageIndex;
  return {
    roadId: frontage.roadId,
    side: frontage.side,
    x: frontageCenter(road, index, frontage.side),
  };
}

function restoreCarToSession(
  session: Pick<MockSession, "facility" | "locationId">,
): void {
  const parked = parkedLocation(session);
  roadId = parked.roadId;
  side = parked.side;
  carX = parked.x;
  selection = selectionAtCar();
  moving = 0;
}

function label(text: string, size = 12, color = "#14213d"): Text {
  return new Text({
    text,
    style: {
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontWeight: "700",
      fontSize: size,
      fill: color,
      align: "center",
    },
  });
}

function guestBurgerBillboard(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Container {
  const board = new Container();
  const art = new Graphics()
    .roundRect(rect.x, rect.y, rect.width, rect.height, 2)
    .fill(0x17384a)
    .stroke({ color: 0xffd34f, width: 1.5 })
    .moveTo(rect.x + 5, rect.y + 11)
    .arc(rect.x + 11, rect.y + 11, 6, Math.PI, 0)
    .fill(0xffca57)
    .roundRect(rect.x + 5, rect.y + 13, 12, 2, 1)
    .fill(0x8bc56b)
    .roundRect(rect.x + 5, rect.y + 16, 12, 3, 1)
    .fill(0xe89449);
  const brand = label("N&F", 10, "#fff5d8");
  brand.position.set(rect.x + 21, rect.y + 3);
  const product = label("BURGERS", 4, "#ffcf59");
  product.position.set(rect.x + 21, rect.y + 15);
  board.addChild(art, brand, product);
  return board;
}

function intersectionSign(road: Road, connection: RoadConnection): Container {
  const start = intersectionX(road, connection);
  const center = start + INTERSECTION_GAP / 2;
  const destinationName =
    city.streets.find((entry) => entry.id === connection.toRoadId)?.name ??
    connection.toRoadId;
  const group = new Container();
  const graphic = new Graphics()
    .rect(start, 170, INTERSECTION_GAP, 36)
    .fill(0xc5d4c6)
    .rect(start, 206, INTERSECTION_GAP, 84)
    .fill(0x536475)
    .rect(start, 290, INTERSECTION_GAP, 10)
    .fill(0x487c5d)
    .rect(start + 2, 192, 16, 12)
    .fill(0xe2ca78)
    .rect(start + INTERSECTION_GAP - 18, 192, 16, 12)
    .fill(0xe2ca78)
    .rect(center - 2, 193, 4, 14)
    .fill(0x596a6a)
    .rect(center - 3, 204, 6, 4)
    .fill(0x344d57)
    .roundRect(start + 2, 174, INTERSECTION_GAP - 4, 20, 3)
    .fill(0x176a58)
    .stroke({ color: 0xf4f8eb, width: 2 })
    .roundRect(start + 5, 177, INTERSECTION_GAP - 10, 14, 1)
    .stroke({ color: 0xcce9d8, width: 1 });
  for (let stripe = 0; stripe < 5; stripe++) {
    graphic.rect(start + 6 + stripe * 14, 252, 8, 33).fill(0xfff7df);
  }
  graphic
    .rect(start + 3, 246, INTERSECTION_GAP - 6, 2)
    .fill(0xfff7df)
    .rect(start + 3, 287, INTERSECTION_GAP - 6, 2)
    .fill(0xfff7df);
  const shortName = destinationName
    .replace(/ Street$/i, " St")
    .replace(/ Avenue$/i, " Ave");
  const signText = label(`↗ ${shortName.toUpperCase()}`, 7, "#ffffff");
  signText.anchor.set(0.5);
  signText.position.set(center, 184);
  group.addChild(graphic, signText);
  group.hitArea = new Rectangle(start, 170, INTERSECTION_GAP, 37);
  group.eventMode = "static";
  group.cursor = "pointer";
  group.on("pointertap", () =>
    requestAnimationFrame(() => followConnection(connection)),
  );
  return group;
}

function endSign(road: Road, connection: RoadConnection): Container {
  const left = connection.at === 0;
  const x = left ? 4 : roadWidth(road) - 110;
  const destinationName =
    city.streets.find((entry) => entry.id === connection.toRoadId)?.name ??
    connection.toRoadId;
  const group = new Container();
  const board = new Graphics()
    .rect(x + 51, 206, 4, 11)
    .fill(0x596a6a)
    .roundRect(x, 190, 106, 17, 3)
    .fill(0x176a58)
    .stroke({ color: 0xf4f8eb, width: 2 })
    .roundRect(x + 4, 193, 98, 11, 1)
    .stroke({ color: 0xcce9d8, width: 1 });
  const text = label(
    `${left ? "←" : "→"} ${destinationName.toUpperCase()}`,
    8,
    "#ffffff",
  );
  text.anchor.set(0.5);
  text.position.set(x + 53, 199);
  group.addChild(board, text);
  group.hitArea = new Rectangle(x, 190, 106, 28);
  group.eventMode = "static";
  group.cursor = "pointer";
  group.on("pointertap", () =>
    requestAnimationFrame(() => followConnection(connection)),
  );
  return group;
}

function drawBackdrop(road: Road): void {
  backdrop.removeChildren().forEach((child) => child.destroy());
  const width = roadWidth(road) + 400;
  const sky = new Graphics()
    .rect(0, 0, width, 190)
    .fill(0x96dafa)
    .circle(280, 36, 18)
    .fill(0xffebae)
    .ellipse(620, 54, 29, 8)
    .fill(0xf2fcff)
    .ellipse(1010, 30, 33, 9)
    .fill(0xf2fcff);
  for (let x = -70, index = 0; x < width; x += 110, index++) {
    const height = 30 + (index % 4) * 8;
    sky
      .rect(x, 170 - height, 82, height + 20)
      .fill(index % 2 === 0 ? 0xc5dcd8 : 0xd5e1db);
    sky
      .poly([x - 5, 170 - height, x + 41, 154 - height, x + 87, 170 - height])
      .fill(index % 2 === 0 ? 0xa6c9c4 : 0xb8d2ca);
    sky.rect(x + 14, 174 - height, 12, 13).fill(0xe9f3ef);
    sky.rect(x + 55, 174 - height, 12, 13).fill(0xe9f3ef);
  }
  backdrop.addChild(sky);
}

function liveSceneKey(): string {
  return streetSceneKey({
    roadId,
    side,
    street: liveStreet?.street ?? null,
    car: liveStreet?.selectedCar,
    session: liveStreet?.activeSession,
    burgerDecal: Boolean(liveStreet?.player?.account?.burger_decal),
    nowSeconds: Math.floor(Date.now() / 1_000),
  });
}

function drawWorld(): void {
  facadeTextures.setViews([]);
  variableFacades = [];
  world.removeChildren().forEach((child) => child.destroy({ children: true }));
  const road = currentRoad();
  drawBackdrop(road);
  const width = roadWidth(road);
  const base = new Graphics();
  base.rect(0, 170, width, 20).fill(0xa8d9a1);
  base.rect(0, 190, width, 16).fill(0xe9dfcf);
  base.rect(0, 203, width, 3).fill(0xc0b6a8);
  base.rect(0, 206, width, 40).fill(0x718292);
  base.rect(0, 206, width, 3).fill(0xe9d8b7);
  base.rect(0, 244, width, 2).fill(0xc8d2d2);
  base.rect(0, 246, width, 44).fill(0x526475);
  base.rect(0, 290, width, 10).fill(0x487c5d);
  for (let x = 0; x < width; x += 34) {
    base.moveTo(x, 191).lineTo(x, 202).stroke({ color: 0xcac1b3, width: 1 });
  }
  for (let x = 0; x < width; x += 170) {
    base.roundRect(x + 75, 198, 19, 5, 1).fill(0x6d7b7f);
    for (let slit = 0; slit < 3; slit++)
      base.rect(x + 78 + slit * 5, 199, 2, 3).fill(0xa7b3ae);
  }
  for (let x = 0; x < width; x += 62)
    base.roundRect(x + 8, 267, 30, 3, 1).fill(0xfff7df);
  world.addChild(base);
  for (const connection of road.connections) {
    if (connection.kind === "Intersection") {
      world.addChild(intersectionSign(road, connection));
    }
  }
  const facades = [];
  const chainSide =
    liveMode &&
    liveStreet?.street?.road_id === roadId &&
    liveStreet.street.side === side
      ? liveStreet.street
      : null;
  const plots = city.plots.filter(
    (plot) =>
      plot.roadId === roadId &&
      plot.side === side &&
      (!liveMode ||
        chainSide?.plots.some((entry) => entry.plot.plot.id === plot.id)),
  );
  const deedEdges = new Set<number>();
  for (const plot of plots) {
    const x = frontageX(road, plot.index, side);
    deedEdges.add(x);
    deedEdges.add(x + frontageWidth(road, plot.index, side));
  }
  const deedSeams = new Graphics();
  deedSeams.eventMode = "none";
  for (const edge of deedEdges) {
    deedSeams
      .moveTo(edge, 190)
      .lineTo(edge, 205)
      .stroke({ color: 0x9b8e7d, width: 1.5 })
      .roundRect(edge - 2, 204, 4, 3, 1)
      .fill(0x607470);
  }
  world.addChild(deedSeams);
  for (const plot of plots) {
    const chainEntry = chainSide?.plots.find(
      (entry) => entry.plot.plot.id === plot.id,
    );
    const building = chainEntry?.plot.plot.building;
    const approvedHash = building?.approved_manifest_hash;
    if (approvedHash) requestApprovedManifest(approvedHash, liveCityVersion);
    const approvedManifest = approvedHash
      ? approvedManifests.get(approvedHash)
      : undefined;
    const x = frontageX(road, plot.index, side);
    const guestOwned = !liveMode && plot.id === game.ownedPlotId;
    const guestLook = guestOwned ? guestBuildingPreview : null;
    const renderedPlot = guestLook
      ? {
          ...plot,
          initialType: guestLook.type,
          initialVariant: guestLook.variant,
        }
      : building
        ? {
            ...plot,
            initialType: building.building_type,
            initialVariant: building.variant,
          }
        : plot;
    const illustratedPreview = liveMode
      ? null
      : guestOwned
        ? illustratedPreviewForType(
            renderedPlot.initialType,
            renderedPlot.initialVariant as 1 | 2,
            guestLook?.level ?? 1,
          )
        : illustratedPreviewForPlot(plot);
    const openThisPlot = () => {
      selection = { kind: "Plot", id: plot.id };
      openPlotPanel();
      updatePanel();
    };
    if ((!liveMode && !guestLook) || (liveMode && liveCityVersion === 2)) {
      const chainPlot = chainEntry?.plot.plot;
      const choice = liveMode
        ? choices.filter((item) => item.units === plot.frontageUnits)[
            chainPlot && "design_choice" in chainPlot
              ? chainPlot.design_choice
              : -1
          ]
        : choiceForGuestPlot(plot, guestDesigns.get(plot.id));
      if (!choice) throw new Error(`No building design fits ${plot.id}`);
      const customFacadeHash =
        liveMode &&
        approvedManifest?.schemaVersion === 2 &&
        chainPlot &&
        "design_choice" in chainPlot &&
        approvedManifest.frontageUnits === chainPlot.frontage_units &&
        approvedManifest.designChoice === chainPlot.design_choice &&
        approvedManifest.buildingType === building?.building_type &&
        approvedManifest.level === building.level
          ? approvedManifest.spriteHash
          : undefined;
      const sprite = createGuestFrontage(
        choice,
        x,
        liveMode ? (building?.level as BuildingLevel) : guestLevelForPlot(plot),
        liveMode ? null : guestLogos.get(plot.id),
        liveMode ? building?.name : undefined,
        liveMode && chainEntry && building
          ? {
              logoHash: visibleMediaHash(
                chainEntry.plot.plot.logo,
                chainEntry.plot.logo_eligible,
                building.layout_revision,
              ),
              billboardHash: visibleMediaHash(
                chainEntry.plot.plot.billboard,
                chainEntry.plot.billboard_eligible,
                building.layout_revision,
              ),
            }
          : undefined,
        customFacadeHash,
        liveMode ? null : (guestAds.get(plot.id) ?? null),
      );
      sprite.eventMode = "static";
      sprite.cursor = "pointer";
      sprite.on("pointertap", openThisPlot);
      world.addChild(sprite);
      if (liveMode)
        variableFacades.push({
          plotId: plot.id,
          x,
          width: choice.units * 85,
          group: sprite,
        });
    } else {
      const facade = createPresetFacade(
        renderedPlot,
        x,
        building
          ? {
              level: building.level,
              palette: building.primary_color,
              name: building.name,
              approvedManifest:
                approvedManifest?.schemaVersion === 1 &&
                approvedManifest.buildingType === building.building_type &&
                approvedManifest.level === building.level
                  ? approvedManifest
                  : undefined,
              logoAssetHash: chainEntry
                ? visibleMediaHash(
                    chainEntry.plot.plot.logo,
                    chainEntry.plot.logo_eligible,
                    building.layout_revision,
                  )
                : undefined,
              billboardAssetHash: chainEntry
                ? visibleMediaHash(
                    chainEntry.plot.plot.billboard,
                    chainEntry.plot.billboard_eligible,
                    building.layout_revision,
                  )
                : undefined,
            }
          : guestOwned
            ? { level: guestLook?.level ?? 1, palette: "#F6C85F" }
            : undefined,
        illustratedPreview,
      );
      if (!liveMode && plot.id === "plot-main-n-2") {
        const previewLevel = (plot.index % 4) + 1;
        const rect =
          illustratedPreview?.billboardRect ??
          facadePreset(plot.initialType, plot.initialVariant, previewLevel)
            .billboardRect;
        if (rect) facade.group.addChild(guestBurgerBillboard(rect));
      }
      facade.group.eventMode = "static";
      facade.group.cursor = "pointer";
      facade.group.on("pointertap", openThisPlot);
      world.addChild(facade.group);
      facades.push(facade);
    }
    const stalls = new Graphics();
    const stallLabels: Text[] = [];
    const stallHitTargets: Graphics[] = [];
    const parkedSprites: Container[] = [];
    const capacity = liveMode
      ? (chainEntry?.slots.length ?? 0)
      : game.curbCapacity(plot.id);
    const ruleKind = liveMode
      ? (chainEntry?.plot.effective_rule.kind ?? "Free")
      : (game.rules.get(plot.id) ?? "Free");
    const stallMark =
      ruleKind === "NoParking"
        ? "NO P"
        : ruleKind === "Meter"
          ? "METER"
          : ruleKind === "ColorOnly"
            ? "COLOR"
            : "FREE";
    const stallMarkColor =
      ruleKind === "NoParking"
        ? 0xa9474b
        : ruleKind === "Meter"
          ? 0x9b7230
          : ruleKind === "ColorOnly"
            ? 0x65588d
            : 0x266d70;
    for (let slot = 0; slot < capacity; slot++) {
      const sx = x + 10 + slot * 85;
      stalls
        .moveTo(sx, 211)
        .lineTo(sx, 241)
        .lineTo(sx + 64, 241)
        .lineTo(sx + 64, 211)
        .stroke({ color: 0xf6f5e7, width: 2 });
      stalls.rect(sx + 10, 213, 44, 3).fill(0x596e7d);
      const currentSession = liveMode
        ? chainEntry?.slots[slot]
        : game.sessions.get(`c:${plot.id}:${slot}`);
      const parked =
        currentSession &&
        ("expires_at" in currentSession
          ? Math.floor(Date.now() / 1000) < currentSession.expires_at
          : game.nowSeconds() < currentSession.expiresAt)
          ? currentSession
          : null;
      if (!parked) {
        stalls
          .roundRect(sx + 7, 213, 50, 11, 2)
          .fill(stallMarkColor)
          .rect(sx + 24, 228, 16, 2)
          .fill(0xd1e3dc);
        if (ruleKind === "NoParking")
          for (let stripe = 0; stripe < 3; stripe++)
            stalls
              .moveTo(sx + 15 + stripe * 15, 235)
              .lineTo(sx + 22 + stripe * 15, 228)
              .stroke({ color: 0xe7b0a5, width: 2 });
        const text = label(stallMark, 7, "#ffffff");
        text.anchor.set(0.5);
        text.position.set(sx + 32, 218.5);
        stallLabels.push(text);
      }
      if (parked) {
        const isCurrent = liveMode
          ? parked.driver === liveStreet?.accountId
          : parked.driver === "guest";
        const parkedCar =
          "car_id" in parked
            ? (chainEntry?.car_appearances?.[slot] ??
              (isCurrent
                ? liveStreet?.player?.cars.find(
                    (car) => car.id === parked.car_id,
                  )
                : null))
            : game.cars.find((car) => car.id === parked.carId);
        const parkedSprite = createCarSprite(
          sx + 32,
          224,
          parkedCar?.body ?? (liveMode ? "Sedan" : "SportsCoupe"),
          parkedCar?.color ?? "Blue",
          isCurrent &&
            (liveMode
              ? Boolean(liveStreet?.player?.account?.burger_decal)
              : game.burgerDecal),
        );
        parkedSprite.eventMode = "none";
        parkedSprites.push(parkedSprite);
      }
      const stallHit = new Graphics()
        .rect(sx, 200, 64, 49)
        .fill({ color: 0xffffff, alpha: 0.001 });
      stallHit.eventMode = "static";
      stallHit.cursor = "pointer";
      stallHit.on("pointertap", () => {
        selection = { kind: "Plot", id: plot.id };
        updatePanel();
        if (
          parked ||
          (liveMode
            ? Boolean(
                liveStreet?.accountId &&
                  chainEntry?.plot.plot.owner === liveStreet.accountId,
              )
            : plot.id === game.ownedPlotId)
        ) {
          openPlotPanel();
          return;
        }
        action(slot);
      });
      stallHitTargets.push(stallHit);
    }
    stalls.eventMode = "none";
    world.addChild(
      stalls,
      ...stallLabels,
      ...parkedSprites,
      ...stallHitTargets,
    );
  }
  facadeTextures.setViews(facades);
  for (const site of city.npcSites.filter(
    (entry) => entry.roadId === roadId && entry.side === side,
  )) {
    const x = frontageX(road, site.frontageIndex, side);
    const frontage = createNpcFacade(site.name, site.role, x);
    frontage.eventMode = "static";
    frontage.cursor = "pointer";
    frontage.on("pointertap", () => {
      selection = { kind: "Site", id: site.id };
      updatePanel();
    });
    world.addChild(frontage);
    const towerSession = liveMode
      ? liveStreet?.activeSession?.facility === "Tower" &&
        liveStreet.activeSession.location_id === site.id
        ? liveStreet.activeSession
        : null
      : game.playerSession()?.facility === "Tower" &&
          game.playerSession()?.locationId === site.id
        ? game.playerSession()
        : null;
    if (towerSession) {
      const parkedCar =
        "car_id" in towerSession
          ? liveStreet?.player?.cars.find(
              (car) => car.id === towerSession.car_id,
            )
          : game.cars.find((car) => car.id === towerSession.carId);
      if (parkedCar)
        world.addChild(
          createCarSprite(
            x + 85,
            224,
            parkedCar.body,
            parkedCar.color,
            liveMode
              ? Boolean(liveStreet?.player?.account?.burger_decal)
              : game.burgerDecal,
          ),
        );
    }
  }
  for (const connection of road.connections) {
    if (connection.kind === "End") world.addChild(endSign(road, connection));
  }
  carSprite = createCarSprite(
    carX,
    driveLaneY(driveDirection),
    liveMode ? (liveStreet?.selectedCar?.body ?? "Hatchback") : game.car.body,
    liveMode ? (liveStreet?.selectedCar?.color ?? "Red") : game.car.color,
    liveMode
      ? Boolean(liveStreet?.player?.account?.burger_decal)
      : game.burgerDecal,
  );
  carSprite.scale.x = driveDirection;
  carSprite.visible = liveMode
    ? Boolean(liveStreet?.selectedCar) && !activeCarIsParked()
    : !game.activeCarSession();
  world.addChild(carSprite);
  document.querySelector<HTMLElement>("#street-name")!.textContent = road.name;
  document.querySelector<HTMLElement>("#mobile-street-name")!.textContent =
    `${road.name} · ${curbDirection(road.id, side)} curb`;
  document.querySelector<HTMLElement>("#street-side")!.textContent =
    `${curbDirection(road.id, side)} curb`;
  updateCrossSideControl();
  renderedLiveSceneKey = liveMode ? liveSceneKey() : null;
}

function showTowerFloorControl(floors: number[]): void {
  towerFloorWrap.hidden = false;
  towerFloorSelect.disabled = false;
  towerFloorSelect.value = String(selectedTowerFloor);
  for (let floor = 0; floor < TOWER_FLOORS; floor++) {
    const option = towerFloorSelect.options[floor];
    if (option)
      option.textContent = `${floor + 1} · ${floors[floor] ?? "?"}/${TOWER_SPACES_PER_FLOOR}`;
  }
}

type TowerPanelSpace = {
  occupied: boolean;
  mine: boolean;
  expiresAt: number | null;
};
type TowerPanel = {
  siteId: string;
  floor: number;
  spaces: TowerPanelSpace[] | null;
  error?: string;
};
let towerPanelSignature = "";

function renderTowerPanel(panel: TowerPanel | null): void {
  const host = document.querySelector<HTMLElement>("#tower-spaces")!;
  plotPanel.classList.toggle("tower-panel-open", Boolean(panel));
  if (!panel) {
    host.hidden = true;
    contextDetailsButton.hidden = selection.kind !== "Plot";
    contextDetailsButton.textContent = "Details";
    if (contextDetailsButton.hidden) plotPanel.classList.remove("mobile-open");
    contextDetailsButton.setAttribute(
      "aria-expanded",
      String(
        !contextDetailsButton.hidden &&
          !plotPanel.classList.contains("closed") &&
          plotPanel.classList.contains("mobile-open"),
      ),
    );
    towerPanelSignature = "";
    return;
  }
  host.hidden = false;
  contextDetailsButton.hidden = false;
  contextDetailsButton.textContent = "Spaces";
  contextDetailsButton.setAttribute(
    "aria-expanded",
    String(
      !plotPanel.classList.contains("closed") &&
        (window.innerWidth > 900 ||
          plotPanel.classList.contains("mobile-open")),
    ),
  );
  const signature = JSON.stringify(panel);
  if (signature === towerPanelSignature) return;
  towerPanelSignature = signature;
  const title = document.createElement("h3");
  title.textContent = `Floor ${panel.floor + 1} spaces`;
  if (!panel.spaces) {
    const status = document.createElement("p");
    status.textContent = panel.error
      ? `Space list unavailable: ${panel.error}`
      : "Loading floor spaces…";
    host.replaceChildren(title, status);
    return;
  }
  const list = document.createElement("div");
  list.className = "tower-panel-list";
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", title.textContent);
  for (const [offset, entry] of panel.spaces.entries()) {
    const item = document.createElement("div");
    item.className = `tower-space ${entry.occupied ? "occupied" : ""}`;
    item.setAttribute("role", "listitem");
    const number = document.createElement("strong");
    number.textContent = `Space ${panel.floor * TOWER_SPACES_PER_FLOOR + offset + 1}`;
    const state = document.createElement("span");
    state.textContent = entry.occupied
      ? entry.mine
        ? "Your car"
        : "Occupied"
      : "Free";
    item.append(number, state);
    if (entry.occupied && entry.expiresAt !== null) {
      const time = document.createElement("time");
      const expires = new Date(entry.expiresAt * 1000);
      time.dateTime = expires.toISOString();
      time.textContent = `Until ${expires.toLocaleTimeString()}`;
      item.append(time);
    }
    list.append(item);
  }
  host.replaceChildren(title, list);
}

function renderPlotLinks(logo?: string, billboard?: string): void {
  const links = [
    ["Open building website", logo],
    ["Open billboard website", billboard],
  ] as const;
  const anchors = links
    .filter(([, url]) => Boolean(url))
    .map(([label, url]) => {
      const anchor = document.createElement("a");
      anchor.href = url!;
      anchor.textContent = `${label} ↗`;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.referrerPolicy = "no-referrer";
      return anchor;
    });
  plotLinks.replaceChildren(...anchors);
  plotLinks.hidden = anchors.length === 0;
}

function updatePanel(): void {
  updateCrossSideControl();
  if (liveMode) {
    updateLivePanel();
    return;
  }
  document.querySelector<HTMLElement>(".guest")!.textContent = "Guest preview";
  renderPlotLinks();
  document.querySelector<HTMLElement>("#plot-panel small")!.textContent =
    "Guest preview — shared state requires a wallet.";
  const activeSession = game.playerSession();
  if (game.activeCarSession()) moving = 0;
  document.querySelector<HTMLButtonElement>("#left")!.disabled =
    !!game.activeCarSession();
  document.querySelector<HTMLButtonElement>("#right")!.disabled =
    !!game.activeCarSession();
  const target = selection;
  let title = currentRoad().name;
  let rule = "Keep driving to explore";
  let rate = "";
  let spaces = "";
  let ownerPrice = "";
  let mode = "Keep driving";
  let enabled = false;
  let towerPanel: TowerPanel | null = null;
  towerFloorWrap.hidden = true;

  if (target.kind === "Connection") {
    const next = city.streets.find(
      (entry) => entry.id === target.connection.toRoadId,
    );
    title = `Turn onto ${next?.name ?? target.connection.toRoadId}`;
    rule = "Turn at this intersection";
    mode = `Turn onto ${next?.name ?? "street"}`;
    enabled = true;
  } else if (target.kind === "Site") {
    const site = city.npcSites.find((entry) => entry.id === target.id);
    if (site) {
      if (site.role === "ParkingTower")
        showTowerFloorControl(game.towerFloorAvailability(site.id));
      title = site.name;
      rule =
        site.role === "ParkingTower"
          ? "Game-owned · always legal"
          : "Game-owned destination";
      rate =
        site.role === "ParkingTower"
          ? `New park: ${formatCoins(
              grossEarnings(
                DEFAULT_CONFIG,
                game.car.tier,
                true,
                true,
                DEFAULT_CONFIG.earnCapSeconds,
              ).toString(),
            )} coins / ${DEFAULT_CONFIG.earnCapSeconds / 60}m cap`
          : site.role;
      const towerOpen =
        site.role === "ParkingTower" ? game.towerAvailability(site.id) : 0;
      spaces =
        site.role === "ParkingTower"
          ? `${towerOpen} of ${site.capacity} spaces free · floor ${selectedTowerFloor + 1}: ${game.towerFloorAvailability(site.id)[selectedTowerFloor]} free`
          : "No earning parking here";
      if (site.role === "ParkingTower")
        towerPanel = {
          siteId: site.id,
          floor: selectedTowerFloor,
          spaces: game
            .towerFloorSessions(site.id, selectedTowerFloor)
            .map((entry) => ({
              occupied: Boolean(entry),
              mine: entry?.driver === "guest",
              expiresAt: entry?.expiresAt ?? null,
            })),
        };
      const nearby =
        Math.abs(
          carX - frontageCenter(currentRoad(), site.frontageIndex, side),
        ) <= 100;
      if (!nearby) mode = "Drive closer";
      else if (site.role !== "ParkingTower") mode = "Visit";
      else if (activeSession) mode = "Car already earning";
      else if (towerOpen === 0) mode = "Tower full";
      else if (game.towerFloorAvailability(site.id)[selectedTowerFloor] === 0)
        mode = "Floor full";
      else if (game.car.durability < DEFAULT_CONFIG.parkDurabilityCost)
        mode = "Repair car";
      else mode = "Park in tower";
      enabled = nearby && ["Visit", "Park in tower"].includes(mode);
    }
  } else if (target.kind === "Plot") {
    const plot = game.plot(target.id);
    const guestChoice = choiceForGuestPlot(plot, guestDesigns.get(plot.id));
    title = `${plot.id === game.ownedPlotId && guestBuildingPreview ? guestBuildingPreview.type : guestChoice.name} · Plot ${plot.index + 1} · ${game.curbCapacity(plot.id)} ${game.curbCapacity(plot.id) === 1 ? "unit" : "units"} · Level ${guestLevelForPlot(plot)}`;
    rule =
      game.rules.get(plot.id) === "NoParking"
        ? "No parking · owner can ticket"
        : "Free parking";
    const legal = game.rules.get(plot.id) !== "NoParking";
    rate = `New park: ${formatCoins(
      grossEarnings(
        DEFAULT_CONFIG,
        game.car.tier,
        legal,
        false,
        DEFAULT_CONFIG.earnCapSeconds,
      ).toString(),
    )} coins / ${DEFAULT_CONFIG.earnCapSeconds / 60}m cap${legal ? "" : " · ticket risk"}`;
    ownerPrice =
      plot.id === game.ownedPlotId
        ? "Owner: you (preview)"
        : `Unowned · preview price ${formatTestnetNear(
            (
              (BigInt(DEFAULT_CONFIG.plotBasePriceYocto) *
                BigInt(plot.corner ? DEFAULT_CONFIG.cornerPriceBps : 10_000)) /
              10_000n
            ).toString(),
          )} + storage`;
    const curbOpen = game.curbAvailability(plot.id);
    spaces = `${curbOpen} of ${game.curbCapacity(plot.id)} ${game.curbCapacity(plot.id) === 1 ? "space" : "spaces"} free`;
    const nearby =
      Math.abs(carX - frontageCenter(currentRoad(), plot.index, side)) <= 100;
    const ticketable =
      plot.id === game.ownedPlotId &&
      [...game.sessions.values()].some(
        (entry) =>
          entry.locationId === plot.id &&
          !entry.legal &&
          entry.driver !== "guest" &&
          game.nowSeconds() < entry.expiresAt,
      );
    if (!nearby) mode = "Drive closer";
    else if (ticketable) mode = "Ticket";
    else if (plot.id === game.ownedPlotId) mode = "Your curb";
    else if (activeSession) mode = "Car already earning";
    else if (curbOpen === 0) mode = "Spaces full";
    else if (game.car.durability < DEFAULT_CONFIG.parkDurabilityCost)
      mode = "Repair car";
    else mode = "Park here";
    enabled = nearby && ["Ticket", "Park here"].includes(mode);
  }
  document.querySelector<HTMLElement>("#plot-title")!.textContent = title;
  document.querySelector<HTMLElement>("#plot-rule")!.textContent = rule;
  document.querySelector<HTMLElement>("#plot-rate")!.textContent = rate;
  const ownerPriceLine =
    document.querySelector<HTMLElement>("#plot-owner-price")!;
  ownerPriceLine.textContent = ownerPrice;
  ownerPriceLine.hidden = !ownerPrice;
  document.querySelector<HTMLElement>("#plot-spaces")!.textContent = spaces;
  document.querySelector<HTMLButtonElement>("#panel-design")!.hidden =
    target.kind !== "Plot";
  renderTowerPanel(towerPanel);
  document.querySelector<HTMLElement>("#balance")!.textContent = formatCoins(
    game.balance.toString(),
  );
  document.querySelector<HTMLElement>("#durability")!.textContent =
    `🔧 ${game.car.durability}%`;
  document.querySelector<HTMLElement>("#car-name")!.textContent =
    `${game.car.body} · Tier ${game.car.tier}`;
  document.querySelector<HTMLElement>("#mobile-car-chip")!.textContent =
    `🚗 ${game.car.body}`;
  const controllerCollect = Boolean(activeSession) && !enabled;
  const controllerMode =
    controllerCollect && activeSession
      ? game.nowSeconds() >= activeSession.expiresAt
        ? "Settle expired"
        : "Collect"
      : mode;
  actionButton.textContent = controllerMode;
  actionButton.dataset.command = controllerCollect ? "collect" : "context";
  updateGamepadAction(controllerMode);
  panelAction.textContent = mode;
  actionButton.disabled = controllerCollect ? false : !enabled;
  panelAction.disabled = !enabled;
  collectButton.hidden = !activeSession;
  panelCollect.hidden = !activeSession;
  collectButton.disabled = false;
  panelCollect.disabled = false;
  if (activeSession) {
    const collectLabel =
      game.nowSeconds() >= activeSession.expiresAt
        ? "Settle expired"
        : "Collect parked car";
    collectButton.textContent = collectLabel;
    panelCollect.textContent = collectLabel;
  }
}

function updateLivePanel(): void {
  document.querySelector<HTMLButtonElement>("#panel-design")!.hidden = true;
  const live = liveStreet;
  const car = live?.selectedCar;
  const session = live?.activeSession;
  const now = Math.floor(Date.now() / 1000);
  const keyReady = live?.keyStatus === "ready";
  const registered = Boolean(live?.player?.account);
  const ready = live?.street?.road_id === roadId && live.street.side === side;
  renderPlotLinks();
  document.querySelector<HTMLElement>(".guest")!.textContent = "Testnet";
  document.querySelector<HTMLElement>("#plot-panel small")!.textContent =
    "Shared testnet state · confirmed chain reads.";
  if (live?.error) status.textContent = live.error;
  else if (
    ready &&
    (status.textContent === "Loading shared testnet street…" ||
      status.textContent?.startsWith("NEAR RPC rejected"))
  )
    status.textContent = "Viewing shared testnet street.";
  if (activeCarIsParked()) moving = 0;
  document.querySelector<HTMLButtonElement>("#left")!.disabled =
    activeCarIsParked();
  document.querySelector<HTMLButtonElement>("#right")!.disabled =
    activeCarIsParked();

  let title = ready
    ? currentRoad().name
    : live?.error
      ? "Shared street unavailable"
      : "Loading shared street";
  let rule = live?.error || "Use Live city to connect a testnet wallet";
  let rate = "";
  let spaces = "";
  let ownerPrice = "";
  let mode = "Keep driving";
  let enabled = false;
  let towerPanel: TowerPanel | null = null;
  towerFloorWrap.hidden = true;
  const target = selection;
  if (ready && target.kind === "Connection") {
    const next = city.streets.find(
      (entry) => entry.id === target.connection.toRoadId,
    );
    title = `Turn onto ${next?.name ?? target.connection.toRoadId}`;
    rule = "Turn at this intersection";
    mode = `Turn onto ${next?.name ?? "street"}`;
    enabled = true;
  } else if (ready && target.kind === "Site") {
    const site = city.npcSites.find((entry) => entry.id === target.id);
    if (site) {
      if (site.role === "ParkingTower" && live?.towerFloors)
        showTowerFloorControl(live.towerFloors);
      title = site.name;
      rule =
        site.role === "ParkingTower"
          ? "Game-owned · always legal"
          : "Game-owned destination";
      rate =
        site.role === "ParkingTower"
          ? live?.economyConfigError
            ? live.economyConfigError
            : towerEarningPreview(live?.economyConfig ?? null, car)
          : site.role;
      spaces =
        site.role === "ParkingTower"
          ? `${live?.towerAvailable ?? "?"} of ${site.capacity} spaces free${live?.towerFloors ? ` · floor ${selectedTowerFloor + 1}: ${live.towerFloors[selectedTowerFloor]} free` : ""}`
          : "No earning parking here";
      if (site.role === "ParkingTower") {
        live?.loadTowerSpaces(site.id, selectedTowerFloor);
        const key = `${site.id}:${selectedTowerFloor}`;
        towerPanel = {
          siteId: site.id,
          floor: selectedTowerFloor,
          spaces:
            live?.towerSpaceKey === key && live.towerSpaces
              ? live.towerSpaces.map((entry) => ({
                  occupied: Boolean(entry && now < entry.expires_at),
                  mine: entry?.driver === live.accountId,
                  expiresAt:
                    entry && now < entry.expires_at ? entry.expires_at : null,
                }))
              : null,
          error: live?.towerSpaceKey === key ? live.towerSpaceError : "",
        };
      }
      const nearby =
        Math.abs(
          carX - frontageCenter(currentRoad(), site.frontageIndex, side),
        ) <= 100;
      mode = nearby
        ? site.role === "ParkingTower"
          ? !registered || !keyReady
            ? "Set up wallet"
            : session
              ? "Car already earning"
              : live?.towerAvailable == null
                ? "Loading spaces"
                : live?.towerAvailable === 0
                  ? "Tower full"
                  : live?.towerFloors?.[selectedTowerFloor] === 0
                    ? "Floor full"
                    : "Park in tower"
          : "Visit"
        : "Drive closer";
      enabled =
        nearby &&
        !live?.busy &&
        (site.role !== "ParkingTower" ||
          (!session &&
            Boolean(
              live?.towerFloors
                ? live.towerFloors[selectedTowerFloor]
                : live?.towerAvailable,
            ) &&
            Boolean(car)));
      if (nearby && site.role === "ParkingTower" && !registered) enabled = true;
    }
  } else if (ready && target.kind === "Plot") {
    const entry = livePlot(target.id);
    if (entry) {
      const plot = entry.plot.plot;
      title = plot.building.name.startsWith("Plot ")
        ? `${currentRoad().name} · Plot ${plot.index + 1}`
        : `${plot.building.name} · Plot ${plot.index + 1}`;
      switch (entry.plot.effective_rule.kind) {
        case "Free":
          rule = "Free parking";
          break;
        case "NoParking":
          rule = "No parking · owner may ticket";
          break;
        case "ColorOnly":
          rule = `${entry.plot.effective_rule.color} cars only`;
          break;
        case "Meter":
          rule = `Meter · ${formatCoins(entry.plot.effective_rule.ratePerHour)} coins/hour`;
      }
      rate = live?.economyConfigError
        ? live.economyConfigError
        : plotEarningPreview(
            live?.economyConfig ?? null,
            entry.plot.effective_rule,
            car,
          );
      if (plot.owner) ownerPrice = `Owner: ${plot.owner}`;
      else {
        requestPlotPrice(plot.id);
        ownerPrice =
          plotPriceCache.get(plot.id)?.text ?? "Unowned · loading plot price…";
      }
      const open = entry.slots.findIndex(
        (slot) => !slot || now >= slot.expires_at,
      );
      spaces = `${entry.slots.filter((slot) => !slot || now >= slot.expires_at).length} of ${entry.slots.length} spaces free`;
      renderPlotLinks(
        visibleMediaLink(
          plot.logo,
          entry.plot.logo_eligible,
          plot.building.layout_revision,
        ),
        visibleMediaLink(
          plot.billboard,
          entry.plot.billboard_eligible,
          plot.building.layout_revision,
        ),
      );
      const illegal = entry.slots.find(
        (slot) => slot && !slot.legal && now < slot.expires_at,
      );
      const nearby =
        Math.abs(carX - frontageCenter(currentRoad(), plot.index, side)) <= 100;
      if (!nearby) mode = "Drive closer";
      else if (!registered || !keyReady) mode = "Set up wallet";
      else if (
        plot.owner === live?.accountId &&
        illegal &&
        now >= plot.ticket_cooldown_until
      )
        mode = "Ticket";
      else if (plot.owner === live?.accountId) mode = "Your curb";
      else if (session) mode = "Car already earning";
      else if (open < 0) mode = "Spaces full";
      else if (!car || car.durability === 0) mode = "Repair car";
      else mode = "Park here";
      enabled =
        nearby &&
        !live?.busy &&
        ["Set up wallet", "Ticket", "Park here"].includes(mode);
    }
  }
  document.querySelector<HTMLElement>("#plot-title")!.textContent = title;
  document.querySelector<HTMLElement>("#plot-rule")!.textContent = rule;
  document.querySelector<HTMLElement>("#plot-rate")!.textContent = rate;
  const ownerPriceLine =
    document.querySelector<HTMLElement>("#plot-owner-price")!;
  ownerPriceLine.textContent = ownerPrice;
  ownerPriceLine.hidden = !ownerPrice;
  document.querySelector<HTMLElement>("#plot-spaces")!.textContent = spaces;
  renderTowerPanel(towerPanel);
  document.querySelector<HTMLElement>("#balance")!.textContent = live?.player
    ?.account
    ? formatCoins(live.player.account.balance)
    : "—";
  document.querySelector<HTMLElement>("#durability")!.textContent = car
    ? `🔧 ${car.durability}%`
    : "🔧 —";
  document.querySelector<HTMLElement>("#car-name")!.textContent = car
    ? `${car.body} · Tier ${car.tier}`
    : "Connect a testnet car";
  document.querySelector<HTMLElement>("#mobile-car-chip")!.textContent = car
    ? `🚗 ${car.body}`
    : "🚗 No car";
  const controllerCollect = Boolean(session) && !enabled;
  const controllerMode =
    controllerCollect && session
      ? now >= session.expires_at
        ? "Settle expired"
        : "Collect"
      : mode;
  actionButton.textContent = controllerMode;
  actionButton.dataset.command = controllerCollect ? "collect" : "context";
  updateGamepadAction(controllerMode);
  panelAction.textContent = mode;
  actionButton.disabled = controllerCollect
    ? !keyReady || Boolean(live?.busy)
    : !enabled;
  panelAction.disabled = !enabled;
  collectButton.hidden = !session;
  panelCollect.hidden = !session;
  collectButton.disabled = !keyReady || Boolean(live?.busy);
  panelCollect.disabled = collectButton.disabled;
  if (session) {
    const label =
      now >= session.expires_at ? "Settle expired" : "Collect parked car";
    collectButton.textContent = label;
    panelCollect.textContent = label;
  }
}

function collectParkedCar(): void {
  if (liveMode) {
    void collectLiveCar();
    return;
  }
  const session = game.playerSession();
  if (!session) return;
  try {
    if (game.nowSeconds() >= session.expiresAt) {
      game.settleExpired();
      status.textContent = "Expired parking settled at the 30-minute cap";
    } else {
      status.textContent = `Collected ${formatCoins(game.collect().toString())} coins`;
    }
    if (session.carId === game.activeCarId) restoreCarToSession(session);
    drawWorld();
    updatePanel();
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Collection failed";
  }
}

async function collectLiveCar(): Promise<void> {
  if (collectButton.disabled) return;
  const live = liveStreet;
  const session = live?.activeSession;
  if (!live || !session) return;
  status.textContent = "Confirming collection on testnet…";
  try {
    await live.call(
      Math.floor(Date.now() / 1000) >= session.expires_at
        ? "settle_expired"
        : "collect",
      { expected_session_id: session.id },
    );
    if (session.car_id === live.selectedCarId)
      restoreCarToSession({
        facility: session.facility,
        locationId: session.location_id,
      });
    status.textContent = "Parking settled on testnet.";
    drawWorld();
    updatePanel();
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Collection failed";
  }
}

function action(requestedSlot?: number): void {
  if (liveMode) {
    void liveAction(requestedSlot);
    return;
  }
  if (actionButton.dataset.command === "collect") {
    if (requestedSlot === undefined) collectParkedCar();
    else status.textContent = "Collect your parked car before parking again.";
    return;
  }
  if (actionButton.disabled) {
    status.textContent =
      actionButton.textContent === "Drive closer"
        ? "Drive closer to that parking space first."
        : (actionButton.textContent ?? "Parking unavailable");
    return;
  }
  try {
    let message: string;
    const target = selection;
    if (target.kind === "Connection") {
      followConnection(target.connection);
      return;
    } else if (target.kind === "Site") {
      const site = city.npcSites.find((entry) => entry.id === target.id);
      if (site?.role === "ParkingTower") {
        const session = game.parkTower(site.id, selectedTowerFloor);
        message = `Parked on floor ${selectedTowerFloor + 1}, space ${(session.space % TOWER_SPACES_PER_FLOOR) + 1}. Use C to collect earnings.`;
      } else {
        if (!site) return;
        activeSiteId = site.id;
        showScreen("Destination");
        status.textContent = `Visiting ${site.name}`;
        return;
      }
    } else if (
      target.kind === "Plot" &&
      target.id === game.ownedPlotId &&
      requestedSlot === undefined &&
      [...game.sessions.values()].some(
        (entry) => entry.locationId === target.id && !entry.legal,
      )
    )
      message = `Ticketed visitor for ${formatCoins(game.ticket(target.id).toString())} coins`;
    else if (target.kind === "Plot") {
      const session = game.park(target.id, requestedSlot);
      message = `Parked in space ${session.space + 1}. Use C to collect earnings.`;
    } else {
      return;
    }
    status.textContent = message;
    drawWorld();
    updatePanel();
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Action failed";
  }
}

async function liveAction(requestedSlot?: number): Promise<void> {
  if (actionButton.dataset.command === "collect") {
    if (requestedSlot === undefined) collectParkedCar();
    else status.textContent = "Collect your parked car before parking again.";
    return;
  }
  if (actionButton.disabled) {
    if (requestedSlot !== undefined)
      status.textContent =
        actionButton.textContent === "Drive closer"
          ? "Drive closer to that parking space first."
          : (actionButton.textContent ?? "Parking unavailable");
    return;
  }
  const live = liveStreet;
  const target = selection;
  if (target.kind === "Connection") {
    followConnection(target.connection);
    return;
  }
  if (!live?.street || live.busy) return;
  if (target.kind === "Site") {
    const site = city.npcSites.find((entry) => entry.id === target.id);
    if (!site) return;
    if (site.role !== "ParkingTower") {
      activeSiteId = site.id;
      showScreen("Destination");
      return;
    }
  }
  if (!live.player?.account || live.keyStatus !== "ready") {
    showScreen("Testnet");
    return;
  }
  if (!live.selectedCar) {
    status.textContent = "Select a car in Live city first.";
    return;
  }
  status.textContent = "Confirming parking action on testnet…";
  try {
    if (target.kind === "Site") {
      const floor = selectedTowerFloor;
      const floorChoice = Boolean(live.towerFloors);
      const space = floorChoice
        ? await live.reader.towerOpenSpaceOnFloor(target.id, floor)
        : await live.reader.towerOpenSpace(target.id);
      if (space === null) throw new Error("The parking tower is full");
      await live.call("park_tower", {
        car_id: live.selectedCar.id,
        site_id: target.id,
        space,
      });
      status.textContent = `Parked on floor ${Math.floor(space / TOWER_SPACES_PER_FLOOR) + 1}, space ${(space % TOWER_SPACES_PER_FLOOR) + 1} on testnet. Use C to collect earnings.`;
    } else if (target.kind === "Plot") {
      const entry = livePlot(target.id);
      if (!entry) throw new Error("Plot state is still loading");
      const now = Math.floor(Date.now() / 1000);
      const illegal = entry.slots.find(
        (slot) => slot && !slot.legal && now < slot.expires_at,
      );
      if (
        requestedSlot === undefined &&
        entry.plot.plot.owner === live.accountId &&
        illegal &&
        now >= entry.plot.plot.ticket_cooldown_until
      ) {
        await live.call("ticket", {
          plot_id: target.id,
          slot: illegal.slot,
          expected_session_id: illegal.id,
        });
        status.textContent = "Illegal parker ticketed on testnet.";
      } else {
        const slot =
          requestedSlot ??
          entry.slots.findIndex(
            (occupied) => !occupied || now >= occupied.expires_at,
          );
        if (slot < 0) throw new Error("All curb spaces are occupied");
        if (
          !Number.isInteger(slot) ||
          slot >= entry.slots.length ||
          (entry.slots[slot] && now < entry.slots[slot].expires_at)
        )
          throw new Error("This parking space is occupied");
        await live.call("park", {
          car_id: live.selectedCar.id,
          plot_id: target.id,
          slot,
        });
        status.textContent = `Parked in curb space ${slot + 1} on testnet. Use C to collect earnings.`;
      }
    }
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Action failed";
  }
}

function cityMapMarkup(): string {
  const activeSession = liveMode
    ? liveStreet?.activeSession
    : game.playerSession();
  const liveSession = liveStreet?.activeSession;
  const parkedCarLocation = liveMode
    ? liveSession && liveSession.car_id === liveStreet?.selectedCarId
      ? { facility: liveSession.facility, locationId: liveSession.location_id }
      : null
    : (game.activeCarSession() ?? null);
  const parkedActiveCar = Boolean(parkedCarLocation);
  const hasActiveCar = !liveMode || Boolean(liveStreet?.selectedCar);
  const marker = parkedCarLocation
    ? parkedLocation(parkedCarLocation)
    : { roadId, side, x: carX };
  const markerRoad = city.streets.find((entry) => entry.id === marker.roadId)!;
  const markerPoint = cityMapCurbPoint(
    city,
    marker.roadId,
    marker.x,
    marker.side,
  );
  const mapText = (value: string): string =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const markerLabel = parkedActiveCar
    ? "PARKED"
    : hasActiveCar
      ? "YOU"
      : "VIEW";
  const markerLabelWidth = parkedActiveCar ? 62 : hasActiveCar ? 38 : 42;
  const markerLabelX =
    markerPoint.x + markerLabelWidth + 18 > 490
      ? markerPoint.x - markerLabelWidth - 18
      : markerPoint.x + 18;
  const markerLabelY =
    markerPoint.y < 76 ? markerPoint.y + 13 : markerPoint.y - 30;
  const roadLabel = (id: string, name: string, y: number): string => {
    const onLeft = marker.roadId === id && markerPoint.x < 205;
    return `<text class="map-road-label" x="${onLeft ? 250 : 57}" y="${y - 17}" text-anchor="${onLeft ? "middle" : "start"}">${mapText(name)}</text>`;
  };
  const avenueLabel = (id: string, name: string, x: number): string =>
    `<text class="map-road-label" x="${x}" y="${marker.roadId === id && markerPoint.y < 78 ? 284 : 27}" text-anchor="middle">${mapText(name)}</text>`;
  const siteMapPoint = (site: NPCSite): { x: number; y: number } => {
    const road = city.streets.find((entry) => entry.id === site.roadId)!;
    return cityMapCurbPoint(
      city,
      site.roadId,
      frontageCenter(road, site.frontageIndex, site.side),
      site.side,
    );
  };
  const towerPins = city.npcSites
    .filter((site) => site.role === "ParkingTower")
    .map((site) => {
      const point = siteMapPoint(site);
      return `<g class="map-tower-pin" data-map-tower="${site.id}" role="button" tabindex="0" aria-label="Go to ${mapText(site.name)}" transform="translate(${point.x} ${point.y})"><circle r="12"/><text y="4" text-anchor="middle">P</text></g>`;
    })
    .join("");
  const activityPinLabels: Record<string, string> = {
    RepairGarage: "G",
    Cinema: "▶",
    BurgerStop: "B",
    PracticeCourse: "⚑",
  };
  const activityPins = city.npcSites
    .filter((site) => site.role !== "ParkingTower")
    .map((site) => {
      const point = siteMapPoint(site);
      return `<g class="map-site-pin" data-map-site="${site.id}" role="button" tabindex="0" aria-label="Visit ${mapText(site.name)}" transform="translate(${point.x} ${point.y})"><title>${mapText(site.name)}</title><circle r="10"/><text y="3.5" text-anchor="middle">${activityPinLabels[site.role]}</text></g>`;
    })
    .join("");
  const roadCards = city.streets
    .map((street, index) => {
      const isHere = street.id === marker.roadId;
      const isViewing = street.id === roadId && !isHere;
      return `<button class="map-route" data-road="${street.id}" ${isHere ? 'aria-current="location"' : ""}><span class="map-route-number">${String(index + 1).padStart(2, "0")}</span><span class="map-route-copy"><strong>${mapText(street.name)}</strong><small>${isHere ? (parkedActiveCar ? "Car parked here" : hasActiveCar ? "You are here" : "Viewing this street") : isViewing ? "Viewing this street" : parkedActiveCar || !hasActiveCar ? "View street" : "Travel here"}</small></span><span class="map-route-arrow" aria-hidden="true">↗</span></button>`;
    })
    .join("");
  const towerCards = city.npcSites
    .filter((site) => site.role === "ParkingTower")
    .map(
      (site) =>
        `<button class="map-place" data-tower="${site.id}"><span class="map-place-icon tower-icon" aria-hidden="true">P</span><span><strong>${mapText(site.name)}</strong><small>${liveMode ? "View available spaces" : `${game.towerAvailability(site.id)} of ${site.capacity} spaces open`}</small></span><span class="map-place-arrow" aria-hidden="true">↗</span></button>`,
    )
    .join("");
  const siteDetails: Record<string, { icon: string; hint: string }> = {
    RepairGarage: { icon: "⚙", hint: "Repair and upgrades" },
    Cinema: { icon: "▶", hint: "Watch a short" },
    BurgerStop: { icon: "🍔", hint: "Take a free break" },
    PracticeCourse: { icon: "⚑", hint: "Race your best time" },
  };
  const activityCards = city.npcSites
    .filter((site) => site.role !== "ParkingTower")
    .map((site) => {
      const detail = siteDetails[site.role]!;
      return `<button class="map-place" data-site="${site.id}"><span class="map-place-icon" aria-hidden="true">${detail.icon}</span><span><strong>${mapText(site.name)}</strong><small>${detail.hint}</small></span><span class="map-place-arrow" aria-hidden="true">↗</span></button>`;
    })
    .join("");
  return `<div class="city-map-screen">
    <div class="map-heading"><div><span class="map-eyebrow">PARKING CITY · CITY GUIDE</span><h1>City map</h1><p>${liveMode ? "Shared testnet city" : "Five connected roads"} · ${parkedActiveCar ? "Car parked" : hasActiveCar ? "Driving" : "Viewing"} on ${mapText(markerRoad.name)}, ${curbDirection(marker.roadId, marker.side).toLowerCase()} curb.</p></div><span class="map-heading-badge">${parkedActiveCar ? "PARKED" : hasActiveCar ? "YOU ARE HERE" : "CURRENT VIEW"}</span></div>
    <div class="map-primary">
      <section class="map-board" aria-label="City street diagram"><div class="map-board-head"><strong>Explore the streets</strong><span>Tap a road to explore <span aria-hidden="true">↗</span></span></div>
        <svg class="city-map" viewBox="0 0 500 300" role="group" aria-label="Five connected roads, parking towers and your car position">
          <title>near.estate city streets</title>
          <rect class="map-ground" width="500" height="300" />
          <path class="map-green" d="M62 90H156V127H62Z M206 90H296V127H206Z M347 90H437V127H347Z M62 174H156V211H62Z M206 174H296V211H206Z M347 174H437V211H347Z" />
          <path class="map-road-edge" d="M50 65H450 M50 150H450 M50 235H450 M180 40V260 M320 40V260 M50 65Q20 65 20 108Q20 150 50 150 M450 150Q480 150 480 193Q480 235 450 235" />
          <path class="map-road" d="M50 65H450 M50 150H450 M50 235H450 M180 40V260 M320 40V260 M50 65Q20 65 20 108Q20 150 50 150 M450 150Q480 150 480 193Q480 235 450 235" />
          <path class="map-road-line" d="M50 65H450 M50 150H450 M50 235H450 M180 40V260 M320 40V260" />
          <rect class="map-road-hit" data-map-road="main" x="50" y="50" width="400" height="30" role="button" tabindex="0" aria-label="Travel to Main Street" />
          <rect class="map-road-hit" data-map-road="market" x="50" y="135" width="400" height="30" role="button" tabindex="0" aria-label="Travel to Market Street" />
          <rect class="map-road-hit" data-map-road="river" x="50" y="220" width="400" height="30" role="button" tabindex="0" aria-label="Travel to River Street" />
          <rect class="map-road-hit" data-map-road="central" x="165" y="40" width="30" height="220" role="button" tabindex="0" aria-label="Travel to Central Avenue" />
          <rect class="map-road-hit" data-map-road="harbor" x="305" y="40" width="30" height="220" role="button" tabindex="0" aria-label="Travel to Harbor Avenue" />
          ${roadLabel("main", "Main Street", 65)}${roadLabel("market", "Market Street", 150)}${roadLabel("river", "River Street", 235)}
          ${avenueLabel("central", "Central Ave", 180)}${avenueLabel("harbor", "Harbor Ave", 320)}
          ${towerPins}${activityPins}
          <circle class="map-position-ring" cx="${markerPoint.x}" cy="${markerPoint.y}" r="12" />
          <circle class="map-position" cx="${markerPoint.x}" cy="${markerPoint.y}" r="6" />
          <rect class="map-position-tag" x="${markerLabelX}" y="${markerLabelY}" width="${markerLabelWidth}" height="18" rx="9" />
          <text class="map-position-label" x="${markerLabelX + markerLabelWidth / 2}" y="${markerLabelY + 12}" text-anchor="middle">${markerLabel}</text>
        </svg>
        <div class="map-legend"><span><i class="map-legend-dot"></i> Your car</span><span><i class="map-legend-tower">P</i> Parking tower</span><span><i class="map-legend-site">✦</i> City stop</span><span class="map-compass">N ↑</span></div>
      </section>
      <section class="map-route-panel"><h2>Choose a street</h2><p>Tap a street to jump into its curb view.</p><div class="map-route-list">${roadCards}</div><button class="map-cross" id="cross-street">${canCrossWithCar() ? "Cross road to" : "View"} the ${curbDirection(roadId, oppositeSide()).toLowerCase()} curb <span aria-hidden="true">↗</span></button></section>
    </div>
    <section class="map-section"><div class="map-section-heading"><h2>Parking towers</h2><span>Game owned · 32 spaces each</span></div><div class="map-place-grid">${towerCards}</div></section>
    <section class="map-section"><div class="map-section-heading"><h2>Places to visit</h2><span>Free activities around town</span></div><div class="map-place-grid">${activityCards}</div></section>
    <div class="map-footer"><span>For plot owners and advertisers</span><button id="map-stats">View advertiser stats <span aria-hidden="true">↗</span></button></div>
  </div>`;
}

function destinationMarkup(site: NPCSite): string {
  const practiceCar = liveMode ? liveStreet?.selectedCar : game.car;
  const decalOwned = liveMode
    ? Boolean(liveStreet?.player?.account?.burger_decal)
    : game.burgerDecal;
  const decalAction = decalOwned
    ? `<p class="tag">Burger decal owned · cosmetic only</p>`
    : `<button id="destination-decal" ${liveMode || game.balance < BigInt(DEFAULT_CONFIG.burgerDecalCost) ? "disabled" : ""}>${liveMode ? "Checking decal price…" : `Buy burger decal · ${formatCoins(DEFAULT_CONFIG.burgerDecalCost)} coins`}</button>`;
  const details = {
    RepairGarage: {
      title: "Keep your cars ready",
      body: "Repair durability, compare bodies and upgrade tiers in the car garage.",
      action: `<button id="destination-cars" class="primary">Open my cars</button>`,
    },
    Cinema: {
      title: "Now showing: The Last Space",
      body: "An original, silent 18-second near.estate short. Watching is free and does not change parking earnings.",
      action: `<div class="cinema-player"><canvas id="cinema-canvas" width="960" height="540" role="img" aria-label="Animated short about a red car finding the last parking space"></canvas><div class="cinema-controls"><button id="cinema-play" class="primary" type="button">Play short</button><button id="cinema-restart" type="button">Replay</button><progress id="cinema-progress" max="18" value="0" aria-label="Film progress"></progress><span id="cinema-time">0 / 18s</span></div><p id="cinema-caption" class="muted" aria-live="polite"></p></div>`,
    },
    BurgerStop: {
      title: "Take a burger break",
      body: "Take a free burger break while your car earns parking coins. Visits do not change your balance or durability.",
      action: `<button id="destination-burger" class="primary">Get a free burger</button><p id="burger-count">${burgerVisits ? `${burgerVisits} burger break${burgerVisits === 1 ? "" : "s"} enjoyed this visit.` : "No burger breaks yet."}</p><div class="burger-cosmetic"><h3>Burger decal</h3><p>One-time cosmetic for your cars. It does not change speed, parking income or durability.</p>${decalAction}<p id="destination-message" class="muted" aria-live="polite"></p></div>`,
    },
    PracticeCourse: {
      title: "Solo practice course",
      body: "Drive through three checkpoints and finish quickly. Higher-tier cars move faster; cones add time. No coins or durability are at stake.",
      action: practiceCar
        ? `<div class="practice-player"><p>${practiceCar.body} · Tier ${practiceCar.tier} · ${practiceCar.color}</p><canvas id="practice-canvas" width="480" height="640" role="img" aria-label="Three-lane practice course with checkpoints and cones"></canvas><p id="practice-status" aria-live="polite"></p><div class="practice-controls"><button id="practice-start" class="primary" type="button">Start run</button><button id="practice-left" type="button" aria-label="Steer left">←</button><button id="practice-throttle" class="primary" type="button">Hold to drive</button><button id="practice-right" type="button" aria-label="Steer right">→</button></div><p class="muted">Keyboard: hold ↑ or W to drive; tap ←/→ or A/D to steer. Best time is saved in this browser.</p></div>`
        : `<p class="muted">Connect a testnet wallet and select a car to practice.</p>`,
    },
    ParkingTower: {
      title: "Parking tower",
      body: "Drive beside the tower to park in an available space.",
      action: "",
    },
  }[site.role];
  return `<div class="destination-screen"><button id="destination-back">← Back to street</button>
    <div class="destination-card card ${site.role === "Cinema" || site.role === "PracticeCourse" ? "cinema-destination" : ""} ${site.role === "PracticeCourse" ? "practice-destination" : ""}"><img src="${import.meta.env.BASE_URL}world/${siteSpriteFile(site.role)}" alt="${site.name}" width="280" height="320" />
      <div><span class="tag">Game-owned destination</span><h1>${site.name}</h1><h2>${details.title}</h2><p>${details.body}</p>${details.action}</div>
    </div></div>`;
}

function carsMarkup(): string {
  const parked = game.playerSession();
  const recovery = game.recoveryStatus();
  const buyCost = BigInt(DEFAULT_CONFIG.buyCarCost);
  const canBuy =
    game.cars.length < DEFAULT_CONFIG.maxCars && game.balance >= buyCost;
  return `<h1>My cars</h1>
    <p class="muted">Choose an unparked car to drive, or select a parked car to collect it. Only one car earns parking coins at a time.</p>
    ${garageFeedback ? `<p class="card garage-feedback" role="${garageFeedback.error ? "alert" : "status"}"></p>` : ""}
    <div class="card-grid garage-grid">${game.cars
      .map((car) => {
        const isActive = car.id === game.activeCarId;
        const isParked = parked?.carId === car.id;
        const upgradeCost =
          car.tier < 3
            ? DEFAULT_CONFIG.tierUpgradeCosts[car.tier - 1]
            : undefined;
        const fullPoints = DEFAULT_CONFIG.maxDurability - car.durability;
        const parkPoints = Math.max(
          0,
          DEFAULT_CONFIG.parkDurabilityCost - car.durability,
        );
        const fullCost =
          BigInt(fullPoints) * BigInt(DEFAULT_CONFIG.repairCostPerPoint);
        const parkCost =
          BigInt(parkPoints) * BigInt(DEFAULT_CONFIG.repairCostPerPoint);
        return `<article class="card car-card">
          <img src="${import.meta.env.BASE_URL}world/${carSpriteFile(car.body, car.color)}" alt="${car.color} ${car.body}" width="192" height="96" />
          <h2>${car.body}</h2>
          <p>${car.color} · Tier ${car.tier} · ${car.durability}% durability</p>
          <p><span class="tag">${isParked ? "Parked and earning" : isActive ? "Driving now" : "In garage"}</span></p>
          <button data-select-car="${car.id}" ${isActive ? "disabled" : ""}>${isActive ? "Selected" : isParked ? "Select parked car" : "Drive this car"}</button>
          <button data-repair-car="${car.id}" ${fullPoints === 0 || isParked || game.balance < fullCost ? "disabled" : ""}>${fullPoints === 0 ? "Fully repaired" : `Repair to full · ${formatCoins(fullCost.toString())} coins`}</button>
          ${parkPoints > 0 && parkPoints < fullPoints ? `<button data-repair-to-park="${car.id}" ${isParked || game.balance < parkCost ? "disabled" : ""}>Repair to park · ${formatCoins(parkCost.toString())} coins</button>` : ""}
          <button data-upgrade-car="${car.id}" ${!upgradeCost || isParked || game.balance < BigInt(upgradeCost) ? "disabled" : ""}>${upgradeCost ? `Upgrade · ${formatCoins(upgradeCost)} coins` : "Max tier"}</button>
        </article>`;
      })
      .join("")}</div>
    ${recovery.stranded ? `<section class="card"><h2>Free starter repair</h2><p class="muted">When no car can park and you cannot afford a repair, restore your starter car to parking durability once per cooldown.</p><button id="guest-emergency-repair" ${recovery.eligible ? "" : "disabled"}>${recovery.eligible ? "Restore starter car" : `Available after ${new Date(recovery.availableAt! * 1000).toLocaleString()}`}</button></section>` : ""}
    <section class="card car-showroom">
      <h2>Choose your next car</h2>
      <div class="car-purchase-controls">
        <label>Body <select id="buy-body">${CarBody.options.map((body) => `<option value="${body}">${body}</option>`).join("")}</select></label>
        <label>Colour <select id="buy-color">${CarColor.options.map((color) => `<option value="${color}">${color}</option>`).join("")}</select></label>
        <img id="buy-preview" src="${import.meta.env.BASE_URL}world/${carSpriteFile("Hatchback", "Red")}" alt="Red Hatchback preview" width="192" height="96" />
      </div>
      <button class="primary" id="buy-car" ${canBuy ? "" : "disabled"}>Buy car · ${formatCoins(DEFAULT_CONFIG.buyCarCost)} coins</button>
      <p class="muted">${game.cars.length >= DEFAULT_CONFIG.maxCars ? "Garage full: three cars maximum." : game.balance < buyCost ? `Earn ${formatCoins((buyCost - game.balance).toString())} more coins to buy a car.` : "A new car starts at tier 1 with full durability."}</p>
    </section>`;
}

function myPlotsMarkup(): string {
  const visitor = [...game.sessions.values()].some(
    (session) => session.locationId === ownedPlot.id && !session.legal,
  );
  return `<h1>My plots</h1><div class="card-grid">
    <article class="card"><h2>Plot ${ownedPlot.index + 1} · Main Street</h2>
      <p><span class="tag">Guest sample</span></p>
      <p>${choiceForGuestPlot(ownedPlot, guestDesigns.get(ownedPlot.id)).name} · ${game.curbCapacity(ownedPlot.id)} ${game.curbCapacity(ownedPlot.id) === 1 ? "unit" : "units"} · Level ${guestLevelForPlot(ownedPlot)}</p>
      <p>Rule: ${game.rules.get(ownedPlot.id) === "NoParking" ? "No parking" : "Free"}</p>
      <p class="muted">${visitor ? "An illegal visitor is parked here for the ticket demo." : "No illegal visitors are currently parked."}</p>
      <button id="visit-owned">Visit plot</button>
    </article>
    <article class="card"><h2>Build your place</h2>
      <p>Choose from five silhouettes that fit this plot, or explore the illustrated building studio.</p>
      <button id="open-street-designs" class="primary">Choose street design</button>
      <button id="open-studio" class="primary">Open building studio</button>
      <button id="open-stats">Advertiser stats</button>
    </article>
  </div>`;
}

function menuMarkup(): string {
  return `<div class="menu-screen"><h1>Menu</h1><div class="card-grid menu-grid">
    <article class="card"><h2>Explore</h2>
      <button data-menu-go="Street">Street</button>
      <button data-menu-go="Map">Map</button>
      <button data-menu-go="Cars">Cars</button>
      <button data-menu-go="My Plots">My plots</button>
      <button data-menu-go="Stats">Advertiser stats</button>
    </article>
    ${
      contractId
        ? `<article class="card"><h2>Testnet</h2>
      <button data-menu-go="Testnet">Wallet and live city</button>
      <button data-menu-mode>${liveMode ? "Switch to guest preview" : "Switch to testnet street"}</button>
    </article>`
        : ""
    }
  </div></div>`;
}

function showScreen(screen: string): void {
  completeCurbCrossing();
  const navigationScreen = screen;
  if (currentScreen === "Cars" && screen !== "Cars") garageFeedback = null;
  if (currentScreen === "Street" && screen !== "Street")
    impressionReporter.pause();
  if (unmountCinema) {
    unmountCinema();
    unmountCinema = null;
  }
  if (unmountPractice) {
    unmountPractice();
    unmountPractice = null;
  }
  chainOwnerFocus = liveMode && screen === "My Plots";
  if (liveMode && (screen === "Cars" || screen === "My Plots"))
    screen = "Testnet";
  if (currentScreen === "Studio" && screen !== "Studio") studio.unmount();
  if (currentScreen === "Stats" && screen !== "Stats") statsScreen.unmount();
  if (currentScreen === "Testnet" && screen !== "Testnet") chainScreen?.hide();
  if (currentScreen === "Street" && screen !== "Street") liveStreet?.stop();
  if (screen !== "Street" || portraitDriving.matches) resetDriveInput();
  currentScreen = screen;
  status.hidden = screen !== "Street" || portraitDriving.matches;
  streetScreen.hidden = screen !== "Street";
  otherScreen.hidden = screen === "Street";
  document
    .querySelectorAll<HTMLButtonElement>("[data-screen]")
    .forEach((button) => {
      const active = button.dataset.screen === navigationScreen;
      button.classList.toggle("active", active);
      if (button.closest("nav")) {
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
    });
  networkButton.classList.toggle("active", screen === "Testnet");
  if (screen === "Street") {
    if (liveMode) liveStreet?.start();
    drawWorld();
    updatePanel();
    updateGuestBuildingBanner();
    requestAnimationFrame(() =>
      app.renderer.resize(canvasHost.clientWidth, canvasHost.clientHeight),
    );
    return;
  }
  if (screen === "Testnet") {
    otherScreen.innerHTML = "<p>Loading the live city…</p>";
    void openChainScreen(chainOwnerFocus);
    return;
  }
  if (screen === "Menu") {
    otherScreen.innerHTML = menuMarkup();
    otherScreen
      .querySelectorAll<HTMLButtonElement>("[data-menu-go]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          showScreen(button.dataset.menuGo!),
        ),
      );
    otherScreen
      .querySelector<HTMLButtonElement>("[data-menu-mode]")
      ?.addEventListener("click", toggleStreetMode);
    return;
  }
  if (screen === "Map") {
    otherScreen.innerHTML = cityMapMarkup();
    const goToRoad = (id: string | undefined) => {
      const road = city.streets.find((entry) => entry.id === id);
      if (!road) return;
      moveToRoad(road.id, side, frontageCenter(road, 0, side));
      showScreen("Street");
    };
    const goToTower = (id: string | undefined) => {
      const site = city.npcSites.find((entry) => entry.id === id);
      if (!site) return;
      const road = city.streets.find((entry) => entry.id === site.roadId)!;
      moveToRoad(
        site.roadId,
        site.side,
        frontageCenter(road, site.frontageIndex, site.side),
      );
      showScreen("Street");
    };
    const goToSite = (id: string | undefined) => {
      const site = city.npcSites.find((entry) => entry.id === id);
      if (!site) return;
      const road = city.streets.find((entry) => entry.id === site.roadId)!;
      moveToRoad(
        site.roadId,
        site.side,
        frontageCenter(road, site.frontageIndex, site.side),
      );
      activeSiteId = site.id;
      showScreen("Destination");
    };
    const bindMapHotspot = (element: SVGElement, action: () => void) => {
      element.addEventListener("click", action);
      element.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        action();
      });
    };
    otherScreen
      .querySelector<HTMLButtonElement>("#map-stats")!
      .addEventListener("click", () =>
        openStats(selection.kind === "Plot" ? selection.id : undefined),
      );
    otherScreen
      .querySelectorAll<HTMLButtonElement>("[data-road]")
      .forEach((button) =>
        button.addEventListener("click", () => goToRoad(button.dataset.road)),
      );
    otherScreen
      .querySelectorAll<SVGElement>("[data-map-road]")
      .forEach((hotspot) =>
        bindMapHotspot(hotspot, () => goToRoad(hotspot.dataset.mapRoad)),
      );
    otherScreen
      .querySelector<HTMLButtonElement>("#cross-street")!
      .addEventListener("click", () => {
        crossStreet();
        showScreen("Street");
      });
    otherScreen
      .querySelectorAll<HTMLButtonElement>("[data-tower]")
      .forEach((button) =>
        button.addEventListener("click", () => goToTower(button.dataset.tower)),
      );
    otherScreen
      .querySelectorAll<SVGElement>("[data-map-tower]")
      .forEach((hotspot) =>
        bindMapHotspot(hotspot, () => goToTower(hotspot.dataset.mapTower)),
      );
    otherScreen
      .querySelectorAll<HTMLButtonElement>("[data-site]")
      .forEach((button) =>
        button.addEventListener("click", () => goToSite(button.dataset.site)),
      );
    otherScreen
      .querySelectorAll<SVGElement>("[data-map-site]")
      .forEach((hotspot) =>
        bindMapHotspot(hotspot, () => goToSite(hotspot.dataset.mapSite)),
      );
  } else if (screen === "Cars") {
    otherScreen.innerHTML = carsMarkup();
    const feedback = otherScreen.querySelector<HTMLElement>(".garage-feedback");
    if (feedback) feedback.textContent = garageFeedback?.message ?? "";
    const refreshGarage = () => {
      drawWorld();
      updatePanel();
      showScreen("Cars");
    };
    const garageAction = (run: () => string) => {
      try {
        const message = run();
        status.textContent = message;
        garageFeedback = { message, error: false };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Car action failed";
        status.textContent = message;
        garageFeedback = { message, error: true };
      }
      refreshGarage();
    };
    otherScreen
      .querySelectorAll<HTMLButtonElement>("[data-select-car]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          garageAction(() => {
            game.selectCar(button.dataset.selectCar!);
            return game.activeCarSession()
              ? `${game.car.body} is parked. Return to the street to collect.`
              : `${game.car.body} is ready to drive`;
          }),
        ),
      );
    otherScreen
      .querySelectorAll<HTMLButtonElement>("[data-repair-car]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          garageAction(() => {
            game.selectCar(button.dataset.repairCar!);
            const points = DEFAULT_CONFIG.maxDurability - game.car.durability;
            game.repair(points);
            return `Repaired ${game.car.body} by ${points} points`;
          }),
        ),
      );
    otherScreen
      .querySelectorAll<HTMLButtonElement>("[data-repair-to-park]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          garageAction(() => {
            game.selectCar(button.dataset.repairToPark!);
            const points =
              DEFAULT_CONFIG.parkDurabilityCost - game.car.durability;
            game.repair(points);
            return `${game.car.body} is ready to park`;
          }),
        ),
      );
    otherScreen
      .querySelector<HTMLButtonElement>("#guest-emergency-repair")
      ?.addEventListener("click", () =>
        garageAction(
          () => `Restored starter car by ${game.emergencyRepair()} points`,
        ),
      );
    otherScreen
      .querySelectorAll<HTMLButtonElement>("[data-upgrade-car]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          garageAction(() => {
            game.selectCar(button.dataset.upgradeCar!);
            game.upgradeCar();
            return `${game.car.body} upgraded to tier ${game.car.tier}`;
          }),
        ),
      );
    const body = otherScreen.querySelector<HTMLSelectElement>("#buy-body")!;
    const color = otherScreen.querySelector<HTMLSelectElement>("#buy-color")!;
    const preview =
      otherScreen.querySelector<HTMLImageElement>("#buy-preview")!;
    const updatePreview = () => {
      preview.src = `${import.meta.env.BASE_URL}world/${carSpriteFile(body.value, color.value)}`;
      preview.alt = `${color.value} ${body.value} preview`;
    };
    body.addEventListener("change", updatePreview);
    color.addEventListener("change", updatePreview);
    otherScreen
      .querySelector<HTMLButtonElement>("#buy-car")!
      .addEventListener("click", () =>
        garageAction(() => {
          const car = game.buyCar(body.value, color.value);
          return `Bought ${car.color} ${car.body}`;
        }),
      );
  } else if (screen === "My Plots") {
    otherScreen.innerHTML = myPlotsMarkup();
    otherScreen
      .querySelector<HTMLButtonElement>("#visit-owned")!
      .addEventListener("click", () => {
        const road = city.streets.find(
          (entry) => entry.id === ownedPlot.roadId,
        )!;
        moveToRoad(
          road.id,
          ownedPlot.side,
          frontageCenter(road, ownedPlot.index, ownedPlot.side),
        );
        showScreen("Street");
      });
    otherScreen
      .querySelector<HTMLButtonElement>("#open-street-designs")!
      .addEventListener("click", () => {
        designTargetId = ownedPlot.id;
        showScreen("Designs");
      });
    otherScreen
      .querySelector<HTMLButtonElement>("#open-studio")!
      .addEventListener("click", () => showScreen("Studio"));
    otherScreen
      .querySelector<HTMLButtonElement>("#open-stats")!
      .addEventListener("click", () => openStats(ownedPlot.id));
  } else if (screen === "Designs") {
    const target = game.plot(designTargetId);
    mountGuestDesignPicker(
      otherScreen,
      target,
      choiceForGuestPlot(target, guestDesigns.get(target.id)).id,
      guestLevelForPlot(target),
      guestLogos.get(target.id) ?? null,
      (nextLogo) => {
        guestLogos.get(target.id)?.close();
        if (nextLogo) guestLogos.set(target.id, nextLogo);
        else guestLogos.delete(target.id);
      },
      guestAds.get(target.id) ?? null,
      (nextAd) => {
        guestAds.get(target.id)?.close();
        if (nextAd) guestAds.set(target.id, nextAd);
        else guestAds.delete(target.id);
      },
      (choiceId, level) => {
        choiceForGuestPlot(target, choiceId);
        guestDesigns.set(target.id, choiceId);
        guestLevels.set(target.id, level);
        if (target.id === game.ownedPlotId) guestBuildingPreview = null;
        const road = city.streets.find((entry) => entry.id === target.roadId)!;
        moveToRoad(
          target.roadId,
          target.side,
          frontageCenter(road, target.index, target.side),
        );
        selection = { kind: "Plot", id: target.id };
        showScreen("Street");
      },
      () => showScreen("Street"),
    );
  } else if (screen === "Studio") {
    studio.mount(otherScreen);
  } else if (screen === "Stats") {
    statsScreen.mount(statsInitialPlotId);
    statsInitialPlotId = undefined;
  } else if (screen === "Destination") {
    const site = city.npcSites.find((entry) => entry.id === activeSiteId);
    if (!site) throw new Error("Destination is missing");
    otherScreen.innerHTML = destinationMarkup(site);
    otherScreen
      .querySelector<HTMLButtonElement>("#destination-back")!
      .addEventListener("click", () => showScreen("Street"));
    otherScreen
      .querySelector<HTMLButtonElement>("#destination-cars")
      ?.addEventListener("click", () => showScreen("Cars"));
    otherScreen
      .querySelector<HTMLButtonElement>("#destination-burger")
      ?.addEventListener("click", () => {
        burgerVisits++;
        otherScreen.querySelector<HTMLElement>("#burger-count")!.textContent =
          `${burgerVisits} burger break${burgerVisits === 1 ? "" : "s"} enjoyed this visit.`;
        otherScreen.querySelector<HTMLElement>(
          "#destination-message",
        )!.textContent = "Enjoy your burger. Your coins and car are unchanged.";
      });
    if (site.role === "Cinema") unmountCinema = mountCinemaShort(otherScreen);
    if (site.role === "PracticeCourse") {
      const car = liveMode ? liveStreet?.selectedCar : game.car;
      if (car)
        unmountPractice = mountPracticeCourse(otherScreen, {
          tier: car.tier as 1 | 2 | 3,
          color: car.color,
          profileId: liveMode ? (liveStreet?.accountId ?? "testnet") : "guest",
        });
    }
    const decalButton =
      otherScreen.querySelector<HTMLButtonElement>("#destination-decal");
    if (decalButton) {
      let quotedCost: string | null = liveMode
        ? null
        : DEFAULT_CONFIG.burgerDecalCost;
      if (liveMode) {
        if (!liveStreet?.player?.account) {
          decalButton.textContent = "Register in Live city to buy";
        } else {
          void liveStreet.reader.burgerDecalCost().then(
            (cost) => {
              if (
                currentScreen !== "Destination" ||
                activeSiteId !== site.id ||
                !decalButton.isConnected
              )
                return;
              quotedCost = cost;
              decalButton.textContent = `Buy burger decal · ${formatCoins(cost)} coins`;
              decalButton.disabled =
                BigInt(liveStreet?.player?.account?.balance ?? "0") <
                BigInt(cost);
            },
            () => {
              if (decalButton.isConnected)
                decalButton.textContent = "Decal price unavailable";
            },
          );
        }
      }
      decalButton.addEventListener("click", () => {
        if (!quotedCost) return;
        decalButton.disabled = true;
        const message = otherScreen.querySelector<HTMLElement>(
          "#destination-message",
        )!;
        void (async () => {
          try {
            if (liveMode) {
              const wallet = liveStreet?.wallet;
              const accountId = liveStreet?.accountId;
              if (!wallet || !accountId)
                throw new Error("Connect a testnet wallet in Live city");
              await wallet.buyBurgerDecal(quotedCost);
              if (liveStreet)
                liveStreet.player = await liveStreet.reader.player(accountId);
            } else game.buyBurgerDecal();
            if (currentScreen === "Destination" && activeSiteId === site.id) {
              updatePanel();
              showScreen("Destination");
            }
          } catch (error) {
            if (message.isConnected) {
              message.textContent =
                error instanceof Error
                  ? error.message
                  : "Decal purchase failed";
              decalButton.disabled = false;
            }
          }
        })();
      });
    }
  } else {
    throw new Error(`Unknown screen: ${screen}`);
  }
}

async function openChainScreen(focusOwned = false): Promise<void> {
  if (!contractId) return;
  try {
    if (!chainScreen) {
      const [reader, { ChainScreen }] = await Promise.all([
        getReader(),
        import("./chain-screen.js"),
      ]);
      if (currentScreen !== "Testnet") return;
      chainScreen = new ChainScreen(
        otherScreen,
        reader,
        () => ({ roadId: currentRoad().id, side }),
        chainCity.npcSites,
        getWalletClient,
      );
    }
    if (currentScreen === "Testnet") await chainScreen.show(focusOwned);
  } catch (error) {
    if (currentScreen !== "Testnet") return;
    otherScreen.textContent =
      error instanceof Error ? error.message : "Live city failed to open";
  }
}

async function openLiveStreet(): Promise<void> {
  if (!liveMode || !contractId) return;
  try {
    const reader = await getReader();
    const version = await reader.cityVersion();
    if (!liveMode) return;
    if (version !== liveCityVersion) {
      liveStreet?.stop();
      liveStreet = null;
      liveCityVersion = version;
    }
    const nextCity = version === 2 ? guestCity : chainCity;
    if (city !== nextCity) {
      const previousIndex = frontageAtX(currentRoad(), carX, side) ?? 0;
      city = nextCity;
      carX = frontageCenter(
        currentRoad(),
        Math.min(previousIndex, currentRoad().length - 1),
        side,
      );
      selection = selectionAtCar();
      statsScreen.setPlots(
        city.plots.map((plot) => ({
          id: plot.id,
          label: `${city.streets.find((street) => street.id === plot.roadId)?.name ?? plot.roadId} · ${curbDirection(plot.roadId, plot.side)} · Plot ${plot.index + 1} · ${plot.initialType}`,
        })),
      );
      drawWorld();
      updatePanel();
    }
    if (!liveStreet) {
      const { LiveStreet } = await import("./live-street.js");
      if (!liveMode) return;
      liveStreet = new LiveStreet(
        reader,
        getWalletClient,
        () => ({ roadId: currentRoad().id, side }),
        city.npcSites,
        city,
        () => {
          if (liveMode && currentScreen === "Street") {
            if (liveSceneKey() !== renderedLiveSceneKey) drawWorld();
            updatePanel();
          }
        },
      );
    }
    if (currentScreen === "Street") liveStreet.start();
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Live street failed to open";
  }
}

function toggleStreetMode(): void {
  completeCurbCrossing();
  if (!contractId) return;
  impressionReporter.pause();
  const previousIndex = frontageAtX(currentRoad(), carX, side) ?? 0;
  liveMode = !liveMode;
  city = liveMode ? (liveCityVersion === 2 ? guestCity : chainCity) : guestCity;
  carX = frontageCenter(
    currentRoad(),
    Math.min(previousIndex, currentRoad().length - 1),
    side,
  );
  selection = selectionAtCar();
  updateGuestBuildingBanner();
  if (!liveMode) liveStreet?.stop();
  modeButton.textContent = liveMode ? "Guest mode" : "Testnet street";
  status.textContent = liveMode
    ? "Loading shared testnet street…"
    : "Guest preview uses local sample parking.";
  if (currentScreen !== "Street") showScreen("Street");
  else {
    drawWorld();
    updatePanel();
  }
  if (liveMode) void openLiveStreet();
}

const app = new Application();
await app.init({
  resizeTo: canvasHost,
  background: "#91dbf7",
  antialias: false,
  resolution: Math.min(devicePixelRatio || 1, 2),
});
canvasHost.appendChild(app.canvas);
new ResizeObserver(() => {
  if (canvasHost.clientWidth > 0 && canvasHost.clientHeight > 0) {
    app.renderer.resize(canvasHost.clientWidth, canvasHost.clientHeight);
  }
}).observe(canvasHost);
backdrop = new Container();
world = new Container();
app.stage.addChild(backdrop, world);
drawWorld();
updatePanel();
function moveCarBy(distance: number): void {
  if (curbCrossing) return;
  if (activeCarIsParked()) {
    moving = 0;
    return;
  }
  driveDirection = distance < 0 ? -1 : 1;
  carSprite.y = driveLaneY(driveDirection);
  carSprite.scale.x = driveDirection;
  const road = currentRoad();
  const width = roadWidth(road);
  const nextX = carX + distance;
  if (nextX < 25 || nextX > width - 25) {
    const exit = endConnection(road, driveDirection);
    if (exit) {
      followConnection(exit);
      return;
    }
  }
  carX = Math.min(width - 25, Math.max(25, nextX));
  carSprite.x = carX;
  const nextSelection = selectionAtCar();
  if (selectionKey(selection) !== selectionKey(nextSelection)) {
    selection = nextSelection;
    updatePanel();
  }
}
app.ticker.add((ticker) => {
  if (currentScreen !== "Street" || portraitDriving.matches) return;
  if (curbCrossing) {
    const crossing = curbCrossing;
    crossing.elapsedMs = Math.min(
      CURB_CROSSING_MS,
      crossing.elapsedMs + Math.min(ticker.deltaMS, 50),
    );
    const progress = crossing.elapsedMs / CURB_CROSSING_MS;
    if (progress >= 0.5 && !crossing.swapped) {
      crossing.swapped = true;
      showCurb(crossing.destination);
    }
    const lift = Math.sin(Math.PI * progress);
    const laneY = driveLaneY(driveDirection);
    carSprite.y = laneY + (224 - laneY) * lift;
    carSprite.alpha = 1 - 0.28 * lift;
    if (progress === 1) completeCurbCrossing();
  }
  const dt = Math.min(ticker.deltaMS / 1000, 0.05);
  if (moving) {
    moveCarBy(moving * DRIVE_SPEED * dt);
  }
  const scale = Math.max(0.5, canvasHost.clientHeight / 300);
  backdrop.scale.set(scale);
  world.scale.set(scale);
  const visibleWidth = canvasHost.clientWidth / scale;
  const cameraLeft = Math.max(
    0,
    Math.min(
      roadWidth(currentRoad()) - visibleWidth,
      carX - visibleWidth * (moving < 0 ? 0.6 : 0.4),
    ),
  );
  world.x = -cameraLeft * scale;
  backdrop.x = -cameraLeft * scale * 0.4;
  facadeTextures.updateVisible(cameraLeft, visibleWidth);
  if (
    liveMode &&
    !document.hidden &&
    liveStreet?.street?.road_id === roadId &&
    liveStreet.street.side === side
  )
    impressionReporter.observe([
      ...facadeTextures.visibleAdSurfaces(
        cameraLeft,
        visibleWidth,
        canvasHost.clientHeight / scale,
      ),
      ...variableFacades.flatMap((facade) => {
        if (
          facade.group.destroyed ||
          facade.x < cameraLeft ||
          facade.x + facade.width > cameraLeft + visibleWidth
        )
          return [];
        const visible = [...facade.group.mediaViews]
          .reverse()
          .find((entry) => entry.sprite.visible && !entry.sprite.destroyed);
        return visible
          ? [{ plotId: facade.plotId, surface: visible.kind }]
          : [];
      }),
    ]);
  else impressionReporter.pause();
});

window.setInterval(
  () => void impressionReporter.flush(),
  IMPRESSION_RULES.flushIntervalMs,
);
window.setInterval(() => {
  if (currentScreen === "Street" && !liveMode) updatePanel();
}, 15_000);
window.addEventListener("pagehide", () => {
  resetDriveInput();
  impressionReporter.pause();
  void impressionReporter.flush();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    resetDriveInput();
    impressionReporter.pause();
  }
});

document
  .querySelectorAll<HTMLButtonElement>("[data-screen]")
  .forEach((button) =>
    button.addEventListener("click", () => showScreen(button.dataset.screen!)),
  );
portraitDriving.addEventListener("change", () => {
  if (portraitDriving.matches) {
    completeCurbCrossing();
    resetDriveInput();
    impressionReporter.pause();
    plotPanel.classList.remove("mobile-open");
    contextDetailsButton.setAttribute("aria-expanded", "false");
  }
  status.hidden = currentScreen !== "Street" || portraitDriving.matches;
});
networkButton.addEventListener("click", () => showScreen("Testnet"));
modeButton.addEventListener("click", toggleStreetMode);
document
  .querySelector<HTMLButtonElement>("#guest-building-edit")!
  .addEventListener("click", () => showScreen("Studio"));
document
  .querySelector<HTMLButtonElement>("#guest-building-reset")!
  .addEventListener("click", () => {
    guestBuildingPreview = null;
    updateGuestBuildingBanner();
    drawWorld();
    updatePanel();
  });
document
  .querySelector<HTMLButtonElement>("#panel-design")!
  .addEventListener("click", () => {
    if (liveMode || selection.kind !== "Plot") return;
    designTargetId = selection.id;
    showScreen("Designs");
  });
actionButton.addEventListener("click", () => action());
panelAction.addEventListener("click", () => action());
towerFloorSelect.addEventListener("change", () => {
  selectedTowerFloor = Number(towerFloorSelect.value);
  updatePanel();
});
contextDetailsButton.addEventListener("click", () => {
  openPlotPanel();
});
collectButton.addEventListener("click", collectParkedCar);
panelCollect.addEventListener("click", collectParkedCar);
crossSideButton.addEventListener("click", crossStreet);
document
  .querySelector<HTMLButtonElement>("#close-panel")!
  .addEventListener("click", () => {
    plotPanel.classList.add("closed");
    plotPanel.classList.remove("mobile-open");
    contextDetailsButton.setAttribute("aria-expanded", "false");
    requestAnimationFrame(() =>
      app.renderer.resize(canvasHost.clientWidth, canvasHost.clientHeight),
    );
  });
for (const [id, direction] of [
  ["left", -1],
  ["right", 1],
] as const) {
  const button = document.querySelector<HTMLButtonElement>(`#${id}`)!;
  button.addEventListener("pointerdown", (event) => {
    if (
      currentScreen !== "Street" ||
      portraitDriving.matches ||
      activeCarIsParked()
    )
      return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    closePlotPanelForDriving();
    drivePointers.set(event.pointerId, {
      direction,
      pressedAt: performance.now(),
    });
    updateDriveInput();
  });
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  const release = (event: PointerEvent, tap: boolean) => {
    const press = drivePointers.get(event.pointerId);
    if (!press) return;
    drivePointers.delete(event.pointerId);
    updateDriveInput();
    if (
      tap &&
      performance.now() - press.pressedAt < 180 &&
      drivePointers.size === 0 &&
      driveKeys.size === 0
    )
      moveCarBy(press.direction * TAP_DRIVE_DISTANCE);
  };
  button.addEventListener("pointerup", (event) => release(event, true));
  button.addEventListener("pointercancel", (event) => release(event, false));
  button.addEventListener("lostpointercapture", (event) =>
    release(event, false),
  );
  window.addEventListener("pointerup", (event) => release(event, true));
  window.addEventListener("pointercancel", (event) => release(event, false));
}
const releaseFinishedTouches = (event: TouchEvent) => {
  if (event.touches.length > 0 || drivePointers.size === 0) return;
  drivePointers.clear();
  updateDriveInput();
};
document.addEventListener("touchend", releaseFinishedTouches);
document.addEventListener("touchcancel", releaseFinishedTouches);
window.addEventListener("keydown", (event) => {
  if (currentScreen !== "Street" || portraitDriving.matches) return;
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  const key = event.key.startsWith("Arrow")
    ? event.key
    : event.key.toLowerCase();
  if (!activeCarIsParked()) {
    const direction =
      key === "ArrowLeft" || key === "a"
        ? -1
        : key === "ArrowRight" || key === "d"
          ? 1
          : 0;
    if (direction) {
      if (event.key.startsWith("Arrow")) event.preventDefault();
      closePlotPanelForDriving();
      if (!driveKeys.has(key)) driveKeys.set(key, direction);
      updateDriveInput();
    }
  }
  if (event.code === "Space") {
    event.preventDefault();
    action();
  }
});
window.addEventListener("keyup", (event) => {
  const key = event.key.startsWith("Arrow")
    ? event.key
    : event.key.toLowerCase();
  if (driveKeys.delete(key)) updateDriveInput();
});
