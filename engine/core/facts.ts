/**
 * facts.ts — turn engine state into the immutable fact set a rule sees.
 *
 * Facts are built once per evaluation and never mutated. Every field is a
 * plain number/boolean/string so a journal row can record exactly what the
 * decision saw; that is what makes a decision replayable after the RPC state
 * has moved on.
 */

import type { PoolMetrics, PoolState } from "../types.js";
import type { PositionRecord } from "../db-service.js";
import type { PoolFacts, PortfolioFacts, PositionFacts } from "./rule.js";

export interface BuildPoolFactsInput {
  readonly pool: PoolState;
  readonly metrics: PoolMetrics;
  readonly observedRangePct: number | null;
  readonly volatilityStddev: number;
  readonly netDriftBins: number;
}

export function buildPoolFacts(input: BuildPoolFactsInput): PoolFacts {
  const { pool, metrics } = input;
  return {
    address: pool.address,
    tokenXSymbol: pool.tokenXSymbol,
    tokenYSymbol: pool.tokenYSymbol,
    tvlUsd: finite(pool.tvlUsd),
    volume24hUsd: finite(pool.volume24hUsd),
    fees24hUsd: finite(pool.fees24hUsd),
    currentPrice: finite(pool.currentPrice),
    activeBinId: finite(pool.activeBinId),
    binStep: finite(pool.binStep),
    feeIlRatio: finite(metrics.feeIlRatio),
    volumeAuthenticity: finite(metrics.volumeAuthenticity),
    binUtilization: finite(metrics.binUtilization),
    tvlVelocity: finite(metrics.tvlVelocity),
    feeIlRatioKnown: metrics.feeIlRatioKnown,
    volumeAuthenticityKnown: metrics.volumeAuthenticityKnown,
    binUtilizationKnown: metrics.binUtilizationKnown,
    farmAprPct: metrics.farmAprPct ?? null,
    observedRangePct:
      input.observedRangePct !== null && Number.isFinite(input.observedRangePct)
        ? input.observedRangePct
        : null,
    volatilityStddev: finite(input.volatilityStddev),
    netDriftBins: finite(input.netDriftBins),
  };
}

export interface BuildPositionFactsInput {
  readonly position: PositionRecord;
  readonly pool: PoolState;
  readonly now: number;
}

/** Drift as a fraction of the position's half-width (0 = centred, 1 = at edge). */
export function computePositionDriftPct(
  activeBinId: number,
  lowerBinId: number,
  upperBinId: number,
): number {
  const center = (lowerBinId + upperBinId) / 2;
  const halfWidth = Math.max(Math.abs(upperBinId - lowerBinId) / 2, 1);
  const drift = Math.abs(activeBinId - center) / halfWidth;
  return Number.isFinite(drift) ? drift : 1;
}

export function buildPositionFacts(input: BuildPositionFactsInput): PositionFacts {
  const { position, pool, now } = input;
  const driftPct = computePositionDriftPct(
    pool.activeBinId,
    position.lowerBinId,
    position.upperBinId,
  );
  const outOfRangeSince = position.outOfRangeSince;
  const outOfRangeMs =
    outOfRangeSince === null ? 0 : Math.max(0, now - Math.max(0, outOfRangeSince));
  return {
    id: position.positionId,
    depositedUsd: finite(position.depositedUsd),
    currentValueUsd: finite(position.currentValueUsd),
    ageMs: Math.max(0, now - Math.max(0, position.timestamp)),
    outOfRangeMs,
    outOfRangeCycles: finite(position.oorCycleCount),
    peakValueUsd: finite(position.highestValueUsd ?? position.depositedUsd),
    feesClaimedUsd: finite(position.cumulativeFeesClaimedUsd),
    rewardsClaimedUsd: finite(position.cumulativeRewardsClaimedUsd ?? 0),
    driftPct,
    inRange:
      driftPct <= 1 &&
      pool.activeBinId >= position.lowerBinId &&
      pool.activeBinId <= position.upperBinId,
  };
}

export interface BuildPortfolioFactsInput {
  readonly valueUsd: number;
  readonly openPositions: number;
  readonly poolPositions: number;
  readonly poolExposureUsd: number;
  readonly dailyDrawdownPct: number;
  readonly stopLossBreachCycles: number;
  readonly trailingStopBreachCycles: number;
}

export function buildPortfolioFacts(input: BuildPortfolioFactsInput): PortfolioFacts {
  return {
    valueUsd: finite(input.valueUsd),
    openPositions: Math.max(0, Math.trunc(finite(input.openPositions))),
    poolPositions: Math.max(0, Math.trunc(finite(input.poolPositions))),
    poolExposureUsd: finite(input.poolExposureUsd),
    dailyDrawdownPct: finite(input.dailyDrawdownPct),
    stopLossBreachCycles: Math.max(0, Math.trunc(finite(input.stopLossBreachCycles))),
    trailingStopBreachCycles: Math.max(0, Math.trunc(finite(input.trailingStopBreachCycles))),
  };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
