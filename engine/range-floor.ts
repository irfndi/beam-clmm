// Minimum range floor (Fee-Truth spec): a low-volatility pool must still get
// a wide enough range. The engine reasons in HALF-width (percent away from
// spot on each side), but the guarantee is on FULL width, so the half-width
// is floored at minFullRangePct / 2. Pure and deterministic; malformed
// half-widths fall back to the floor, never NaN.

const DEFAULT_MIN_FULL_RANGE_PCT = 0.2;

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
