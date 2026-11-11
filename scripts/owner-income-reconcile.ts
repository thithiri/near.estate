import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

export type UnsettledCycle = {
  sessionId: number;
  carId: number;
  plotId: string;
  slot: number;
  balanceAtPark?: string;
};

type EventRow = {
  event_name: string;
  receipt_id: string;
  payload_json: string;
};

export function reconcileIndexedOwnerIncome(
  dbPath: string,
  contractId: string,
  ownerId: string,
  cycle: UnsettledCycle,
  balanceAfter: string,
): { receiptId: string; earnedAtomic: string } {
  assert(cycle.balanceAtPark, "Parking balance was not recorded");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const state = db
      .prepare("SELECT contract_id FROM indexer_state WHERE id = 1")
      .get() as { contract_id: string } | undefined;
    assert.equal(state?.contract_id, contractId, "Indexer is for another city");
    const events = db
      .prepare(
        "SELECT event_name, receipt_id, payload_json FROM chain_events WHERE json_extract(payload_json, '$.session_id') = ? ORDER BY block_height",
      )
      .all(cycle.sessionId) as EventRow[];
    const parked = events.filter((event) => event.event_name === "parked");
    const settled = events.filter((event) =>
      ["collected", "expired"].includes(event.event_name),
    );
    assert.equal(parked.length, 1, "Expected one finalized park event");
    assert.equal(settled.length, 1, "Expected one finalized settlement event");
    assert(
      !events.some((event) => event.event_name === "ticketed"),
      "Ticketed session is not owner income",
    );
    const park = JSON.parse(parked[0]!.payload_json) as {
      driver: string;
      car_id: number;
      location_id: string;
      slot: number;
      legal: boolean;
    };
    const settlement = JSON.parse(settled[0]!.payload_json) as {
      location_id: string;
      slot: number;
      gross: string;
      driver_payout: string;
      recipient_payout: string;
      forfeited: string;
    };
    assert.equal(park.driver, ownerId);
    assert.equal(park.car_id, cycle.carId);
    assert.equal(park.location_id, cycle.plotId);
    assert.equal(park.slot, cycle.slot);
    assert.equal(park.legal, true);
    assert.equal(settlement.location_id, cycle.plotId);
    assert.equal(settlement.slot, cycle.slot);
    assert.equal(settlement.gross, settlement.driver_payout);
    assert.equal(settlement.recipient_payout, "0");
    assert.equal(settlement.forfeited, "0");
    const payout = BigInt(settlement.driver_payout);
    assert(payout > 0n, "Parking earned no coins");
    assert.equal(
      BigInt(balanceAfter),
      BigInt(cycle.balanceAtPark) + payout,
      "Owner balance does not match the indexed settlement",
    );
    return {
      receiptId: settled[0]!.receipt_id,
      earnedAtomic: payout.toString(),
    };
  } finally {
    db.close();
  }
}
