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
  const lowerRaw = rawTickToUsd(lowerBinId, usdPair);
  const upperRaw = rawTickToUsd(upperBinId, usdPair);
  if (!(lowerRaw !== null && upperRaw !== null)) return null;
  const lowerPrice = Math.min(lowerRaw, upperRaw);
  const upperPrice = Math.max(lowerRaw, upperRaw);
  if (!(lowerPrice > 0 && upperPrice > lowerPrice)) return null;

  const sLower = Math.sqrt(lowerPrice);
  const sUpper = Math.sqrt(upperPrice);
  const sEntry = Math.sqrt(entryPriceUsd);
  if (!(sLower > 0 && sUpper > sLower && sEntry > 0)) return null;

  const valuePerLiquidity =
    entryPriceUsd <= lowerPrice
      ? (1 / sLower - 1 / sUpper) * entryPriceUsd
      : entryPriceUsd >= upperPrice
        ? sUpper - sLower
        : (1 / sEntry - 1 / sUpper) * entryPriceUsd + (sEntry - sLower);
  if (!(valuePerLiquidity > 0)) return null;

  const liquidity = depositedUsd / valuePerLiquidity;
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
