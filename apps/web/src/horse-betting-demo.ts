import { HORSES, horseRaceOrder } from "./horse-race.js";

const COIN = 1_000_000n;
export const DEMO_ODDS_BPS = 38_000n;
export const DEMO_MAX_DAILY_STAKE = 20n * COIN;

type Bet = { race: number; horse: number; stake: bigint; profit: bigint };

/** Browser-only demonstration ledger. It never reads or writes game balances. */
export class HorseBettingDemo {
  playerBalance = 100n * COIN;
  houseBalance = 1_000n * COIN;
  escrow = 0n;
  lockedHouseProfit = 0n;
  spentToday = 0n;
  private day = -1;
  private bet: Bet | null = null;

  get pendingBet(): Bet | null {
    return this.bet;
  }

  place(race: number, horse: number, stakeCoins: number, day: number): Bet {
    if (
      !Number.isSafeInteger(race) ||
      race < 0 ||
      !Number.isInteger(horse) ||
      horse < 0 ||
      horse >= HORSES.length ||
      !Number.isInteger(stakeCoins) ||
      stakeCoins < 1 ||
      stakeCoins > 5 ||
      !Number.isSafeInteger(day) ||
      day < 0
    )
      throw new Error("Choose one horse and a stake of 1–5 demo coins");
    if (this.bet) throw new Error("A demo bet is already open");
    if (day !== this.day) {
      this.day = day;
      this.spentToday = 0n;
    }
    const stake = BigInt(stakeCoins) * COIN;
    if (this.spentToday + stake > DEMO_MAX_DAILY_STAKE)
      throw new Error("Demo daily stake limit reached");
    if (this.playerBalance < stake) throw new Error("Not enough demo coins");
    const profit = (stake * (DEMO_ODDS_BPS - 10_000n)) / 10_000n;
    if (this.houseBalance - this.lockedHouseProfit < profit)
      throw new Error("House reserve is too low");
    this.playerBalance -= stake;
    this.escrow += stake;
    this.lockedHouseProfit += profit;
    this.spentToday += stake;
    this.bet = { race, horse, stake, profit };
    return this.bet;
  }

  settle(race: number): { won: boolean; returned: bigint } {
    const bet = this.bet;
    if (!bet || bet.race !== race) throw new Error("No demo bet for this race");
    const won = horseRaceOrder(race)[0] === bet.horse;
    this.escrow -= bet.stake;
    this.lockedHouseProfit -= bet.profit;
    const returned = won ? bet.stake + bet.profit : 0n;
    if (won) {
      this.playerBalance += returned;
      this.houseBalance -= bet.profit;
    } else this.houseBalance += bet.stake;
    this.bet = null;
    return { won, returned };
  }

  refund(): void {
    const bet = this.bet;
    if (!bet) return;
    this.playerBalance += bet.stake;
    this.escrow -= bet.stake;
    this.lockedHouseProfit -= bet.profit;
    this.bet = null;
  }
}
