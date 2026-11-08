/**
 * decide.ts — one pure call: facts + policy → decision.
 *
 * This is the seam the engine will eventually call instead of the branch
 * table in `program.ts`. It performs no I/O, reads no clock, and has no
 * hidden state, so the same input always produces the same decision — which
 * is what makes shadow mode and replay meaningful.
 */

import type { ActionType } from "../types.js";
import type { CostModelConfig } from "../cost-model.js";
import { estimateRebalanceCostUsd, estimateRoundTripCostUsd } from "../cost-model.js";
import {
  DEFAULT_MIN_EV_USD,
  evaluateEntryEconomics,
  type EntryEconomics,
} from "../unit-economics.js";
import { classifyRegime, describeRegime } from "./regime.js";
import { resolveEffectivePolicy, type DecisionPolicy, type Regime } from "./policy.js";
import type { PoolFacts, PortfolioFacts, PositionFacts, RuleSignal, RuleTrace } from "./rule.js";
import { RULES, evaluateRules } from "./rules.js";
import { describeDecision, resolveDecision } from "./resolver.js";

export interface DecideInput {
  readonly now: number;
  readonly pool: PoolFacts;
  readonly position: PositionFacts | null;
  readonly portfolio: PortfolioFacts;
  readonly costs: CostModelConfig;
  readonly policy: DecisionPolicy;
  /** Size the engine would deploy if it entered. */
  readonly candidateSizeUsd: number;
}

export interface EngineDecision {
  readonly action: ActionType;
  readonly confidence: number;
  readonly reasoning: string;
  readonly reasons: ReadonlyArray<RuleTrace>;
  readonly vetoes: ReadonlyArray<RuleSignal>;
  readonly regime: Regime;
  readonly policyVersion: string;
  readonly economics: EntryEconomics;
  readonly costUsd: number;
  readonly minSizeUsd: number;
  /** Effective (regime-adjusted) holding horizon the EV was measured over. */
  readonly horizonDays: number;
}

/** Daily move assumption: half the measured 24h range, else the policy default. */
export function resolveDailyMovePct(observedRangePct: number | null, fallbackPct: number): number {
  if (observedRangePct !== null && Number.isFinite(observedRangePct) && observedRangePct > 0) {
    return observedRangePct / 2;
  }
  return fallbackPct;
}

export function decide(input: DecideInput): EngineDecision {
  const regime = classifyRegime({
    volatilityStddev: input.pool.volatilityStddev,
    maxVolatilityStddev: input.policy.exit.maxVolatilityStddev,
    netDriftBins: input.pool.netDriftBins,
    tvlVelocity: input.pool.tvlVelocity,
    volumeAuthenticity: input.pool.volumeAuthenticity,
    volumeAuthenticityKnown: input.pool.volumeAuthenticityKnown,
  });
  const policy = resolveEffectivePolicy(input.policy, regime);

  const dailyMovePct = resolveDailyMovePct(
    input.pool.observedRangePct,
    policy.entry.maxDailyMovePct,
  );
  const roundTrip = estimateRoundTripCostUsd(input.candidateSizeUsd, input.costs);
  const economics = evaluateEntryEconomics({
    positionSizeUsd: input.candidateSizeUsd,
    poolTvlUsd: input.pool.tvlUsd,
    poolFees24hUsd: input.pool.fees24hUsd,
    horizonDays: policy.entry.horizonDays,
    dailyMovePct,
    concentrationFactor: policy.entry.concentrationFactor,
    inRangeFraction: policy.entry.inRangeFraction,
    roundTripCostUsd: roundTrip.totalUsd,
    minEvUsd: policy.entry.minEvUsd,
    maxBreakEvenHoldDays: policy.entry.maxBreakEvenHoldDays,
  });

  const ctx = {
    now: input.now,
    pool: input.pool,
    position: input.position,
    portfolio: input.portfolio,
    costs: input.costs,
    policy,
    regime,
    economics,
    candidateSizeUsd: input.candidateSizeUsd,
  };

  const signals = evaluateRules(ctx, RULES);
  const resolved = resolveDecision(signals);
  const rebalanceCost = estimateRebalanceCostUsd(input.candidateSizeUsd, input.costs);
  const reasoning = `${describeDecision(resolved)} | ${describeRegime(
    {
      volatilityStddev: input.pool.volatilityStddev,
      maxVolatilityStddev: input.policy.exit.maxVolatilityStddev,
      netDriftBins: input.pool.netDriftBins,
      tvlVelocity: input.pool.tvlVelocity,
      volumeAuthenticity: input.pool.volumeAuthenticity,
      volumeAuthenticityKnown: input.pool.volumeAuthenticityKnown,
    },
    regime,
  )} | EV $${economics.evUsd.toFixed(4)} vs cost $${economics.costUsd.toFixed(4)}`;

  return {
    action: resolved.action,
    confidence: resolved.confidence,
    reasoning,
    reasons: resolved.reasons,
    vetoes: resolved.vetoes,
    regime,
    policyVersion: policy.version,
    economics,
    costUsd: input.position === null ? economics.costUsd : rebalanceCost.totalUsd,
    minSizeUsd: economics.minViableSizeUsd,
    horizonDays: policy.entry.horizonDays,
  };
}

/** Minimum EV used when a policy omits it (kept explicit for replay). */
export const FALLBACK_MIN_EV_USD = DEFAULT_MIN_EV_USD;
