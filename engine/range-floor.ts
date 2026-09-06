// Minimum range floor (Fee-Truth spec): a low-volatility pool must still get
// a wide enough range. The engine reasons in HALF-width (percent away from
// spot on each side), but the guarantee is on FULL width, so the half-width
// is floored at minFullRangePct / 2. Pure and deterministic; malformed
// half-widths fall back to the floor, never NaN.

const DEFAULT_MIN_FULL_RANGE_PCT = 0.2;

/** Uniswap v3 usable-tick domain (matches @uniswap/v3-sdk TickMath). */
const UNISWAP_MIN_TICK = -887272;
const UNISWAP_MAX_TICK = 887272;

/**
 * Floor a half-width so that the full range (2 * halfWidth) is at least
 * `minFullRangePct`:
 *
 *   result = max(halfWidthPct, minFullRangePct / 2)
 *
 * A non-finite or negative `halfWidthPct` returns the floor itself.
 * A malformed (NaN/negative) `minFullRangePct` falls back to 0.20; an
 * explicit `0` disables the floor (pass-through), which is a deliberate
 * caller choice, not an error.
 */
export function applyMinRangePct(
  halfWidthPct: number,
  minFullRangePct = DEFAULT_MIN_FULL_RANGE_PCT,
): number {
  const minHalfWidthPct =
    (Number.isFinite(minFullRangePct) && minFullRangePct >= 0
      ? minFullRangePct
      : DEFAULT_MIN_FULL_RANGE_PCT) / 2;

  if (!Number.isFinite(halfWidthPct) || halfWidthPct < 0) {
    return minHalfWidthPct;
  }
  return Math.max(halfWidthPct, minHalfWidthPct);
}

export interface FlooredTickRange {
  readonly lowerBinId: number;
  readonly upperBinId: number;
}

/**
 * Fee-Truth range floor: widen a (lower, upper) tick range so the FULL price
 * range is at least `minFullRangePct` around `activeBinId`, unless the range
 * is already wider. The floor is expressed in price-pct and converted to
 * binStep-aligned ticks (rounded UP so the guarantee is never undershot).
 *
 * Bounds MUST land on usable ticks (`tick % tickSpacing === 0`). The Uniswap
 * Position ctor rejects unaligned `tickLower` with `Invariant failed:
 * TICK_LOWER` — subtracting `halfTicks` from a mid-spacing active tick
 * (e.g. -198093) previously minted unaligned bounds.
 */
export function floorRangeToMinPct(
  activeBinId: number,
  binStep: number,
  lowerBinId: number,
  upperBinId: number,
  minFullRangePct: number,
): FlooredTickRange {
  if (!Number.isFinite(activeBinId) || !Number.isFinite(binStep) || binStep <= 0) {
    return { lowerBinId, upperBinId };
  }
  const align = (t: number): number => Math.round(t / binStep) * binStep;
  const halfWidthPct = 1.0001 ** (((upperBinId - lowerBinId) / 2) * binStep) - 1;
  const flooredHalfWidthPct = applyMinRangePct(halfWidthPct, minFullRangePct);
  if (flooredHalfWidthPct <= halfWidthPct) {
    // Pass-through still re-aligns: callers may hand in a raw recommendation
    // that drifted off spacing after an earlier transform.
    let lower = align(lowerBinId);
    let upper = align(upperBinId);
    if (upper <= lower) upper = Math.min(UNISWAP_MAX_TICK, lower + binStep);
    return {
      lowerBinId: Math.max(UNISWAP_MIN_TICK, lower),
      upperBinId: Math.min(UNISWAP_MAX_TICK, upper),
    };
  }
  const halfTicks =
    Math.ceil(Math.log1p(flooredHalfWidthPct) / Math.log(1.0001) / binStep) * binStep;
  // Floor lower / ceil upper around the active tick so the full width never
  // undershoots the pct floor after spacing snap (active tick is rarely on
  // a usable boundary).
  let lower = Math.max(UNISWAP_MIN_TICK, Math.floor((activeBinId - halfTicks) / binStep) * binStep);
  let upper = Math.min(UNISWAP_MAX_TICK, Math.ceil((activeBinId + halfTicks) / binStep) * binStep);
  if (upper <= lower) {
    lower = Math.max(UNISWAP_MIN_TICK, align(activeBinId) - binStep);
    upper = Math.min(UNISWAP_MAX_TICK, lower + binStep);
  }
  return { lowerBinId: lower, upperBinId: upper };
}
