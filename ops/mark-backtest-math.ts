import { rawRatioToUsd, rawTickToUsd, type VerifiedUsdPair } from "./verified-usd-price.js";

/** USD-valued legs used by the HODL fallback in the mark-to-market models. */
export interface EntryHodlLegsUsd {
  /** The volatile leg's USD value at entry. */
  readonly movingUsd: number;
  /** The numeraire/stable leg's USD value at entry. */
  readonly numeraireUsd: number;
}

/**
 * Derive the actual concentrated-range leg mix at entry.
 *
 * The old replay used 50/50 for every range. That is only true at the
 * geometric midpoint; off-centre entries hold materially different amounts
 * of the moving and numeraire legs, which distorts the HODL comparison.
 */
export function computeEntryHodlLegsUsd(input: {
  readonly depositedUsd: number;
  readonly entryPriceUsd: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly usdPair: VerifiedUsdPair;
}): EntryHodlLegsUsd | null {
  const { depositedUsd, entryPriceUsd, lowerBinId, upperBinId, usdPair } = input;
  if (!(depositedUsd > 0) || !(entryPriceUsd > 0) || !(lowerBinId < upperBinId)) return null;
  const range = usdRangeForEntry(lowerBinId, upperBinId, usdPair);
  if (range === null) return null;
  const { lowerPrice, upperPrice } = range;
  const legs = sqrtLegs(lowerPrice, upperPrice, entryPriceUsd);
  if (legs === null) return null;
  const { sLower, sUpper, sEntry } = legs;
  const valuePerLiquidity = valuePerLiquidityForRange(
    entryPriceUsd,
    lowerPrice,
    upperPrice,
    sLower,
    sUpper,
    sEntry,
  );
  if (valuePerLiquidity === null) return null;
  const liquidity = depositedUsd / valuePerLiquidity;
  const { movingAmount, numeraireAmount } = hodlAmountsForRange(
    entryPriceUsd,
    lowerPrice,
    upperPrice,
    liquidity,
    sLower,
    sUpper,
    sEntry,
  );
  const movingUsd = movingAmount * entryPriceUsd;
  if (
    !Number.isFinite(movingUsd) ||
    !Number.isFinite(numeraireAmount) ||
    movingUsd < 0 ||
    numeraireAmount < 0
  ) {
    return null;
  }
  return { movingUsd, numeraireUsd: numeraireAmount };
}

/** Resolve the USD price band for the entry range (stable-leg verified). */
function usdRangeForEntry(
  lowerBinId: number,
  upperBinId: number,
  usdPair: VerifiedUsdPair,
): { lowerPrice: number; upperPrice: number } | null {
  const lowerRaw = rawTickToUsd(lowerBinId, usdPair);
  const upperRaw = rawTickToUsd(upperBinId, usdPair);
  if (!(lowerRaw !== null && upperRaw !== null)) return null;
  const lowerPrice = Math.min(lowerRaw, upperRaw);
  const upperPrice = Math.max(lowerRaw, upperRaw);
  if (!(lowerPrice > 0 && upperPrice > lowerPrice)) return null;
  return { lowerPrice, upperPrice };
}

/** Square-root legs used by the CLMM value formula. */
function sqrtLegs(
  lowerPrice: number,
  upperPrice: number,
  entryPriceUsd: number,
): { sLower: number; sUpper: number; sEntry: number } | null {
  const sLower = Math.sqrt(lowerPrice);
  const sUpper = Math.sqrt(upperPrice);
  const sEntry = Math.sqrt(entryPriceUsd);
  if (!(sLower > 0 && sUpper > sLower && sEntry > 0)) return null;
  return { sLower, sUpper, sEntry };
}

/** Value per unit of liquidity at entry (same ternary order as pnl.ts). */
function valuePerLiquidityForRange(
  entryPriceUsd: number,
  lowerPrice: number,
  upperPrice: number,
  sLower: number,
  sUpper: number,
  sEntry: number,
): number | null {
  const valuePerLiquidity =
    entryPriceUsd <= lowerPrice
      ? (1 / sLower - 1 / sUpper) * entryPriceUsd
      : entryPriceUsd >= upperPrice
        ? sUpper - sLower
        : (1 / sEntry - 1 / sUpper) * entryPriceUsd + (sEntry - sLower);
  if (!(valuePerLiquidity > 0)) return null;
  return valuePerLiquidity;
}

/** Concentrated-range leg amounts at entry (mirrors computeEntryHodlLegsUsd formulas). */
function hodlAmountsForRange(
  entryPriceUsd: number,
  lowerPrice: number,
  upperPrice: number,
  liquidity: number,
  sLower: number,
  sUpper: number,
  sEntry: number,
): { movingAmount: number; numeraireAmount: number } {
  const movingAmount =
    entryPriceUsd <= lowerPrice
      ? liquidity * (1 / sLower - 1 / sUpper)
      : entryPriceUsd >= upperPrice
        ? 0
        : liquidity * (1 / sEntry - 1 / sUpper);
  const numeraireAmount =
    entryPriceUsd <= lowerPrice
      ? 0
      : entryPriceUsd >= upperPrice
        ? liquidity * (sUpper - sLower)
        : liquidity * (sEntry - sLower);
  return { movingAmount, numeraireAmount };
}

export interface DrawdownSnapshot {
  readonly timestamp: number;
  readonly currentPrice: number;
  readonly usdPair: VerifiedUsdPair | null;
}

/** Price used for drawdown gates; verified USD pairs are always measured in USD. */
export function snapshotPriceUsd(snapshot: DrawdownSnapshot): number | null {
  return snapshot.usdPair === null
    ? snapshot.currentPrice > 0 && Number.isFinite(snapshot.currentPrice)
      ? snapshot.currentPrice
      : null
    : rawRatioToUsd(snapshot.currentPrice, snapshot.usdPair);
}

/** Reconstruct a 24-hour drawdown in the same USD direction as PnL valuation. */
export function reconstructedDrawdown24h(
  snapshots: readonly DrawdownSnapshot[],
  index: number,
  dayMs: number,
): number {
  const current = snapshots[index];
  if (current === undefined) return 0;
  const price = snapshotPriceUsd(current);
  if (!(price !== null && price > 0)) return 0;
  let peak = price;
  for (let i = index; i >= 0; i--) {
    const snapshot = snapshots[i]!;
    if (current.timestamp - snapshot.timestamp > dayMs) break;
    const historicalPrice = snapshotPriceUsd(snapshot);
    if (historicalPrice !== null && historicalPrice > 0) peak = Math.max(peak, historicalPrice);
  }
  return peak > 0 ? (price - peak) / peak : 0;
}

/** Stored values may be percentage points or fractions depending on source. */
export function normalizeStoredDrawdown(stored: number | null): number | null {
  if (stored === null || !Number.isFinite(stored)) return null;
  return Math.abs(stored) > 1 ? stored / 100 : stored;
}
