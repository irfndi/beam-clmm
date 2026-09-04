import type { PoolState } from "./types.js";

/**
 * Challenge-mode strategy (the $10 → $1M compounding playbook, per
 * docs/COMPOUNDING_CHALLENGE.md §8): rank pools by MEASURED fee yield vs
 * drawdown risk, gate rotation on drawdown/yield-decay, and size ranges from
 * Krystal's priceVolatility. All functions are pure — the wiring lives in
 * program.ts (evaluatePool) and consumes the Krystal-enriched PoolState
 * (statsSource "krystal" carries drawdown24h + priceVolatility).
 */

/** Stable legs: ~0-IL harvest sleeves (w_stable multiplier). */
const STABLE_SYMBOLS = new Set(["USDG", "USDC", "USDT", "DAI"]);

export interface ChallengePoolScore {
  readonly score: number;
  readonly tier: "S" | "A" | "B" | "none";
  readonly reasons: ReadonlyArray<string>;
  readonly yieldPerDayPct: number;
  readonly drawdown24h: number;
}

/**
 * score = yield24h% × (1 + dd24h/100)² × w_tier × w_stable × w_age
 * (drawdown penalty squared when dd < 0 — a high-drawdown meme at the same
 * yield must rank BELOW a zero-IL anchor, not tie or beat it).
 * yield24h = stat24h.feeUsd/tvlUsd (measured, from Krystal enrichment).
 * Entry filters (hard): tvl ≥ $1k, dd > −5%, age ≥ 6h, fee tier ≥ 0.05%.
 * Tiers: S = stable-pair score ≥ 15; A = score ≥ 10; B = score 4–10.
 */
function challengeTvlGate(pool: PoolState): ChallengePoolScore | null {
  if (pool.tvlUsd < 1_000) {
    return {
      score: 0,
      tier: "none",
      reasons: ["tvl<$1k"],
      yieldPerDayPct: 0,
      drawdown24h: pool.drawdown24h ?? 0,
    };
  }
  return null;
}

function challengeYieldGate(pool: PoolState, yieldPct: number): ChallengePoolScore | null {
  if (yieldPct <= 0) {
    return {
      score: 0,
      tier: "none",
      reasons: ["no measured fees"],
      yieldPerDayPct: 0,
      drawdown24h: pool.drawdown24h ?? 0,
    };
  }
  return null;
}

function challengeDrawdownGate(yieldPct: number, dd: number): ChallengePoolScore | null {
  if (dd < -5) {
    return {
      score: 0,
      tier: "none",
      reasons: [`dd ${dd.toFixed(1)}% < -5%`],
      yieldPerDayPct: yieldPct,
      drawdown24h: dd,
    };
  }
  return null;
}

function challengeBaseScore(yieldPct: number, dd: number): number {
  // Squared penalty below zero drawdown: dd=-4% → ×0.96² ≈ ×0.92 (vs ×0.96
  // before — high-yield memes used to outrank zero-IL anchors on the weak
  // linear penalty). dd ≥ 0 keeps the legacy (1 + dd/100) uplift.
  const ddFactor = 1 + dd / 100;
  if (dd < 0) return yieldPct * ddFactor * ddFactor;
  return yieldPct * ddFactor;
}

function challengeStableLegInfo(pool: PoolState): {
  hasStableLeg: boolean;
  factor: number;
  reason: string | null;
} {
  const xSymbol = pool.tokenXSymbol?.toUpperCase() ?? "";
  const ySymbol = pool.tokenYSymbol?.toUpperCase() ?? "";
  const hasStableLeg = STABLE_SYMBOLS.has(xSymbol) || STABLE_SYMBOLS.has(ySymbol);
  if (hasStableLeg) return { hasStableLeg: true, factor: 1.15, reason: "stable-leg" };
  return { hasStableLeg: false, factor: 1, reason: null };
}

function challengeFeeTierInfo(pool: PoolState): { factor: number; reason: string } {
  // Fee tier weight: high-fee pools dominate yield; sub-0.05% are churn races.
  // The adapter stores tickSpacing in binStep; map v3/v4 fee tiers from
  // fees24hUsd/volume24hUsd as a sanity check, else assume mid-tier.
  const impliedFeeRate = pool.volume24hUsd > 0 ? pool.fees24hUsd / pool.volume24hUsd : 0;
  if (impliedFeeRate >= 0.003) return { factor: 1.0, reason: "fee-tier>=0.3%" };
  if (impliedFeeRate >= 0.0005) return { factor: 0.85, reason: "fee-tier mid" };
  return { factor: 0.5, reason: "fee-tier low" };
}

function challengeTierFor(score: number, hasStableLeg: boolean): ChallengePoolScore["tier"] {
  // S requires BOTH high score AND a stable pair (the ~0-IL anchor sleeve);
  // high-yield memes land in A.
  if (score >= 15 && hasStableLeg) return "S";
  if (score >= 10) return "A";
  if (score >= 4) return "B";
  return "none";
}

export function challengePoolScore(pool: PoolState): ChallengePoolScore {
  const tvlGate = challengeTvlGate(pool);
  if (tvlGate) return tvlGate;
  const yieldPct = pool.tvlUsd > 0 ? (pool.fees24hUsd / pool.tvlUsd) * 100 : 0;
  const yieldGate = challengeYieldGate(pool, yieldPct);
  if (yieldGate) return yieldGate;
  const dd = pool.drawdown24h ?? 0;
  const ddGate = challengeDrawdownGate(yieldPct, dd);
  if (ddGate) return ddGate;
  const reasons: string[] = [];
  let score = challengeBaseScore(yieldPct, dd);
  const stable = challengeStableLegInfo(pool);
  if (stable.hasStableLeg) {
    score *= stable.factor;
    if (stable.reason) reasons.push(stable.reason);
  }
  const fee = challengeFeeTierInfo(pool);
  score *= fee.factor;
  reasons.push(fee.reason);
  const tier = challengeTierFor(score, stable.hasStableLeg);
  if (tier === "none") reasons.push(`score ${score.toFixed(1)} < 4`);
  return { score, tier, reasons, yieldPerDayPct: yieldPct, drawdown24h: dd };
}

/**
 * Volatility-sized range from Krystal priceVolatility (daily σ in %).
 * halfWidth ticks = ln(1 + k·σ) / ln(1.0001), clamped to sane bounds
 * (never tighter than a few ticks — churn risk — nor wider than the
 * spacing-aligned ceiling). k default 1.5 (≈87% in-range over a day).
 */
export function challengeRangeFromVolatility(
  activeTick: number,
  tickSpacing: number,
  priceVolatilityPct: number,
  k = 1.5,
): ChallengeRange {
  const sigma = Math.max(0, priceVolatilityPct) / 100;
  const priceRange = Math.log(1 + k * sigma) / Math.log(1.0001);
  const half = Math.max(2, Math.round(priceRange));
  // Align to spacing so ticks land on usable boundaries, then clamp to the
  // SDK's usable tick domain — a pool trading near MIN/MAX_TICK (extreme
  // price) otherwise yields a range that fails the Position ctor's
  // TICK_LOWER/TICK_UPPER invariant (live failure: every ENTER on the
  // harvest book reverted with 'Invariant failed: TICK_LOWER').
  const MIN_TICK = -887272;
  const MAX_TICK = 887272;
  const align = (t: number): number => {
    const snapped = Math.round(t / tickSpacing) * tickSpacing;
    return snapped === 0 ? 0 : snapped;
  };
  const lower = Math.max(MIN_TICK, align(activeTick - half));
  let upper = Math.min(MAX_TICK, align(activeTick + half));
  if (upper <= lower) {
    // Volatility width smaller than one spacing collapses to a single
    // aligned tick — enforce the minimum usable range.
    upper = Math.min(MAX_TICK, lower + tickSpacing);
  }
  return { lowerBinId: lower, upperBinId: upper, halfWidth: half };
}

export type ChallengeRotationAction = "hold" | "exit";

/** Yield-decay rotation exit: exit when current yield < this fraction of the
 *  trailing average (the looser of the two decay tiers). Shared by the exit
 *  signal and the entry-gate hysteresis so the two can never drift apart. */
export const YIELD_DECAY_EXIT_FRACTION = 0.7;
/** Yield-collapse rotation exit: the tighter tier (volume rotated away). */
export const YIELD_COLLAPSE_EXIT_FRACTION = 0.5;

/** Computed tick range for a challenge-mode position sized from volatility. */
interface ChallengeRange {
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly halfWidth: number;
}

/** Rotation decision: gate action plus the reason shown to the operator. */
interface ChallengeRotationDecision {
  readonly action: ChallengeRotationAction;
  readonly reason: string;
}

/**
 * Rotation signal: drawdown gating (the dominant risk term) + yield decay.
 * - drawdown24h < -exitPct → exit (capital protection; the old 'halve'
 *   de-risk tier folded into exit — program.ts maps both to EXIT, a
 *   range-tighten does not de-risk dollars)
 * - measured yield < 50% of the pool's trailing average → exit (volume
 *   rotated away); < 70% → exit (decay exit, same action).
 * avgYieldPerDayPct: rolling 7d mean from the engine's pool_snapshots
 * (fees24hUsd/tvlUsd), passed by the caller; null → yield-decay skipped.
 */
export function challengeRotationSignal(
  pool: PoolState,
  avgYieldPerDayPct: number | null,
  exitPct = 5,
): ChallengeRotationDecision {
  const dd = pool.drawdown24h ?? 0;
  if (dd < -exitPct) return { action: "exit", reason: `drawdown ${dd.toFixed(1)}% < -${exitPct}%` };
  if (avgYieldPerDayPct !== null && avgYieldPerDayPct > 0) {
    const tvl = pool.tvlUsd;
    const yieldPct = tvl > 0 ? (pool.fees24hUsd / tvl) * 100 : 0;
    if (yieldPct < avgYieldPerDayPct * YIELD_COLLAPSE_EXIT_FRACTION) {
      return {
        action: "exit",
        reason: `yield ${yieldPct.toFixed(2)}%/d < 50% of ${avgYieldPerDayPct.toFixed(2)}%/d avg`,
      };
    }
    if (yieldPct < avgYieldPerDayPct * YIELD_DECAY_EXIT_FRACTION) {
      return {
        action: "exit",
        reason: `yield ${yieldPct.toFixed(2)}%/d < 70% of ${avgYieldPerDayPct.toFixed(2)}%/d avg`,
      };
    }
  }
  return { action: "hold", reason: "in range" };
}

/**
 * Entry-gate hysteresis: true when the pool's current yield sits below the
 * rotation exit threshold (70% of the trailing average). The ENTER gate
 * rejects such pools so a pool that would be immediately rotated out is never
 * (re-)entered — the source of the observed 1-minute exit→enter churn.
 * Fail-open (false) when the trailing average is unknown.
 */
export function challengeYieldBelowExitThreshold(
  pool: PoolState,
  avgYieldPerDayPct: number | null,
): boolean {
  if (avgYieldPerDayPct === null || avgYieldPerDayPct <= 0) return false;
  const tvl = pool.tvlUsd;
  const yieldPct = tvl > 0 ? (pool.fees24hUsd / tvl) * 100 : 0;
  return yieldPct < avgYieldPerDayPct * YIELD_DECAY_EXIT_FRACTION;
}

/** Rolling per-pool 7d average fee yield from snapshot history. */
export function avgFeeYieldPct(
  snapshots: ReadonlyArray<{ readonly tvlUsd: number; readonly fees24hUsd: number }>,
): number | null {
  if (snapshots.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (const s of snapshots) {
    if (s.tvlUsd > 0) {
      sum += (s.fees24hUsd / s.tvlUsd) * 100;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}
