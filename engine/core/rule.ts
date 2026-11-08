/**
 * rule.ts — the contract every decision rule implements.
 *
 * The old engine decided inside one ~4,200-line `if/else` chain: the first
 * matching branch won, later branches were unreachable, and nothing recorded
 * which branch actually drove a result. A rule here is a small pure object
 * with a stable id, a stage, and an `evaluate` that emits signals instead of
 * returning a decision. All rules run on every cycle; the resolver decides.
 *
 * Rules must be:
 * - pure (no I/O, no clock reads — `now` arrives in the context),
 * - total (never throw; a malformed input yields no signal),
 * - independent (a rule may not read another rule's output).
 *
 * That is what makes them safe to evaluate together, test alone, shadow
 * against the live engine, and score by the PnL of the decisions they drove.
 */

import type { ActionType } from "../types.js";
import type { CostModelConfig } from "../cost-model.js";
import type { EntryEconomics } from "../unit-economics.js";
import type { DecisionPolicy, Regime } from "./policy.js";

/** Where in the decision a rule belongs. Used for ordering and reporting. */
export type RuleStage = "guard" | "exit" | "rebalance" | "entry";

/**
 * How strongly a rule asserts its action.
 * - `directive` — capital protection; resolver must take the highest-severity one.
 * - `veto`      — removes the action from consideration (blocking ENTER).
 * - `vote`      — contributes weight toward an action.
 */
export type SignalStrength = "directive" | "veto" | "vote";

export interface RuleSignal {
  readonly ruleId: string;
  readonly strength: SignalStrength;
  readonly action: ActionType;
  /** Relative weight for `vote`; ignored for directives/vetoes. */
  readonly score: number;
  /** 0..1 conviction the rule has in this signal. */
  readonly confidence: number;
  readonly reason: string;
}

export interface PoolFacts {
  readonly address: string;
  readonly tokenXSymbol: string;
  readonly tokenYSymbol: string;
  readonly tvlUsd: number;
  readonly volume24hUsd: number;
  readonly fees24hUsd: number;
  readonly currentPrice: number;
  readonly activeBinId: number;
  readonly binStep: number;
  /** Observed fee/IL ratio, already clamped by the strategy layer. */
  readonly feeIlRatio: number;
  readonly volumeAuthenticity: number;
  readonly binUtilization: number;
  /** Signed 24h TVL change, fraction (−0.3 = a 30% drop). */
  readonly tvlVelocity: number;
  readonly feeIlRatioKnown: boolean;
  readonly volumeAuthenticityKnown: boolean;
  readonly binUtilizationKnown: boolean;
  readonly farmAprPct: number | null;
  /** Measured trailing-24h price range, percent; null when under-sampled. */
  readonly observedRangePct: number | null;
  /** Realized active-bin volatility (σ of recent bin moves). */
  readonly volatilityStddev: number;
  /** Net drift over the volatility lookback, in bins. */
  readonly netDriftBins: number;
}

export interface PositionFacts {
  readonly id: string;
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly ageMs: number;
  readonly outOfRangeMs: number;
  readonly outOfRangeCycles: number;
  readonly peakValueUsd: number;
  readonly feesClaimedUsd: number;
  readonly rewardsClaimedUsd: number;
  /** Distance of the active bin outside the position range, percent. */
  readonly driftPct: number;
  readonly inRange: boolean;
}

export interface PortfolioFacts {
  readonly valueUsd: number;
  readonly openPositions: number;
  readonly poolPositions: number;
  readonly poolExposureUsd: number;
  readonly dailyDrawdownPct: number;
  /** Count of consecutive cycles the trailing-stop / stop-loss has breached. */
  readonly stopLossBreachCycles: number;
  readonly trailingStopBreachCycles: number;
}

export interface RuleContext {
  readonly now: number;
  readonly pool: PoolFacts;
  readonly position: PositionFacts | null;
  readonly portfolio: PortfolioFacts;
  readonly costs: CostModelConfig;
  readonly policy: DecisionPolicy;
  readonly regime: Regime;
  /** Precomputed entry economics for `candidateSizeUsd`. */
  readonly economics: EntryEconomics;
  readonly candidateSizeUsd: number;
}

export interface Rule {
  readonly id: string;
  readonly stage: RuleStage;
  readonly evaluate: (ctx: RuleContext) => readonly RuleSignal[];
}

/** One emitted signal plus whether the resolver acted on it. */
export interface RuleTrace {
  readonly ruleId: string;
  readonly stage: RuleStage;
  readonly strength: SignalStrength;
  readonly action: ActionType;
  readonly reason: string;
  readonly decisive: boolean;
}

export function signal(input: {
  readonly ruleId: string;
  readonly strength: SignalStrength;
  readonly action: ActionType;
  readonly score?: number;
  readonly confidence?: number;
  readonly reason: string;
}): RuleSignal {
  return {
    ruleId: input.ruleId,
    strength: input.strength,
    action: input.action,
    score: input.score ?? 0,
    confidence: clamp01(input.confidence ?? 0.5),
    reason: input.reason,
  };
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
