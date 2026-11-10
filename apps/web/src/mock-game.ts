import {
  CarBody,
  CarColor,
  DEFAULT_CONFIG,
  TOWER_FLOORS,
  TOWER_SPACES_PER_FLOOR,
  settleParking,
  snapshotParkingTerms,
  type CitySeed,
  type ParkingTerms,
  type PlayerPlot,
} from "@estate/shared";

export interface MockCar {
  id: string;
  body: string;
  color: string;
  tier: 1 | 2 | 3;
  durability: number;
}
export interface MockSession {
  id: string;
  facility: "Curb" | "Tower";
  locationId: string;
  space: number;
  driver: string;
  carId: string;
  startedAt: number;
  legal: boolean;
  terms: ParkingTerms;
  earnUntil: number;
  expiresAt: number;
}

export class MockGame {
  readonly cars: MockCar[] = [
    {
      id: "starter",
      body: "Hatchback",
      color: "Red",
      tier: 1,
      durability: 100,
    },
  ];
  activeCarId = "starter";
  balance = BigInt(DEFAULT_CONFIG.starterCoins);
  burgerDecal = false;
  readonly sessions = new Map<string, MockSession>();
  readonly ownedPlotId = "plot-main-n-3";
  readonly rules = new Map<string, "Free" | "NoParking">([
    [this.ownedPlotId, "NoParking"],
  ]);
  private nextSession = 1;
  private nextCar = 2;
  private ticketCooldownUntil = 0;

  constructor(
    readonly city: CitySeed,
    readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.sessions.set(`c:${this.ownedPlotId}:0`, {
      id: "sample-illegal",
      facility: "Curb",
      locationId: this.ownedPlotId,
      space: 0,
      driver: "visitor",
      carId: "visitor-car",
      startedAt: this.nowSeconds() - 120,
      legal: false,
      terms: snapshotParkingTerms(
        DEFAULT_CONFIG,
        1,
        false,
        false,
        "0",
        "guest",
      ),
      earnUntil: this.nowSeconds() - 120 + DEFAULT_CONFIG.earnCapSeconds,
      expiresAt:
        this.nowSeconds() -
        120 +
        DEFAULT_CONFIG.earnCapSeconds +
        DEFAULT_CONFIG.expiryGraceSeconds,
    });
  }

  plot(id: string): PlayerPlot {
    const plot = this.city.plots.find((entry) => entry.id === id);
    if (!plot) throw new Error("Unknown plot");
    return plot;
  }

  get car(): MockCar {
    const car = this.cars.find((entry) => entry.id === this.activeCarId);
    if (!car) throw new Error("Active car is missing");
    return car;
  }

  activeCarSession(): MockSession | undefined {
    const session = this.playerSession();
    return session?.carId === this.activeCarId ? session : undefined;
  }

  selectCar(carId: string): void {
    if (!this.cars.some((entry) => entry.id === carId))
      throw new Error("Car is not in your garage");
    this.activeCarId = carId;
  }

  buyCar(body: string, color: string): MockCar {
    CarBody.parse(body);
    CarColor.parse(color);
    if (this.cars.length >= DEFAULT_CONFIG.maxCars)
      throw new Error("Garage is full (3 cars)");
    const cost = BigInt(DEFAULT_CONFIG.buyCarCost);
    if (this.balance < cost) throw new Error("Not enough coins for a car");
    this.balance -= cost;
    const car: MockCar = {
      id: `mock-car-${this.nextCar++}`,
      body,
      color,
      tier: 1,
      durability: 100,
    };
    this.cars.push(car);
    this.activeCarId = car.id;
    return car;
  }

  buyBurgerDecal(): void {
    if (this.burgerDecal) throw new Error("Burger decal already owned");
    const cost = BigInt(DEFAULT_CONFIG.burgerDecalCost);
    if (this.balance < cost)
      throw new Error("Not enough coins for the burger decal");
    this.balance -= cost;
    this.burgerDecal = true;
  }

  upgradeCar(): void {
    if (this.activeCarSession())
      throw new Error("Collect this car before upgrading");
    if (this.car.tier >= 3) throw new Error("Car is already tier 3");
    const cost = BigInt(DEFAULT_CONFIG.tierUpgradeCosts[this.car.tier - 1]!);
    if (this.balance < cost) throw new Error("Not enough coins for upgrade");
    this.balance -= cost;
    this.car.tier = (this.car.tier + 1) as 1 | 2 | 3;
  }

  playerSession(): MockSession | undefined {
    return [...this.sessions.values()].find(
      (entry) => entry.driver === "guest",
    );
  }

  openSlot(plotId: string): 0 | 1 | undefined {
    if (this.curbSpaceOpen(plotId, 0)) return 0;
    if (this.curbSpaceOpen(plotId, 1)) return 1;
    return undefined;
  }

  curbAvailability(plotId: string): number {
    this.plot(plotId);
    return [0, 1].filter((space) => this.curbSpaceOpen(plotId, space)).length;
  }

  private curbSpaceOpen(plotId: string, space: number): boolean {
    const session = this.sessions.get(`c:${plotId}:${space}`);
    return !session || this.nowSeconds() >= session.expiresAt;
  }

  towerAvailability(siteId: string): number {
    return this.towerFloorAvailability(siteId).reduce(
      (total, available) => total + available,
      0,
    );
  }

  towerFloorAvailability(siteId: string): number[] {
    const site = this.city.npcSites.find((entry) => entry.id === siteId);
    if (!site || site.role !== "ParkingTower")
      throw new Error("Unknown parking tower");
    return Array.from(
      { length: TOWER_FLOORS },
      (_, floor) =>
        Array.from(
          { length: TOWER_SPACES_PER_FLOOR },
          (_, space) => floor * TOWER_SPACES_PER_FLOOR + space,
        ).filter((space) => {
          const session = this.sessions.get(`t:${siteId}:${space}`);
          return !session || this.nowSeconds() >= session.expiresAt;
        }).length,
    );
  }

  towerFloorSessions(siteId: string, floor: number): (MockSession | null)[] {
    const site = this.city.npcSites.find((entry) => entry.id === siteId);
    if (!site || site.role !== "ParkingTower")
      throw new Error("Unknown parking tower");
    if (!Number.isInteger(floor) || floor < 0 || floor >= TOWER_FLOORS)
      throw new Error("Invalid parking tower floor");
    return Array.from({ length: TOWER_SPACES_PER_FLOOR }, (_, offset) => {
      const space = floor * TOWER_SPACES_PER_FLOOR + offset;
      const session = this.sessions.get(`t:${siteId}:${space}`);
      return session && this.nowSeconds() < session.expiresAt ? session : null;
    });
  }

  park(plotId: string): MockSession {
    this.settleExpired();
    this.plot(plotId);
    if (this.playerSession()) throw new Error("Collect your parked car first");
    if (plotId === this.ownedPlotId)
      throw new Error("Your own curb cannot earn coins");
    if (this.car.durability < DEFAULT_CONFIG.parkDurabilityCost)
      throw new Error("Repair the car before parking");
    const slot = this.openSlot(plotId);
    if (slot === undefined) throw new Error("Both spaces are occupied");
    const startedAt = this.nowSeconds();
    const legal = this.rules.get(plotId) !== "NoParking";
    const session: MockSession = {
      id: `mock-${this.nextSession++}`,
      facility: "Curb",
      locationId: plotId,
      space: slot,
      driver: "guest",
      carId: this.car.id,
      startedAt,
      legal,
      terms: snapshotParkingTerms(
        DEFAULT_CONFIG,
        this.car.tier,
        legal,
        false,
        "0",
        null,
      ),
      earnUntil: startedAt + DEFAULT_CONFIG.earnCapSeconds,
      expiresAt:
        startedAt +
        DEFAULT_CONFIG.earnCapSeconds +
        DEFAULT_CONFIG.expiryGraceSeconds,
    };
    this.sessions.set(`c:${plotId}:${slot}`, session);
    this.car.durability -= DEFAULT_CONFIG.parkDurabilityCost;
    return session;
  }

  parkTower(siteId: string, floor = 0): MockSession {
    this.settleExpired();
    const site = this.city.npcSites.find((entry) => entry.id === siteId);
    if (!site || site.role !== "ParkingTower")
      throw new Error("Unknown parking tower");
    if (!Number.isInteger(floor) || floor < 0 || floor >= TOWER_FLOORS)
      throw new Error("Invalid parking tower floor");
    if (this.playerSession()) throw new Error("Collect your parked car first");
    if (this.car.durability < DEFAULT_CONFIG.parkDurabilityCost)
      throw new Error("Repair the car before parking");
    const space = Array.from(
      { length: TOWER_SPACES_PER_FLOOR },
      (_, index) => floor * TOWER_SPACES_PER_FLOOR + index,
    ).find((index) => !this.sessions.has(`t:${siteId}:${index}`));
    if (space === undefined)
      throw new Error("This parking tower floor is full");
    const startedAt = this.nowSeconds();
    const session: MockSession = {
      id: `mock-${this.nextSession++}`,
      facility: "Tower",
      locationId: siteId,
      space,
      driver: "guest",
      carId: this.car.id,
      startedAt,
      legal: true,
      terms: snapshotParkingTerms(
        DEFAULT_CONFIG,
        this.car.tier,
        true,
        true,
        "0",
        null,
      ),
      earnUntil: startedAt + DEFAULT_CONFIG.earnCapSeconds,
      expiresAt:
        startedAt +
        DEFAULT_CONFIG.earnCapSeconds +
        DEFAULT_CONFIG.expiryGraceSeconds,
    };
    this.sessions.set(`t:${siteId}:${space}`, session);
    this.car.durability -= DEFAULT_CONFIG.parkDurabilityCost;
    return session;
  }

  collect(): bigint {
    const session = this.playerSession();
    if (!session) throw new Error("No car is parked");
    if (this.nowSeconds() >= session.expiresAt)
      throw new Error("Session expired; settle it before parking again");
    const payout = settleParking(
      session.terms,
      this.nowSeconds() - session.startedAt,
      "Collect",
    ).driverPayout;
    this.balance += payout;
    this.sessions.delete(this.sessionKey(session));
    return payout;
  }

  settleExpired(): void {
    for (const [key, session] of this.sessions) {
      if (this.nowSeconds() < session.expiresAt) continue;
      const settlement = settleParking(
        session.terms,
        this.nowSeconds() - session.startedAt,
        "Expire",
      );
      if (session.driver === "guest") this.balance += settlement.driverPayout;
      this.sessions.delete(key);
    }
  }

  ticket(plotId: string): bigint {
    if (plotId !== this.ownedPlotId)
      throw new Error("You do not own this plot");
    const session = [...this.sessions.values()].find(
      (entry) =>
        entry.facility === "Curb" &&
        entry.locationId === plotId &&
        !entry.legal &&
        entry.driver !== "guest",
    );
    if (!session) throw new Error("There is no illegal visitor to ticket");
    if (this.nowSeconds() >= session.expiresAt)
      throw new Error("Parking session expired");
    if (this.nowSeconds() < this.ticketCooldownUntil)
      throw new Error("Ticket cooldown is active");
    const payout = settleParking(
      session.terms,
      this.nowSeconds() - session.startedAt,
      "Ticket",
    ).recipientPayout;
    this.balance += payout;
    this.sessions.delete(this.sessionKey(session));
    this.ticketCooldownUntil =
      this.nowSeconds() + DEFAULT_CONFIG.ticketCooldownSeconds;
    return payout;
  }

  repair(points: number): void {
    if (this.activeCarSession())
      throw new Error("Collect your car before repairing");
    if (
      !Number.isSafeInteger(points) ||
      points <= 0 ||
      this.car.durability + points > 100
    )
      throw new Error("Invalid repair amount");
    const price = BigInt(DEFAULT_CONFIG.repairCostPerPoint) * BigInt(points);
    if (this.balance < price) throw new Error("Not enough coins");
    this.balance -= price;
    this.car.durability += points;
  }

  private sessionKey(session: MockSession): string {
    return `${session.facility === "Tower" ? "t" : "c"}:${session.locationId}:${session.space}`;
  }
}
