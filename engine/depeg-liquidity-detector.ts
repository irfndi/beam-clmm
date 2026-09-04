import type { PoolSnapshot, PoolState } from "./types.js";

export interface DepegLiquidityConfig {
  readonly stablecoinMints?: ReadonlySet<string>;
  readonly depegAbsoluteUsd?: number;
  readonly depegRelativePct?: number;
  readonly liquidityDrainPct?: number;
  readonly liquidityDrainLookbackSnapshots?: number;
}

export interface DepegLiquiditySignals {
  readonly depeg: { readonly tokenMint: string; readonly deviationUsd: number } | null;
  readonly liquidityDrain: { readonly tvlPct: number; readonly volumePct: number } | null;
}

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

function stablecoinMintsForPool(
  pool: PoolState,
  config: DepegLiquidityConfig,
): ReadonlyArray<string> {
  return [pool.tokenX, pool.tokenY].filter((mint) => config.stablecoinMints?.has(mint) === true);
}

function stablecoinPriceFor(pool: PoolState, tokenMint: string): number {
  return tokenMint === pool.tokenX ? pool.currentPrice : 1 / pool.currentPrice;
}

function isDepegSignal(
  deviationUsd: number,
  pool: PoolState,
  depegThreshold: number,
  relativeThreshold: number,
): boolean {
  return (
    finitePositive(pool.currentPrice) &&
    (deviationUsd >= depegThreshold || deviationUsd >= relativeThreshold)
  );
}

function depegForMints(
  pool: PoolState,
  stablecoinMints: ReadonlyArray<string>,
  depegThreshold: number,
  relativeThreshold: number,
): DepegLiquiditySignals["depeg"] {
  // Only stable/stable pairs expose a depeg: pool.currentPrice is the ratio
  // between the two legs, so for a volatile/stable pair (e.g. SOL/USDC) the
  // "stablecoin price" derived from it is the volatile asset's price, which
  // would false-trigger a depeg on every cycle. Skip unless both legs are
  // stablecoins. Liquidity-drain detection below is independent and unaffected.
  if (stablecoinMints.length !== 2) return null;
  for (const tokenMint of stablecoinMints) {
    const deviationUsd = Math.abs(stablecoinPriceFor(pool, tokenMint) - 1);
    if (isDepegSignal(deviationUsd, pool, depegThreshold, relativeThreshold)) {
      return { tokenMint, deviationUsd };
    }
  }
  return null;
}

function liquidityReference(
  history: ReadonlyArray<PoolSnapshot>,
  lookback: number,
): PoolSnapshot | undefined {
  return history.length >= lookback ? history[history.length - lookback] : undefined;
}

function tvlChangePct(pool: PoolState, reference: PoolSnapshot | undefined): number | null {
  if (!reference || !finitePositive(reference.tvlUsd)) return null;
  return (pool.tvlUsd - reference.tvlUsd) / reference.tvlUsd;
}

function volumeChangePct(pool: PoolState, reference: PoolSnapshot | undefined): number | null {
  if (!reference || !finitePositive(reference.volume24hUsd)) return null;
  return (pool.volume24hUsd - reference.volume24hUsd) / reference.volume24hUsd;
}

function drainSignal(
  tvlPct: number | null,
  volumePct: number | null,
  drainThreshold: number,
): DepegLiquiditySignals["liquidityDrain"] {
  if (tvlPct === null || volumePct === null) return null;
  if (tvlPct <= -drainThreshold && volumePct <= -drainThreshold) return { tvlPct, volumePct };
  return null;
}

export function detectDepegAndLiquidityDrain(
  pool: PoolState,
  history: ReadonlyArray<PoolSnapshot>,
  config: DepegLiquidityConfig,
): DepegLiquiditySignals {
  const stablecoinMints = stablecoinMintsForPool(pool, config);
  const depegThreshold = config.depegAbsoluteUsd ?? 0.02;
  const relativeThreshold = config.depegRelativePct ?? 0.02;
  const drainThreshold = config.liquidityDrainPct ?? 0.5;
  const depeg = depegForMints(pool, stablecoinMints, depegThreshold, relativeThreshold);
  const lookback = Math.max(1, Math.floor(config.liquidityDrainLookbackSnapshots ?? 2));
  const reference = liquidityReference(history, lookback);
  const tvlPct = tvlChangePct(pool, reference);
  const volumePct = volumeChangePct(pool, reference);
  const liquidityDrain = drainSignal(tvlPct, volumePct, drainThreshold);
  return { depeg, liquidityDrain };
}
