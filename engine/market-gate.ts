/** @file Market-scan gate: turns a raw universe snapshot into a ranked,
 * IL-safe candidate set. Pure and unit-testable — no Effect, no network.
 *
 * The per-pool scan loop remains the source of truth: it re-applies the full
 * safety screening (blacklist / freeze / token-risk overlay), metrics
 * (volume authenticity, fee/IL, bin utilization) and risk gates before any
 * ENTER. This gate only decides WHO gets scanned, ranked by economics with
 * a token-safety pre-filter so risky legs do not burn scan cycles.
 */

import type { DiscoveredPool } from "./services.js";

/** How the composite rank weights TVL.
 *  - `capitalFit` (default): prefer mid/small books where a small wallet
 *    captures a meaningful fee share; penalize mega pools.
 *  - `depth`: legacy — boost deeper TVL (log10) for large-capital LPs. */
export type MarketScanRankMode = "capitalFit" | "depth";

export interface MarketGateConfig {
  readonly minTvlUsd: number;
  /** Hard dust floor — pools below this are always rejected (0/undefined = disabled). */
  readonly absoluteMinTvlUsd?: number;
  /** High-turnover bypass: admit TVL below minTvlUsd when turnover >= this (0/undefined = disabled). */
  readonly highTurnoverBypass?: number;
  /** Soft/hard ceiling — pools above this are rejected (0 = disabled). */
  readonly maxTvlUsd: number;
  /** Peak of the capital-fit size curve (USD TVL). */
  readonly targetTvlUsd: number;
  readonly rankMode: MarketScanRankMode;
  /** Minimum annualized fee/TVL percent: fees24h × 365 / tvl × 100. */
  readonly minFeeApr: number;
  /** Minimum daily volume/TVL ratio (wash-trading and dead-pool guard). */
  readonly minVolumeTurnover: number;
  readonly maxVolumeTurnover: number;
  /** Minimum holders for a non-stable, non-SOL leg (rug/IL pre-filter). */
  readonly minHolders: number;
  readonly minBinStep: number;
  readonly maxBinStep: number;
  readonly stablecoinMints: ReadonlySet<string>;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface MarketPoolRank {
  readonly pool: DiscoveredPool;
  /** Annualized fee/TVL percent (the profit engine of an LP position). */
  readonly feeAprPct: number;
  /** Daily volume/TVL turnover ratio. */
  readonly volumeTurnover: number;
  /** Composite rank. Higher = better. */
  readonly score: number;
  /** Why the pool was admitted (first N flags). */
  readonly notes: ReadonlyArray<string>;
}

export interface MarketGateResult {
  readonly ranked: ReadonlyArray<MarketPoolRank>;
  /** Pools that failed the gate, with the first rejection reason each. */
  readonly rejected: ReadonlyArray<{ readonly address: string; readonly reason: string }>;
}

function isStableOrSol(mint: string, stablecoinMints: ReadonlySet<string>): boolean {
  return mint === SOL_MINT || stablecoinMints.has(mint);
}

/**
 * Token-safety pre-filter for one leg. Mirrors the engine's freeze/verification
 * policy at the DISCOVERY layer (fail-open when metadata is absent — the
 * per-pool screen still gates ENTER):
 * - Stablecoins and SOL: always pass (the stablecoin allowlist exemption).
 * - Verified + freeze-disabled: pass.
 * - Verified but freeze-enabled: pass only when the holder base is real
 *   (freeze authority on a verified token is an operator trust decision).
 * - Unverified: pass only when freeze-disabled AND holders >= minHolders.
 */
export function marketLegPasses(
  leg: {
    readonly isStableOrSol: boolean;
    readonly verified: boolean | undefined;
    readonly freezeDisabled: boolean | undefined;
    readonly holders: number | undefined;
  },
  minHolders: number,
): boolean {
  if (leg.isStableOrSol) return true;
  if (leg.verified === true) {
    // Verified: freeze-disabled always passes. A KNOWN freeze-enabled token
    // still needs a real holder base (operator trust decision); an ABSENT
    // holder count is unknown, not 0 — fail open (the per-pool screen still
    // gates ENTER).
    return leg.freezeDisabled === false
      ? leg.holders === undefined || leg.holders >= minHolders
      : true;
  }
  // Unverified leg: reject only a KNOWN freeze-enabled token; otherwise the
  // holder base must be real. Absent metadata (undefined) is fail-open —
  // `(holders ?? 0)` would fabricate a rejection for legacy metadata-less
  // mappings.
  if (leg.freezeDisabled === false) return false;
  return leg.holders === undefined || leg.holders >= minHolders;
}

interface MarketTvlGate {
  readonly admitted: boolean;
  readonly reason?: string;
}
/** TVL admission: finite, above the dust floor, above the soft floor unless the high-turnover bypass is armed. */
function gateMarketTvl(pool: DiscoveredPool, config: MarketGateConfig): MarketTvlGate {
  if (!Number.isFinite(pool.tvlUsd))
    return { admitted: false, reason: `tvl ${pool.tvlUsd} not finite` };
  if ((config.absoluteMinTvlUsd ?? 0) > 0 && pool.tvlUsd < (config.absoluteMinTvlUsd ?? 0)) {
    return {
      admitted: false,
      reason: `tvl ${pool.tvlUsd} < dust floor ${config.absoluteMinTvlUsd}`,
    };
  }
  // Small-cap high-turnover bypass: a thin book with real flow earns like a
  // big one for a small wallet — admit it despite the soft minTvlUsd floor.
  // Token-risk + ENTER gates still apply; this only affects scan admission.
  const bypassArmed =
    (config.highTurnoverBypass ?? 0) > 0 &&
    pool.volume24hUsd > 0 &&
    pool.volume24hUsd / Math.max(pool.tvlUsd, 1) >= (config.highTurnoverBypass ?? 0);
  if (pool.tvlUsd < config.minTvlUsd && !bypassArmed) {
    return { admitted: false, reason: `tvl ${pool.tvlUsd} < ${config.minTvlUsd}` };
  }
  if (config.maxTvlUsd > 0 && pool.tvlUsd > config.maxTvlUsd) {
    return { admitted: false, reason: `tvl ${pool.tvlUsd} > ${config.maxTvlUsd} (mega book)` };
  }
  return { admitted: true };
}
function gateAndRankMarketGateMetrics(
  pool: DiscoveredPool,
  config: MarketGateConfig,
): { feeAprPct: number; volumeTurnover: number } | { reason: string } {
  const tvl = gateMarketTvl(pool, config);
  if (!tvl.admitted) return { reason: tvl.reason ?? "tvl rejected" };
  if (!Number.isFinite(pool.fees24hUsd) || pool.fees24hUsd <= 0) {
    return { reason: "no 24h fees" };
  }
  const feeAprPct = (pool.fees24hUsd * 365 * 100) / pool.tvlUsd;
  if (feeAprPct < config.minFeeApr)
    return { reason: `fee APR ${feeAprPct.toFixed(1)}% < ${config.minFeeApr}%` };
  if (!Number.isFinite(pool.volume24hUsd) || pool.volume24hUsd <= 0)
    return { reason: "no 24h volume" };
  const volumeTurnover = pool.volume24hUsd / pool.tvlUsd;
  if (volumeTurnover < config.minVolumeTurnover) {
    return { reason: `volume turnover ${volumeTurnover.toFixed(2)} < ${config.minVolumeTurnover}` };
  }
  if (volumeTurnover > config.maxVolumeTurnover) {
    return {
      reason: `volume turnover ${volumeTurnover.toFixed(1)} > ${config.maxVolumeTurnover} (wash)`,
    };
  }
  if (!Number.isInteger(pool.binStep) || pool.binStep < config.minBinStep) {
    return { reason: `binStep ${pool.binStep} < ${config.minBinStep} (ultra-fine churn)` };
  }
  if (pool.binStep > config.maxBinStep)
    return { reason: `binStep ${pool.binStep} > ${config.maxBinStep}` };
  return { feeAprPct, volumeTurnover };
}

function gateAndRankMarketTokenSafety(
  pool: DiscoveredPool,
  config: MarketGateConfig,
): string | null {
  const xPasses = marketLegPasses(
    {
      isStableOrSol: isStableOrSol(pool.tokenX, config.stablecoinMints),
      verified: pool.tokenXVerified,
      freezeDisabled: pool.tokenXFreezeDisabled,
      holders: pool.tokenXHolders,
    },
    config.minHolders,
  );
  if (!xPasses) {
    return `leg ${pool.tokenXSymbol ?? pool.tokenX} fails token safety (verified=${pool.tokenXVerified}, freezeDisabled=${pool.tokenXFreezeDisabled}, holders=${pool.tokenXHolders})`;
  }
  const yPasses = marketLegPasses(
    {
      isStableOrSol: isStableOrSol(pool.tokenY, config.stablecoinMints),
      verified: pool.tokenYVerified,
      freezeDisabled: pool.tokenYFreezeDisabled,
      holders: pool.tokenYHolders,
    },
    config.minHolders,
  );
  if (!yPasses) {
    return `leg ${pool.tokenYSymbol ?? pool.tokenY} fails token safety (verified=${pool.tokenYVerified}, freezeDisabled=${pool.tokenYFreezeDisabled}, holders=${pool.tokenYHolders})`;
  }
  return null;
}

/** Depth mode: deeper books score slightly higher (legacy large-LP bias). */
export function depthLiquidityFactor(tvlUsd: number): number {
  return Math.min(Math.max(Math.log10(Math.max(tvlUsd, 1)) / 6, 0.6), 1.4);
}

/**
 * Capital-fit size curve: peaks near `targetTvlUsd`, decays for mega and
 * dust books. A $20 wallet on an $8M book earns dust; on a $100k book the
 * same APR yields visible fees.
 */
export function capitalFitSizeFactor(tvlUsd: number, targetTvlUsd: number): number {
  const target = Math.max(targetTvlUsd, 1);
  const tvl = Math.max(tvlUsd, 1);
  const logDist = Math.abs(Math.log10(tvl / target));
  return Math.min(Math.max(1.25 - 0.5 * logDist, 0.2), 1.35);
}

/**
 * Prefer higher LP fee tiers (more $/volume for the same turnover). Uses the
 * implied fee rate fees24h/volume24h when volume > 0.
 */
interface FeeTierScoreFactor {
  readonly factor: number;
  readonly note: string;
}

interface StableLegScoreFactor {
  readonly factor: number;
  readonly note: string | null;
}

interface MarketPoolScore {
  readonly score: number;
  readonly notes: string[];
}

export function feeTierScoreFactor(pool: DiscoveredPool): FeeTierScoreFactor {
  const implied = pool.volume24hUsd > 0 ? pool.fees24hUsd / pool.volume24hUsd : 0;
  if (implied >= 0.009) return { factor: 1.25, note: "fee-tier~1%" };
  if (implied >= 0.0025) return { factor: 1.1, note: "fee-tier~0.3%" };
  if (implied >= 0.0004) return { factor: 0.85, note: "fee-tier~0.05%" };
  return { factor: 0.55, note: "fee-tier~0.01%" };
}

const STABLE_SYMBOLS = new Set(["USDC", "USDBC", "USDT", "DAI", "USD+", "USDG", "PYUSD"]);

/** Mild boost for stable-leg books — more likely to pass token-risk + swap. */
export function stableLegScoreFactor(pool: DiscoveredPool): StableLegScoreFactor {
  const x = (pool.tokenXSymbol ?? "").toUpperCase();
  const y = (pool.tokenYSymbol ?? "").toUpperCase();
  if (STABLE_SYMBOLS.has(x) || STABLE_SYMBOLS.has(y)) {
    return { factor: 1.15, note: "stable-leg" };
  }
  return { factor: 1, note: null };
}

interface TurnoverScoreFactor {
  readonly factor: number;
  readonly note: string;
}
/**
 * Capital-efficiency boost: high volume/TVL turnover means the book pays its
 * LPs often — a small wallet rotating into high-turnover pools captures more
 * fees per dollar than sitting in a deep low-turnover book at the same APR.
 * Bounded 1.0–1.5; wash-level turnover is rejected upstream, not here.
 */
export function turnoverScoreFactor(volumeTurnover: number): TurnoverScoreFactor {
  if (volumeTurnover >= 8) return { factor: 1.5, note: "turnover×1.50" };
  if (volumeTurnover >= 4) return { factor: 1.35, note: "turnover×1.35" };
  if (volumeTurnover >= 2) return { factor: 1.2, note: "turnover×1.20" };
  if (volumeTurnover >= 0.5) return { factor: 1.1, note: "turnover×1.10" };
  return { factor: 1, note: "turnover×1.00" };
}
export function marketPoolScore(
  pool: DiscoveredPool,
  feeAprPct: number,
  volumeTurnover: number,
  config: Pick<MarketGateConfig, "rankMode" | "targetTvlUsd">,
): MarketPoolScore {
  const sizeFactor =
    config.rankMode === "depth"
      ? depthLiquidityFactor(pool.tvlUsd)
      : capitalFitSizeFactor(pool.tvlUsd, config.targetTvlUsd);
  const fee = feeTierScoreFactor(pool);
  const stable = stableLegScoreFactor(pool);
  const turnover = turnoverScoreFactor(volumeTurnover);
  const score = feeAprPct * sizeFactor * fee.factor * stable.factor * turnover.factor;
  const notes = [
    `fee APR ${feeAprPct.toFixed(1)}%`,
    config.rankMode === "depth"
      ? `depth×${sizeFactor.toFixed(2)}`
      : `capitalFit×${sizeFactor.toFixed(2)}`,
    fee.note,
    turnover.note,
  ];
  if (stable.note) notes.push(stable.note);
  return { score, notes };
}

/** Gates and ranks one universe snapshot. Pure; callers feed it the adapter's
 *  `discoverPoolsTopPages` output (or a Krystal-mapped universe). */
export function gateAndRankMarketPools(
  pools: ReadonlyArray<DiscoveredPool>,
  config: MarketGateConfig,
): MarketGateResult {
  const ranked: MarketPoolRank[] = [];
  const rejected: Array<{ readonly address: string; readonly reason: string }> = [];

  for (const pool of pools) {
    const reject = (reason: string): void => {
      rejected.push({ address: pool.address, reason });
    };
    const gate = gateAndRankMarketGateMetrics(pool, config);
    if ("reason" in gate) {
      reject(gate.reason);
      continue;
    }
    const tokenSafetyReason = gateAndRankMarketTokenSafety(pool, config);
    if (tokenSafetyReason) {
      reject(tokenSafetyReason);
      continue;
    }
    const { feeAprPct, volumeTurnover } = gate;
    const { score, notes: scoreNotes } = marketPoolScore(pool, feeAprPct, volumeTurnover, config);
    const notes = [
      scoreNotes[0] ?? `fee APR ${feeAprPct.toFixed(1)}%`,
      `turnover ${volumeTurnover.toFixed(2)}`,
      ...scoreNotes.slice(1),
    ];
    ranked.push({ pool, feeAprPct, volumeTurnover, score, notes });
  }

  ranked.sort((a, b) => b.score - a.score);
  return { ranked, rejected };
}
