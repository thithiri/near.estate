import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, grossEarnings, MockClock } from "./config.js";
import { snapshotParkingTerms, settleParking } from "./parking.js";
import { coins, formatCoins } from "./money.js";
import {
  canonicalJson,
  decideAppearance,
  newPresetAppearance,
  proposeAppearance,
  resetAppearanceToPreset,
  validateAssetManifest,
} from "./assets.js";
import { validateCitySeed } from "./world.js";

test("economy examples retain exact integer coin amounts", () => {
  assert.equal(DEFAULT_CONFIG.plotStorageBytes, 4_096);
  assert.equal(
    grossEarnings(DEFAULT_CONFIG, 1, true, false, 300),
    BigInt(coins(5)),
  );
  assert.equal(
    grossEarnings(DEFAULT_CONFIG, 1, true, false, 1_800),
    BigInt(coins(30)),
  );
  assert.equal(
    grossEarnings(DEFAULT_CONFIG, 1, true, true, 1_800),
    BigInt(coins(15)),
  );
  assert.equal(
    grossEarnings(DEFAULT_CONFIG, 1, false, false, 1_800),
    BigInt(coins(45)),
  );
  assert.equal(
    grossEarnings(DEFAULT_CONFIG, 1, true, false, 99_999),
    BigInt(coins(30)),
  );
  assert.equal(formatCoins("123450000"), "123.45");
});

test("mock clock advances deterministically", () => {
  const clock = new MockClock(100);
  clock.advance(17);
  assert.equal(clock.nowSeconds(), 117);
  assert.throws(() => clock.advance(-1));
});

test("session snapshots preserve payouts through later config changes", () => {
  const terms = snapshotParkingTerms(
    DEFAULT_CONFIG,
    2,
    true,
    false,
    coins(30),
    "owner.testnet",
  );
  const nextConfig = {
    ...DEFAULT_CONFIG,
    version: 2,
    baseRatePerHour: coins(200),
  };
  const settlement = settleParking(terms, 1_800, "Collect");
  assert.equal(settlement.gross, BigInt(coins(45)));
  assert.equal(settlement.recipientPayout, BigInt(coins(15)));
  assert.equal(settlement.driverPayout, BigInt(coins(30)));
  assert.equal(settleParking(terms, 1_800, "Expire").gross, settlement.gross);
  assert.notEqual(
    settleParking(
      snapshotParkingTerms(
        nextConfig,
        2,
        true,
        false,
        coins(30),
        "owner.testnet",
      ),
      1_800,
      "Collect",
    ).gross,
    settlement.gross,
  );
});

test("ticket split and rounding conserve gross", () => {
  const terms = snapshotParkingTerms(
    DEFAULT_CONFIG,
    1,
    false,
    false,
    coins(0),
    "owner.testnet",
  );
  const settlement = settleParking(terms, 17, "Ticket");
  assert.equal(settlement.driverPayout, 0n);
  assert.equal(
    settlement.recipientPayout + settlement.forfeited,
    settlement.gross,
  );
  assert.throws(() =>
    settleParking(
      snapshotParkingTerms(DEFAULT_CONFIG, 1, true, false, coins(0), null),
      10,
      "Ticket",
    ),
  );
});

test("seed has all player plots and civic capacity without overlap", () => {
  const path = fileURLToPath(
    new URL("../../../contracts/estate/seed.json", import.meta.url),
  );
  const seed = validateCitySeed(JSON.parse(readFileSync(path, "utf8")));
  assert.equal(
    seed.plots.length * 2 +
      seed.npcSites.reduce((sum, site) => sum + site.capacity, 0),
    256,
  );
  const broken = structuredClone(seed);
  broken.streets[0]!.connections[0]!.toAt = 31;
  assert.throws(() => validateCitySeed(broken));
  const misplacedEnd = structuredClone(seed);
  const market = misplacedEnd.streets.find((street) => street.id === "market")!;
  market.connections.find(
    (connection) =>
      connection.kind === "End" && connection.toRoadId === "river",
  )!.at = 7;
  assert.throws(
    () => validateCitySeed(misplacedEnd),
    /end connection must be at a road edge/,
  );
  const duplicateJunction = structuredClone(seed);
  duplicateJunction.streets[0]!.connections[1]!.at =
    duplicateJunction.streets[0]!.connections[0]!.at;
  assert.throws(
    () => validateCitySeed(duplicateJunction),
    /duplicate road junction/,
  );
  const overlapping = structuredClone(seed);
  overlapping.npcSites[1] = {
    ...overlapping.npcSites[1]!,
    roadId: "main",
    side: "North",
    frontageIndex: 8,
  };
  assert.throws(() => validateCitySeed(overlapping));
  const disconnected = structuredClone(seed);
  disconnected.streets.find((street) => street.id === "central")!.connections =
    [];
  for (const street of disconnected.streets)
    street.connections = street.connections.filter(
      (connection) => connection.toRoadId !== "central",
    );
  assert.throws(
    () => validateCitySeed(disconnected),
    /road graph is disconnected/,
  );
});

test("variable city keeps opposite junctions aligned", () => {
  const path = fileURLToPath(
    new URL("../../../contracts/estate/seed-v2.json", import.meta.url),
  );
  const seed = validateCitySeed(JSON.parse(readFileSync(path, "utf8")));
  assert.equal(seed.version, 2);
  const shifted = structuredClone(seed);
  const main = shifted.streets.find((street) => street.id === "main")!;
  const widths = main.frontageUnits!.South;
  [widths[0], widths[4]] = [widths[4]!, widths[0]!];
  for (const index of [0, 4]) {
    const plot = shifted.plots.find(
      (entry) =>
        entry.roadId === "main" &&
        entry.side === "South" &&
        entry.index === index,
    );
    assert(plot);
    plot.frontageUnits = widths[index];
  }
  assert.throws(
    () => validateCitySeed(shifted),
    /intersection sides misaligned/,
  );
});

test("manifest validator enforces level envelopes and stable canonical order", () => {
  const hash = "a".repeat(64);
  const base = {
    schemaVersion: 1,
    renderProfileVersion: 1,
    buildingType: "Cafe",
    level: 1,
    spriteHash: hash,
    thumbnailHash: hash,
    alphaBounds: { x: 10, y: 90, width: 120, height: 70 },
    logoRect: null,
    billboardRect: null,
  };
  assert.ok(validateAssetManifest(base));
  assert.throws(() =>
    validateAssetManifest({
      ...base,
      alphaBounds: { ...base.alphaBounds, y: 89 },
    }),
  );
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

test("appearance approval requires the exact owner, type, level, hash and revision", () => {
  const initial = newPresetAppearance("Cafe", 1, 1, "#78CDB5");
  const pending = proposeAppearance(
    initial,
    1,
    "owner.testnet",
    "a".repeat(64),
  );
  assert.equal(pending.active.kind, "Preset");
  const expected = {
    revision: 2,
    owner: "owner.testnet",
    buildingType: "Cafe" as const,
    level: 1,
    manifestHash: "a".repeat(64),
  };
  assert.throws(() =>
    decideAppearance(
      pending,
      { ...expected, manifestHash: "b".repeat(64) },
      true,
      100,
    ),
  );
  const changed = resetAppearanceToPreset(pending, "Cafe", 2, 1, "#78CDB5");
  assert.throws(() => decideAppearance(changed, expected, true, 100));
  const approved = decideAppearance(pending, expected, true, 100);
  assert.deepEqual(approved.active, {
    kind: "Custom",
    manifestHash: "a".repeat(64),
    approvedAt: 100,
  });
});
