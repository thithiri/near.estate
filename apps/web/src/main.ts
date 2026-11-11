import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Text } from "pixi.js";
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
  validateAssetManifest,
  validateCitySeed,
  type AssetManifest,
  type NPCSite,
  type ChainStreetSide,
} from "@estate/shared";
import rawSeed from "../../../contracts/estate/seed.json";
import {
  cityMapPoint,
  connectionAtX,
  destination,
  endConnection,
  frontageAtX,
  frontageX,
  FRONTAGE_PITCH,
  INTERSECTION_GAP,
  intersectionX,
  roadWidth,
  type Road,
  type RoadConnection,
} from "./city-navigation.js";
import { MockGame, type MockSession } from "./mock-game.js";
import { visibleMediaHash, visibleMediaLink } from "./media-view.js";
import { plotEarningPreview, towerEarningPreview } from "./plot-earnings.js";
import { streetSceneKey } from "./street-scene-key.js";
import type { ChainScreen } from "./chain-screen.js";
import type { ChainReader } from "./chain-reader.js";
import type { LiveStreet } from "./live-street.js";
import type { GameWalletClient } from "./wallet-client.js";
import { createPresetFacade, PresetTextureCache } from "./preset-renderer.js";
import { facadePreset } from "./preset-catalog.js";
import { illustratedPreviewForPlot } from "./illustrated-preview.js";
import { MockStudio } from "./studio-screen.js";
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

const city = validateCitySeed(rawSeed);
const game = new MockGame(city);
if (
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).has("full-curbs")
) {
  const visitor = game.sessions.get(`c:${game.ownedPlotId}:0`);
  if (!visitor) throw new Error("Full-curb preview needs its visitor session");
  for (const plot of city.plots) {
    for (const space of [0, 1]) {
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
let moving = 0;
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
let renderedLiveSceneKey: string | null = null;
const facadeTextures = new PresetTextureCache();
const impressionReporter = new ImpressionReporter();
const approvedManifests = new Map<string, AssetManifest>();
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

function requestApprovedManifest(hash: string): void {
  if (approvedManifests.has(hash) || loadingManifests.has(hash)) return;
  loadingManifests.add(hash);
  void fetch(`/api/manifests/${hash}`)
    .then(async (response) => {
      if (!response.ok) return;
      const manifest = validateAssetManifest(await response.json());
      if ((await manifestHash(manifest)) !== hash)
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
const studio = new MockStudio(
  ownedPlot,
  [
    city.plots.find((plot) => plot.id === "plot-main-n-2")!,
    city.plots.find((plot) => plot.id === "plot-main-n-4")!,
  ],
  () => showScreen("My Plots"),
  () => currentScreen === "Studio",
);
let statsInitialPlotId: string | undefined;
const statsScreen = new AdvertiserStatsScreen(
  otherScreen,
  city.plots.map((plot) => ({
    id: plot.id,
    label: `${city.streets.find((street) => street.id === plot.roadId)?.name ?? plot.roadId} · ${plot.side} · Plot ${plot.index + 1} · ${plot.initialType}`,
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

function selectionAtCar(): Selection {
  const road = currentRoad();
  const crossing = connectionAtX(road, carX);
  if (crossing) return { kind: "Connection", connection: crossing };
  const index = frontageAtX(road, carX);
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

function crossStreet(): void {
  side = side === "North" ? "South" : "North";
  selection = selectionAtCar();
  drawWorld();
  updatePanel();
  if (liveMode) void liveStreet?.refresh();
  status.textContent = `Viewing the ${side.toLowerCase()} side of ${currentRoad().name}.`;
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
    x: frontageX(road, index) + FRONTAGE_PITCH / 2,
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
      fontFamily: "Arial, sans-serif",
      fontWeight: "bold",
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
    .rect(start, 170, INTERSECTION_GAP, 120)
    .fill(0x647486)
    .rect(start, 170, INTERSECTION_GAP, 20)
    .fill(0x8a9aa7)
    .rect(start, 190, INTERSECTION_GAP, 16)
    .fill(0xe7d7c7)
    .rect(center - 2, 172, 4, 19)
    .fill(0x14213d)
    .roundRect(center - 58, 151, 116, 23, 5)
    .fill(0xffca24)
    .stroke({ color: 0x14213d, width: 2 });
  for (let stripe = 0; stripe < 3; stripe++) {
    graphic.rect(start + 8 + stripe * 23, 250, 12, 30).fill(0xfff8e9);
  }
  const signText = label(`↗ ${destinationName}`, 9);
  signText.anchor.set(0.5);
  signText.position.set(center, 163);
  group.addChild(graphic, signText);
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
    .roundRect(x, 160, 106, 25, 5)
    .fill(0xffca24)
    .stroke({ color: 0x14213d, width: 2 });
  const text = label(`${left ? "←" : "→"} ${destinationName}`, 9);
  text.anchor.set(0.5);
  text.position.set(x + 53, 172);
  group.addChild(board, text);
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
  world.removeChildren().forEach((child) => child.destroy({ children: true }));
  const road = currentRoad();
  drawBackdrop(road);
  const width = roadWidth(road);
  const base = new Graphics();
  base.rect(0, 170, width, 20).fill(0xa8d9a1);
  base.rect(0, 190, width, 16).fill(0xf6e3d6);
  base.rect(0, 206, width, 40).fill(0x7d8998);
  base.rect(0, 246, width, 44).fill(0x5c6878);
  base.rect(0, 290, width, 10).fill(0x499b6d);
  for (let x = 0; x < width; x += 62)
    base.rect(x + 8, 268, 30, 3).fill(0xfff8e9);
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
  for (const plot of plots) {
    const chainEntry = chainSide?.plots.find(
      (entry) => entry.plot.plot.id === plot.id,
    );
    const building = chainEntry?.plot.plot.building;
    const approvedHash = building?.approved_manifest_hash;
    if (approvedHash) requestApprovedManifest(approvedHash);
    const approvedManifest = approvedHash
      ? approvedManifests.get(approvedHash)
      : undefined;
    const x = frontageX(road, plot.index);
    const illustratedPreview = !liveMode
      ? illustratedPreviewForPlot(plot)
      : null;
    const facade = createPresetFacade(
      building
        ? {
            ...plot,
            initialType: building.building_type,
            initialVariant: building.variant,
          }
        : plot,
      x,
      building
        ? {
            level: building.level,
            palette: building.primary_color,
            name: building.name,
            approvedManifest:
              approvedManifest?.buildingType === building.building_type &&
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
        : plot.id === game.ownedPlotId && !liveMode
          ? { level: 1, palette: "#F6C85F" }
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
    facade.group.on("pointertap", () => {
      selection = { kind: "Plot", id: plot.id };
      openPlotPanel();
      updatePanel();
    });
    world.addChild(facade.group);
    facades.push(facade);
    const stalls = new Graphics();
    for (let slot = 0 as 0 | 1; slot < 2; slot = (slot + 1) as 0 | 1) {
      const sx = x + 18 + slot * 70;
      stalls.rect(sx, 210, 64, 30).stroke({ color: 0xffffff, width: 2 });
      const parked = liveMode
        ? chainEntry?.slots[slot]
        : game.sessions.get(`c:${plot.id}:${slot}`);
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
        if (
          "expires_at" in parked &&
          Math.floor(Date.now() / 1000) >= parked.expires_at
        )
          continue;
        world.addChild(
          createCarSprite(
            sx + 32,
            229,
            parkedCar?.body ?? "Sedan",
            parkedCar?.color ?? "Blue",
            isCurrent &&
              (liveMode
                ? Boolean(liveStreet?.player?.account?.burger_decal)
                : game.burgerDecal),
          ),
        );
      }
    }
    stalls.eventMode = "static";
    stalls.cursor = "pointer";
    stalls.on("pointertap", () => {
      selection = { kind: "Plot", id: plot.id };
      openPlotPanel();
      updatePanel();
    });
    world.addChild(stalls);
    const rule = label(
      liveMode
        ? chainEntry?.plot.effective_rule.kind === "NoParking"
          ? "NO P"
          : chainEntry?.plot.effective_rule.kind === "Meter"
            ? "METER"
            : chainEntry?.plot.effective_rule.kind === "ColorOnly"
              ? "COLOR"
              : "FREE"
        : game.rules.get(plot.id) === "NoParking"
          ? "NO P"
          : "FREE",
      9,
      "#ffffff",
    );
    rule.anchor.set(0.5);
    rule.position.set(x + 85, 199);
    const sign = new Graphics()
      .roundRect(x + 64, 188, 42, 20, 8)
      .fill(
        (
          liveMode
            ? chainEntry?.plot.effective_rule.kind === "NoParking"
            : game.rules.get(plot.id) === "NoParking"
        )
          ? 0xe35c61
          : 0x28ba86,
      )
      .stroke({ color: 0x14213d, width: 1 });
    world.addChild(sign, rule);
  }
  facadeTextures.setViews(facades);
  for (const site of city.npcSites.filter(
    (entry) => entry.roadId === roadId && entry.side === side,
  )) {
    const x = frontageX(road, site.frontageIndex);
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
            229,
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
    273,
    liveMode ? (liveStreet?.selectedCar?.body ?? "Hatchback") : game.car.body,
    liveMode ? (liveStreet?.selectedCar?.color ?? "Red") : game.car.color,
    liveMode
      ? Boolean(liveStreet?.player?.account?.burger_decal)
      : game.burgerDecal,
  );
  carSprite.visible = liveMode
    ? Boolean(liveStreet?.selectedCar) && !activeCarIsParked()
    : !game.activeCarSession();
  world.addChild(carSprite);
  document.querySelector<HTMLElement>("#street-name")!.textContent = road.name;
  document.querySelector<HTMLElement>("#mobile-street-name")!.textContent =
    road.name;
  document.querySelector<HTMLElement>("#street-side")!.textContent =
    `${side} side`;
  crossSideButton.textContent = `Cross to ${side === "North" ? "South" : "North"}`;
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
    title = `Cross street · ${next?.name ?? target.connection.toRoadId}`;
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
          carX -
            (frontageX(currentRoad(), site.frontageIndex) + FRONTAGE_PITCH / 2),
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
    title = `${plot.initialType} · Plot ${plot.index + 1}`;
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
    spaces = `${curbOpen} of 2 spaces free`;
    const nearby =
      Math.abs(
        carX - (frontageX(currentRoad(), plot.index) + FRONTAGE_PITCH / 2),
      ) <= 100;
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
  actionButton.textContent = mode;
  panelAction.textContent = mode;
  actionButton.disabled = !enabled;
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
    title = `Cross street · ${next?.name ?? target.connection.toRoadId}`;
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
          carX -
            (frontageX(currentRoad(), site.frontageIndex) + FRONTAGE_PITCH / 2),
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
      spaces = `${entry.slots.filter((slot) => !slot || now >= slot.expires_at).length} of 2 spaces free`;
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
        Math.abs(
          carX - (frontageX(currentRoad(), plot.index) + FRONTAGE_PITCH / 2),
        ) <= 100;
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
  actionButton.textContent = mode;
  panelAction.textContent = mode;
  actionButton.disabled = !enabled;
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

function action(): void {
  if (liveMode) {
    void liveAction();
    return;
  }
  if (actionButton.disabled) {
    status.textContent = "Drive beside a parking space or intersection first.";
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
        message = `Parked on floor ${selectedTowerFloor + 1}, space ${(session.space % TOWER_SPACES_PER_FLOOR) + 1}. Return to collect earnings.`;
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
      [...game.sessions.values()].some(
        (entry) => entry.locationId === target.id && !entry.legal,
      )
    )
      message = `Ticketed visitor for ${formatCoins(game.ticket(target.id).toString())} coins`;
    else if (target.kind === "Plot") {
      const session = game.park(target.id);
      message = `Parked in space ${session.space + 1}. Return to collect earnings.`;
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

async function liveAction(): Promise<void> {
  if (actionButton.disabled) return;
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
      status.textContent = `Parked on floor ${Math.floor(space / TOWER_SPACES_PER_FLOOR) + 1}, space ${(space % TOWER_SPACES_PER_FLOOR) + 1} on testnet.`;
    } else if (target.kind === "Plot") {
      const entry = livePlot(target.id);
      if (!entry) throw new Error("Plot state is still loading");
      const now = Math.floor(Date.now() / 1000);
      const illegal = entry.slots.find(
        (slot) => slot && !slot.legal && now < slot.expires_at,
      );
      if (
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
        const slot = entry.slots.findIndex(
          (occupied) => !occupied || now >= occupied.expires_at,
        );
        if (slot < 0) throw new Error("Both curb spaces are occupied");
        await live.call("park", {
          car_id: live.selectedCar.id,
          plot_id: target.id,
          slot,
        });
        status.textContent = `Parked in curb space ${slot + 1} on testnet.`;
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
  const marker = parkedCarLocation
    ? parkedLocation(parkedCarLocation)
    : { roadId, side, x: carX };
  const markerRoad = city.streets.find((entry) => entry.id === marker.roadId)!;
  const markerPoint = cityMapPoint(city, marker.roadId, marker.x);
  return `<h1>City map</h1>
    <p class="muted">${parkedActiveCar ? `Active car parked on ${markerRoad.name}, ${marker.side.toLowerCase()} side. Viewing ${currentRoad().name}.` : liveMode ? `Shared testnet city · Viewing ${currentRoad().name}, ${side.toLowerCase()} side.${activeSession ? " Another car is earning while you explore." : ""}` : `Five connected roads · ${game.car.body} is on ${currentRoad().name}, ${side.toLowerCase()} side.${activeSession ? " Another car is earning while you drive." : ""}`}</p>
    <svg class="city-map" viewBox="0 0 500 300" role="img" aria-label="Five-road city map showing your current position">
      <title>near.estate city streets</title>
      <path class="map-road" d="M50 65H450 M50 150H450 M50 235H450 M180 40V260 M320 40V260 M50 65Q20 65 20 108Q20 150 50 150 M450 150Q480 150 480 193Q480 235 450 235" />
      <text x="55" y="54">Main Street</text><text x="55" y="139">Market Street</text><text x="55" y="224">River Street</text>
      <text x="180" y="30" text-anchor="middle">Central Ave</text><text x="320" y="30" text-anchor="middle">Harbor Ave</text>
      <circle class="map-position-ring" cx="${markerPoint.x}" cy="${markerPoint.y}" r="12" />
      <circle class="map-position" cx="${markerPoint.x}" cy="${markerPoint.y}" r="6" />
    </svg>
    <div class="road-list" aria-label="Choose a street">${city.streets
      .map(
        (street) =>
          `<button data-road="${street.id}" ${street.id === marker.roadId ? 'aria-current="location"' : ""}>${street.name}${street.id === marker.roadId ? (parkedActiveCar ? " · car parked" : " · here") : street.id === roadId ? " · viewing" : ""}</button>`,
      )
      .join("")}</div>
    <p><button id="cross-street">Cross to the ${side === "North" ? "South" : "North"} side</button></p>
    <h2>Game-owned parking towers</h2>
    <div class="road-list">${city.npcSites
      .filter((site) => site.role === "ParkingTower")
      .map(
        (site) =>
          `<button data-tower="${site.id}">${site.name}${liveMode ? " · view tower" : ` · ${game.towerAvailability(site.id)}/${site.capacity} open`}</button>`,
      )
      .join("")}</div>
    <h2>Other city stops</h2><div class="road-list">${city.npcSites
      .filter((site) => site.role !== "ParkingTower")
      .map((site) => `<button data-site="${site.id}">${site.name}</button>`)
      .join("")}</div>
    <h2>City data</h2><div class="road-list"><button id="map-stats">Browse advertiser stats</button></div>`;
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
      <p>${ownedPlot.initialType} · Level 1 · Shape ${ownedPlot.initialVariant}</p>
      <p>Rule: ${game.rules.get(ownedPlot.id) === "NoParking" ? "No parking" : "Free"}</p>
      <p class="muted">${visitor ? "An illegal visitor is parked here for the ticket demo." : "No illegal visitors are currently parked."}</p>
      <button id="visit-owned">Visit plot</button>
    </article>
    <article class="card"><h2>Build your place</h2>
      <p>Explore five building types, two shapes, four levels and four colours beside real neighbours.</p>
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
  if (screen !== "Street" || portraitDriving.matches) moving = 0;
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
    otherScreen
      .querySelector<HTMLButtonElement>("#map-stats")!
      .addEventListener("click", () =>
        openStats(selection.kind === "Plot" ? selection.id : undefined),
      );
    otherScreen
      .querySelectorAll<HTMLButtonElement>("[data-road]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          const road = city.streets.find(
            (entry) => entry.id === button.dataset.road,
          );
          if (!road) return;
          moveToRoad(road.id, side, frontageX(road, 0) + FRONTAGE_PITCH / 2);
          showScreen("Street");
        }),
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
        button.addEventListener("click", () => {
          const site = city.npcSites.find(
            (entry) => entry.id === button.dataset.tower,
          );
          if (!site) return;
          const road = city.streets.find((entry) => entry.id === site.roadId)!;
          moveToRoad(
            site.roadId,
            site.side,
            frontageX(road, site.frontageIndex) + FRONTAGE_PITCH / 2,
          );
          showScreen("Street");
        }),
      );
    otherScreen
      .querySelectorAll<HTMLButtonElement>("[data-site]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          const site = city.npcSites.find(
            (entry) => entry.id === button.dataset.site,
          );
          if (!site) return;
          const road = city.streets.find((entry) => entry.id === site.roadId)!;
          moveToRoad(
            site.roadId,
            site.side,
            frontageX(road, site.frontageIndex) + FRONTAGE_PITCH / 2,
          );
          activeSiteId = site.id;
          showScreen("Destination");
        }),
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
          frontageX(road, ownedPlot.index) + FRONTAGE_PITCH / 2,
        );
        showScreen("Street");
      });
    otherScreen
      .querySelector<HTMLButtonElement>("#open-studio")!
      .addEventListener("click", () => showScreen("Studio"));
    otherScreen
      .querySelector<HTMLButtonElement>("#open-stats")!
      .addEventListener("click", () => openStats(ownedPlot.id));
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
        city.npcSites,
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
    if (!liveStreet) {
      const [reader, { LiveStreet }] = await Promise.all([
        getReader(),
        import("./live-street.js"),
      ]);
      if (!liveMode) return;
      liveStreet = new LiveStreet(
        reader,
        getWalletClient,
        () => ({ roadId: currentRoad().id, side }),
        city.npcSites,
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
  if (!contractId) return;
  impressionReporter.pause();
  liveMode = !liveMode;
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
  antialias: true,
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
app.ticker.add((ticker) => {
  if (currentScreen !== "Street" || portraitDriving.matches) return;
  const dt = Math.min(ticker.deltaMS / 1000, 0.05);
  if (moving) {
    if (activeCarIsParked()) {
      moving = 0;
      return;
    }
    const road = currentRoad();
    const width = roadWidth(road);
    const nextX = carX + moving * 100 * dt;
    if (nextX < 25 || nextX > width - 25) {
      const exit = endConnection(road, moving < 0 ? -1 : 1);
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
    impressionReporter.observe(
      facadeTextures.visibleAdSurfaces(
        cameraLeft,
        visibleWidth,
        canvasHost.clientHeight / scale,
      ),
    );
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
  impressionReporter.pause();
  void impressionReporter.flush();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) impressionReporter.pause();
});

document
  .querySelectorAll<HTMLButtonElement>("[data-screen]")
  .forEach((button) =>
    button.addEventListener("click", () => showScreen(button.dataset.screen!)),
  );
portraitDriving.addEventListener("change", () => {
  if (portraitDriving.matches) {
    moving = 0;
    impressionReporter.pause();
    plotPanel.classList.remove("mobile-open");
    contextDetailsButton.setAttribute("aria-expanded", "false");
  }
  status.hidden = currentScreen !== "Street" || portraitDriving.matches;
});
networkButton.addEventListener("click", () => showScreen("Testnet"));
modeButton.addEventListener("click", toggleStreetMode);
actionButton.addEventListener("click", action);
panelAction.addEventListener("click", action);
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
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    closePlotPanelForDriving();
    moving = direction;
  });
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  button.addEventListener("pointerup", () => {
    moving = 0;
  });
  button.addEventListener("pointercancel", () => {
    moving = 0;
  });
  button.addEventListener("lostpointercapture", () => {
    moving = 0;
  });
}
window.addEventListener("keydown", (event) => {
  if (currentScreen !== "Street" || portraitDriving.matches) return;
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  if (!activeCarIsParked()) {
    if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") {
      if (event.key === "ArrowLeft") event.preventDefault();
      closePlotPanelForDriving();
      moving = -1;
    }
    if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") {
      if (event.key === "ArrowRight") event.preventDefault();
      closePlotPanelForDriving();
      moving = 1;
    }
  }
  if (event.code === "Space") {
    event.preventDefault();
    action();
  }
});
window.addEventListener("keyup", (event) => {
  if (["ArrowLeft", "ArrowRight", "a", "d", "A", "D"].includes(event.key))
    moving = 0;
});
