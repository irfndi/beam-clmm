// Entry gas reserve (Fee-Truth spec, rule 6):
//   Gas Reserve = max(10% allocation, emergency-exit minimum)
// spendable = balance - max(balance * reservePct/100, emergencyExitWei),
// floored at 0 so an entry can never consume the reserve. Pure, bigint
// arithmetic (no float precision loss on wei), deterministic, fail-safe.

export interface GasReserveOptions {
  readonly reservePct?: number;
  readonly emergencyExitWei?: bigint;
}

/**
 * Native-ETH budget available for a single entry.
 *
 *   spendable = balance - max(roundDown(balance * reservePct / 100), emergencyExitWei)
 *
 * Non-positive balances return 0n. `reservePct` is floored to a whole
 * percent (10.9 -> 10); NaN/negative/Infinity falls back to the 10%
 * default. A negative `emergencyExitWei` is clamped to 0n. The result is
 * never negative and never NaN (bigint).
 */
export function entryBudgetWei(nativeBalanceWei: bigint, options: GasReserveOptions = {}): bigint {
  if (nativeBalanceWei <= 0n) return 0n;

  const reservePct = options.reservePct ?? 10;
  const emergencyExitWei = options.emergencyExitWei ?? 0n;
  const pct = Number.isFinite(reservePct) && reservePct >= 0 ? Math.floor(reservePct) : 10;

  const reserveByPct = (nativeBalanceWei * BigInt(pct)) / 100n;
  const emergency = emergencyExitWei < 0n ? 0n : emergencyExitWei;
  const reserve = reserveByPct > emergency ? reserveByPct : emergency;

  const spendable = nativeBalanceWei - reserve;
  return spendable > 0n ? spendable : 0n;
}
