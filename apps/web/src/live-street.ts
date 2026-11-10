import type {
  ChainPlayerSnapshot,
  ChainSession,
  ChainStreetSide,
  ChainStreetEconomyConfig,
  NPCSite,
} from "@estate/shared";
import { ChainReader } from "./chain-reader.js";
import type {
  GameWalletClient,
  GameplayKeyStatus,
  GameplayMethod,
} from "./wallet-client.js";

type RoadSide = {
  roadId: ChainStreetSide["road_id"];
  side: ChainStreetSide["side"];
};

export class LiveStreet {
  wallet: GameWalletClient | null = null;
  player: ChainPlayerSnapshot | null = null;
  street: ChainStreetSide | null = null;
  accountId: string | null = null;
  keyStatus: GameplayKeyStatus = "none";
  selectedCarId: number | null = null;
  towerAvailable: number | null = null;
  towerFloors: number[] | null = null;
  towerSpaces: (ChainSession | null)[] | null = null;
  towerSpaceError = "";
  towerSpaceKey = "";
  economyConfig: ChainStreetEconomyConfig | null = null;
  economyConfigError = "";
  error = "";
  busy = false;
  private active = false;
  private generation = 0;
  private pollId: number | null = null;
  private subscribed = false;
  private towerSpaceRequest = 0;
  private towerSpaceLoading = false;
  private towerSpaceFetchedAt = 0;
  private economyConfigFetchedAt = 0;

  constructor(
    readonly reader: ChainReader,
    private readonly getWallet: () => Promise<GameWalletClient>,
    private readonly getRoadSide: () => RoadSide,
    private readonly sites: NPCSite[],
    private readonly onChange: () => void,
  ) {}

  get selectedCar() {
    return this.player?.cars.find((car) => car.id === this.selectedCarId);
  }

  get activeSession() {
    return this.player?.active_session;
  }

  get tower(): NPCSite | undefined {
    const { roadId, side } = this.getRoadSide();
    return this.sites.find(
      (site) =>
        site.roadId === roadId &&
        site.side === side &&
        site.role === "ParkingTower",
    );
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.refresh();
    this.pollId = window.setInterval(() => {
      if (!this.busy) void this.refresh();
    }, 15_000);
  }

  stop(): void {
    this.active = false;
    this.generation++;
    this.invalidateTowerSpaces();
    if (this.pollId !== null) window.clearInterval(this.pollId);
    this.pollId = null;
  }

  loadTowerSpaces(siteId: string, floor: number): void {
    if (!this.active) return;
    const key = `${siteId}:${floor}`;
    if (
      this.towerSpaceKey === key &&
      (this.towerSpaceLoading || Date.now() - this.towerSpaceFetchedAt < 15_000)
    )
      return;
    const request = ++this.towerSpaceRequest;
    this.towerSpaceKey = key;
    this.towerSpaces = null;
    this.towerSpaceError = "";
    this.towerSpaceLoading = true;
    void this.reader.towerFloorSessions(siteId, floor).then(
      (spaces) => {
        if (!this.active || request !== this.towerSpaceRequest) return;
        this.towerSpaces = spaces;
        this.towerSpaceFetchedAt = Date.now();
        this.towerSpaceLoading = false;
        this.onChange();
      },
      (error: unknown) => {
        if (!this.active || request !== this.towerSpaceRequest) return;
        this.towerSpaces = null;
        this.towerSpaceError =
          error instanceof Error ? error.message : "Could not load spaces";
        this.towerSpaceFetchedAt = Date.now();
        this.towerSpaceLoading = false;
        this.onChange();
      },
    );
  }

  invalidateTowerSpaces(): void {
    this.towerSpaceRequest++;
    this.towerSpaceLoading = false;
    this.towerSpaceFetchedAt = 0;
    this.towerSpaces = null;
  }

  async refresh(): Promise<void> {
    if (!this.active) return;
    const generation = ++this.generation;
    const { roadId, side } = this.getRoadSide();
    try {
      const wallet = await this.getWallet();
      if (!this.subscribed) {
        wallet.selector.store.observable.subscribe(() => {
          if (this.active) void this.refresh();
        });
        this.subscribed = true;
      }
      const accountId = wallet.accountId;
      const tower = this.tower;
      const refreshEconomyConfig =
        !this.economyConfig ||
        Date.now() - this.economyConfigFetchedAt >= 60_000;
      const [street, player, keyStatus, towerState, economyConfig] =
        await Promise.all([
          this.reader.streetSide(roadId, side),
          accountId ? this.reader.player(accountId) : Promise.resolve(null),
          accountId
            ? wallet.resumePendingKey()
            : Promise.resolve("none" as const),
          tower ? this.reader.towerState(tower.id) : Promise.resolve(null),
          refreshEconomyConfig
            ? this.reader.streetEconomyConfig().catch(() => {
                this.economyConfigError = "Earnings preview unavailable";
                return null;
              })
            : Promise.resolve(this.economyConfig),
        ]);
      if (
        !this.active ||
        generation !== this.generation ||
        wallet.accountId !== accountId
      )
        return;
      this.wallet = wallet;
      this.accountId = accountId;
      this.street = street;
      this.player = player;
      this.keyStatus = keyStatus;
      this.towerFloors = towerState?.floors ?? null;
      this.towerAvailable = towerState?.available ?? null;
      if (economyConfig) {
        this.economyConfig = economyConfig;
        this.economyConfigError = "";
        if (refreshEconomyConfig) this.economyConfigFetchedAt = Date.now();
      }
      const walletSelection = wallet.selectedCarId();
      this.selectedCarId = player?.cars.some(
        (car) => car.id === walletSelection,
      )
        ? walletSelection
        : (player?.cars[0]?.id ?? null);
      if (this.selectedCarId !== null && walletSelection !== this.selectedCarId)
        wallet.selectCar(this.selectedCarId);
      this.error = "";
      this.onChange();
    } catch (error) {
      if (!this.active || generation !== this.generation) return;
      this.street = null;
      this.player = null;
      this.towerAvailable = null;
      this.towerFloors = null;
      this.invalidateTowerSpaces();
      this.keyStatus = "none";
      this.error = error instanceof Error ? error.message : "Chain read failed";
      this.onChange();
    }
  }

  async call(method: GameplayMethod, args: object): Promise<void> {
    if (!this.wallet || !this.accountId || !this.player?.account)
      throw new Error("Connect and register a testnet wallet in Live city");
    if (this.keyStatus !== "ready")
      throw new Error("Enable the gameplay key in Live city first");
    if (this.busy) throw new Error("A testnet action is still confirming");
    this.busy = true;
    this.onChange();
    try {
      await this.wallet.gameplayCall(method, args);
    } finally {
      this.invalidateTowerSpaces();
      await this.refresh();
      this.busy = false;
      this.onChange();
    }
  }
}
