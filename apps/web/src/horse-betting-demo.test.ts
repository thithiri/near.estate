import assert from "node:assert/strict";
import test from "node:test";
import { HORSES } from "./horse-race.js";
import { HorseBettingDemo } from "./horse-betting-demo.js";

const COIN = 1_000_000n;

test("demo winning and losing bets conserve player, escrow and house coins", () => {
  for (const winnerBet of [true, false]) {
    const book = new HorseBettingDemo();
    const before = book.playerBalance + book.houseBalance + book.escrow;
    book.place(0, winnerBet ? 0 : 1, 5, 1);
    assert.equal(book.escrow, 5n * COIN);
    const result = book.settle(0);
    assert.equal(result.won, winnerBet);
    assert.equal(result.returned, winnerBet ? 19n * COIN : 0n);
    assert.equal(book.playerBalance + book.houseBalance + book.escrow, before);
    assert.equal(book.lockedHouseProfit, 0n);
    assert.throws(() => book.settle(0), /No demo bet/);
  }
});

test("demo rejects invalid stakes, duplicate bets and daily overspend", () => {
  const book = new HorseBettingDemo();
  assert.throws(() => book.place(0, HORSES.length, 1, 1), /Choose one horse/);
  book.place(0, 0, 5, 1);
  assert.throws(() => book.place(0, 0, 5, 1), /already open/);
  book.refund();
  assert.equal(book.escrow, 0n);
  for (let race = 1; race < 4; race++) {
    book.place(race, 0, 5, 1);
    book.settle(race);
  }
  assert.throws(() => book.place(4, 0, 1, 1), /daily stake limit/);
});
