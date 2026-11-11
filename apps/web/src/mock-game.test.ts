import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  MockClock,
  coins,
  validateCitySeed,
} from "@estate/shared";
import { MockGame } from "./mock-game.js";

const path = fileURLToPath(
  new URL("../../../contracts/estate/seed.json", import.meta.url),
);
const city = validateCitySeed(JSON.parse(readFileSync(path, "utf8")));

test("mock parking caps earnings and frees the slot once", () => {
  const clock = new MockClock(10_000);
  const game = new MockGame(city, () => clock.nowSeconds());
  const session = game.park("plot-main-n-0");
  assert.equal(session.legal, true);
  assert.equal(game.car.durability, 98);
  clock.advance(1_800);
  assert.equal(game.collect(), BigInt(coins(30)));
  assert.equal(game.openSlot("plot-main-n-0"), 0);
  assert.throws(() => game.collect());
});

test("mock expiry retains capped payout and allows reuse", () => {
  const clock = new MockClock(10_000);
  const game = new MockGame(city, () => clock.nowSeconds());
  game.park("plot-main-n-0");
  clock.advance(1_920);
  game.settleExpired();
  assert.equal(game.balance, BigInt(coins(130)));
  assert.equal(game.playerSession(), undefined);
  assert.equal(game.openSlot("plot-main-n-0"), 0);
});

test("mock ticket pays owner and cannot ticket same session twice", () => {
  const clock = new MockClock(10_000);
  const game = new MockGame(city, () => clock.nowSeconds());
  assert.equal(game.ticket(game.ownedPlotId), 2_100_000n);
  assert.throws(() => game.ticket(game.ownedPlotId));
});

test("game-owned tower parks legally at half rate and releases its space", () => {
  const clock = new MockClock(10_000);
  const game = new MockGame(city, () => clock.nowSeconds());
  const tower = "npc-main-tower";
  assert.equal(game.towerAvailability(tower), 32);
  assert.deepEqual(game.towerFloorAvailability(tower), [8, 8, 8, 8]);
  const session = game.parkTower(tower, 2);
  assert.equal(session.facility, "Tower");
  assert.equal(session.space, 16);
  assert.equal(session.legal, true);
  assert.equal(game.towerAvailability(tower), 31);
  assert.deepEqual(game.towerFloorAvailability(tower), [8, 8, 7, 8]);
  assert.equal(game.towerFloorSessions(tower, 2).length, 8);
  assert.equal(game.towerFloorSessions(tower, 2)[0]?.id, session.id);
  assert.equal(game.towerFloorSessions(tower, 2)[1], null);
  clock.advance(1_800);
  assert.equal(game.collect(), BigInt(coins(15)));
  assert.equal(game.towerAvailability(tower), 32);
  assert.deepEqual(game.towerFloorAvailability(tower), [8, 8, 8, 8]);
  assert.equal(game.towerFloorSessions(tower, 2)[0], null);
  const expiring = game.parkTower(tower, 2);
  clock.advance(expiring.expiresAt - clock.nowSeconds());
  assert.equal(game.towerFloorSessions(tower, 2)[0], null);
  assert.deepEqual(game.towerFloorAvailability(tower), [8, 8, 8, 8]);
  assert.throws(() => game.ticket(tower));
  assert.throws(() => game.parkTower(tower, 4), /Invalid/);
  assert.throws(() => game.towerFloorSessions(tower, 4), /Invalid/);
});

test("tower parking remains available when every city curb is occupied", () => {
  const clock = new MockClock(10_000);
  const game = new MockGame(city, () => clock.nowSeconds());
  const visitor = game.sessions.get(`c:${game.ownedPlotId}:0`);
  assert.ok(visitor);
  assert.equal(city.plots.length, 80);

  for (const plot of city.plots) {
    for (const space of [0, 1]) {
      game.sessions.set(`c:${plot.id}:${space}`, {
        ...visitor,
        id: `visitor-${plot.id}-${space}`,
        locationId: plot.id,
        space,
        driver: `visitor-${plot.id}-${space}`,
      });
    }
    assert.equal(game.curbAvailability(plot.id), 0);
    assert.equal(game.openSlot(plot.id), undefined);
  }

  assert.throws(() => game.park("plot-main-n-0"), /occupied/);
  const towers = city.npcSites.filter((site) => site.role === "ParkingTower");
  assert.equal(towers.length, 3);
  for (const tower of towers)
    assert.equal(game.towerAvailability(tower.id), 32);

  const session = game.parkTower(towers[0]!.id);
  assert.equal(session.facility, "Tower");
  assert.equal(game.towerAvailability(towers[0]!.id), 31);
  clock.advance(DEFAULT_CONFIG.earnCapSeconds);
  assert.equal(game.collect(), BigInt(coins(15)));
  assert.equal(game.towerAvailability(towers[0]!.id), 32);
  assert.equal(game.curbAvailability("plot-main-n-0"), 2);
});

test("buying and selecting cars keeps one earning session while another can drive", () => {
  const clock = new MockClock(10_000);
  const game = new MockGame(city, () => clock.nowSeconds());
  game.balance = BigInt(coins(500));
  const sedan = game.buyCar("Sedan", "Blue");
  assert.equal(game.balance, BigInt(coins(350)));
  assert.equal(game.car.id, sedan.id);
  game.park("plot-main-n-0");
  assert.equal(game.activeCarSession()?.carId, sedan.id);
  game.selectCar("starter");
  assert.equal(game.activeCarSession(), undefined);
  assert.equal(game.playerSession()?.carId, sedan.id);
  assert.throws(
    () => game.park("plot-main-n-1"),
    /Collect your parked car first/,
  );
  assert.equal(game.car.durability, 100);
  clock.advance(60);
  assert.equal(game.collect(), BigInt(coins(1)));
  assert.equal(game.car.id, "starter");
  assert.equal(game.cars.find((car) => car.id === sedan.id)?.durability, 98);
  game.buyCar("Pickup", "Green");
  assert.throws(() => game.buyCar("SUV", "Yellow"), /Garage is full/);
});

test("burger decal is a one-time cosmetic purchase with no parking effect", () => {
  const game = new MockGame(city, () => 1_000);
  const balance = game.balance;
  const durability = game.car.durability;
  game.buyBurgerDecal();
  assert.equal(game.burgerDecal, true);
  assert.equal(game.balance, balance - BigInt(DEFAULT_CONFIG.burgerDecalCost));
  assert.equal(game.car.durability, durability);
  assert.throws(() => game.buyBurgerDecal(), /already owned/);
});

test("guest emergency repair restores a stranded starter car once per cooldown", () => {
  const clock = new MockClock(10_000);
  const game = new MockGame(city, () => clock.nowSeconds());
  game.car.durability = 1;
  game.balance = 0n;
  assert.equal(game.recoveryStatus().eligible, true);
  assert.equal(game.emergencyRepair(), 1);
  assert.equal(game.car.durability, DEFAULT_CONFIG.parkDurabilityCost);
  game.park("plot-main-n-0");
  assert.equal(game.car.durability, 0);
  assert.equal(game.recoveryStatus().eligible, false);
  clock.advance(
    DEFAULT_CONFIG.earnCapSeconds + DEFAULT_CONFIG.expiryGraceSeconds,
  );
  game.settleExpired();
  game.balance = 0n;
  assert.equal(game.recoveryStatus().stranded, true);
  assert.equal(game.recoveryStatus().eligible, false);
  assert.throws(() => game.emergencyRepair(), /cooldown/);
  clock.advance(DEFAULT_CONFIG.emergencyRepairCooldownSeconds);
  assert.equal(game.recoveryStatus().eligible, true);
  assert.equal(game.emergencyRepair(), DEFAULT_CONFIG.parkDurabilityCost);
});
