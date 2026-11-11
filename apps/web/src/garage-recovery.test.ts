import assert from "node:assert/strict";
import test from "node:test";
import { ChainAccount, ChainCar, ChainOwnerConfig } from "@estate/shared";
import { garageRecovery } from "./garage-recovery.js";

const config = ChainOwnerConfig.parse({
  version: 2,
  park_durability_cost: 4,
  max_durability: 100,
  repair_cost_per_point: "1000000",
  emergency_repair_cooldown_seconds: 86_400,
  meter_rate_max_per_hour: "30000000",
  rule_delay_seconds: 300,
  change_building_type_cost: "100000000",
  building_upgrade_costs: ["200000000", "600000000", "1500000000"],
});
const account = ChainAccount.parse({
  balance: "0",
  car_ids: [1],
  starter_car_id: 1,
  active_session_id: null,
  last_emergency_repair_at: null,
  burger_decal: false,
  reserved_storage_bytes: 4096,
  used_storage_bytes: 500,
});
const car = ChainCar.parse({
  id: 1,
  owner: "driver.testnet",
  body: "Hatchback",
  color: "Red",
  tier: 1,
  durability: 3,
  parked_session_id: null,
});

test("stranded player can restore the configured parking durability", () => {
  assert.deepEqual(garageRecovery(account, [car], config, 1_000), {
    stranded: true,
    eligible: true,
    availableAt: null,
  });
});

test("recovery is hidden when any car can park or a repair is affordable", () => {
  assert.equal(
    garageRecovery({ ...account, balance: "1000000" }, [car], config, 1_000)
      .stranded,
    false,
  );
  assert.equal(
    garageRecovery(
      { ...account, balance: "1000000" },
      [
        { ...car, durability: 0 },
        { ...car, id: 2, durability: 3 },
      ],
      config,
      1_000,
    ).stranded,
    false,
  );
  assert.equal(
    garageRecovery(
      account,
      [car, { ...car, id: 2, durability: 4 }],
      config,
      1_000,
    ).stranded,
    false,
  );
  assert.equal(
    garageRecovery({ ...account, active_session_id: 4 }, [car], config, 1_000)
      .stranded,
    false,
  );
});

test("recovery shows its exact cooldown deadline", () => {
  const waiting = garageRecovery(
    { ...account, last_emergency_repair_at: 1_000 },
    [car],
    config,
    87_399,
  );
  assert.deepEqual(waiting, {
    stranded: true,
    eligible: false,
    availableAt: 87_400,
  });
  assert.equal(
    garageRecovery(
      { ...account, last_emergency_repair_at: 1_000 },
      [car],
      config,
      87_400,
    ).eligible,
    true,
  );
});
