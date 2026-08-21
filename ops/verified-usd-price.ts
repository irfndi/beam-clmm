/**
 * Convert the raw token1/token0 tick ratio stored by the EVM adapter into a
 * USD price only when one leg is an explicitly recognized stablecoin.
 *
 * A raw Uniswap ratio is not a USD price: it is expressed in atomic units and
 * has no absolute numeraire for TOKEN/TOKEN or ETH/TOKEN pools.  Backtests use
 * this module as a fail-closed boundary before applying USD PnL math.
 */

const STABLE_SYMBOLS = new Set(["DAI", "USDC", "USDBC", "USDT", "USDG", "USDE"]);

export interface VerifiedUsdPair {
  readonly scale: number;
  /** True when token0 is the stable leg and the raw ratio must be inverted. */
  readonly invert: boolean;
  readonly stablePriceUsd: number;
}

const STABLE_ADDRESSES = new Set([
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // Robinhood USDG
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base USDC
]);

function decimalsForSymbol(symbol: string): number | null {
  const normalized = symbol.trim().toUpperCase();
  if (STABLE_SYMBOLS.has(normalized)) return 6;
  if (normalized === "ETH" || normalized === "WETH") return 18;
  return null;
}

/** Return a USD conversion only for a pair with exactly one stable leg. */
export function verifiedUsdPair(
  tokenXSymbol: string,
  tokenYSymbol: string,
): VerifiedUsdPair | null {
  const x = tokenXSymbol.trim().toUpperCase();
  const y = tokenYSymbol.trim().toUpperCase();
  const xStable = STABLE_SYMBOLS.has(x);
  const yStable = STABLE_SYMBOLS.has(y);
  if (xStable === yStable) return null;
  const xDecimals = decimalsForSymbol(x);
  const yDecimals = decimalsForSymbol(y);
  if (xDecimals === null || yDecimals === null) return null;
  return {
    scale: 10 ** (xDecimals - yDecimals),
    invert: xStable,
    stablePriceUsd: 1,
  };
}

export interface PersistedPriceMetadata {
  readonly tokenXAddress?: string | null;
  readonly tokenYAddress?: string | null;
  readonly tokenXSymbol?: string | null;
  readonly tokenYSymbol?: string | null;
  readonly tokenXDecimals?: number | null;
  readonly tokenYDecimals?: number | null;
  readonly tokenXPriceUsd?: number | null;
  readonly tokenYPriceUsd?: number | null;
}

/** Build a verified conversion from persisted leg metadata, with symbols as a legacy fallback. */
export function verifiedUsdPairFromMetadata(
  metadata: PersistedPriceMetadata,
): VerifiedUsdPair | null {
  const xAddress = metadata.tokenXAddress?.toLowerCase() ?? "";
  const yAddress = metadata.tokenYAddress?.toLowerCase() ?? "";
  const xStable = STABLE_ADDRESSES.has(xAddress);
  const yStable = STABLE_ADDRESSES.has(yAddress);
  const symbolPair = verifiedUsdPair(metadata.tokenXSymbol ?? "", metadata.tokenYSymbol ?? "");
  if (!xStable && !yStable) return symbolPair;
  if (xStable === yStable) return null;
  const xDecimals = metadata.tokenXDecimals;
  const yDecimals = metadata.tokenYDecimals;
  const stablePriceUsd = xStable ? metadata.tokenXPriceUsd : metadata.tokenYPriceUsd;
  if (
    !Number.isInteger(xDecimals) ||
    xDecimals! < 0 ||
    !Number.isInteger(yDecimals) ||
    yDecimals! < 0 ||
    !Number.isFinite(stablePriceUsd) ||
    !(stablePriceUsd! > 0)
  ) {
    return null;
  }
  return {
    scale: 10 ** (xDecimals! - yDecimals!),
    invert: xStable,
    stablePriceUsd: stablePriceUsd!,
  };
}

export function rawRatioToUsd(rawRatio: number, pair: VerifiedUsdPair): number | null {
  if (!Number.isFinite(rawRatio) || rawRatio <= 0) return null;
  const scaled = rawRatio * pair.scale;
  if (!Number.isFinite(scaled) || scaled <= 0) return null;
  const usd = pair.invert ? pair.stablePriceUsd / scaled : scaled * pair.stablePriceUsd;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

export function rawTickToUsd(tick: number, pair: VerifiedUsdPair): number | null {
  if (!Number.isFinite(tick)) return null;
  return rawRatioToUsd(Math.pow(1.0001, tick), pair);
}
