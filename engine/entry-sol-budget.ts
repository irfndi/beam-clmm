// Native-ETH entry budget (EVM port of the Solana-era SOL budget module).
// The live-tx layer is not implemented yet; the budget is conservative:
// worst case = the whole ENTER size funded by native ETH (gas + swap
// deficits), free budget = the full native balance (EVM has no rent / ATA
// reserves, so no reserve subtraction).

import { NATIVE_MINT } from "./constants.js";

// Slippage/fee buffer applied to the ETH-funded portion of an entry estimate.
const ENTRY_BUFFER_PCT = 1.01;

/** True when one of the pool's legs is native ETH (entries spend ETH on that leg). */
export function hasNativeSolLeg(pool: {
  readonly tokenX?: string | null;
  readonly tokenY?: string | null;
}): boolean {
  return pool.tokenX === NATIVE_MINT || pool.tokenY === NATIVE_MINT;
}

/** Converts a USD amount to wei at the given ETH price, rounding up. */
export function usdToLamports(usd: number, nativePriceUsd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  if (!Number.isFinite(nativePriceUsd) || nativePriceUsd <= 0) return 0n;
  return BigInt(Math.ceil((usd / nativePriceUsd) * 1e18));
}

/**
 * Conservative estimate of the native ETH a single live ENTER can consume.
 * Over-estimating is safe: the gate only skips (never fails) an entry, and
 * the pool re-qualifies next cycle.
 */
export function estimateEntrySolLamports(input: {
  readonly positionSizeUsd: number;
  readonly nativePriceUsd: number;
  readonly poolHasSolLeg: boolean;
  /** Autonomous canary/live mode: non-ETH legs are bought with ETH swaps. */
  readonly solFunded: boolean;
}): bigint {
  const legFraction = input.solFunded ? 1 : input.poolHasSolLeg ? 0.5 : 0;
  return usdToLamports(
    input.positionSizeUsd * legFraction * ENTRY_BUFFER_PCT,
    input.nativePriceUsd,
  );
}

/**
 * Free native ETH available for entries: the full balance (no gas reserve —
 * viem gas is paid from the same balance and the ENTER gate enforces
 * MIN_NATIVE_FOR_ENTRY_WEI separately).
 */
export function freeEntrySolLamports(nativeWei: bigint): bigint {
  return nativeWei;
}
