/**
 * decision-shadow.ts — run the rule core beside the live engine, safely.
 *
 * This module is the only bridge between the legacy branch table and
 * `engine/core`. It is PURE: it builds facts from values the caller already
 * has, runs `decide`, and returns journal rows plus an economics verdict.
 * The caller decides whether to write the rows and whether to enforce the
 * verdict — nothing here executes, logs or touches the chain.
 *
 * Shadow mode exists so the rule core can be proven against real cycles
 * before it is trusted: every row carries both actions, and disagreement is
 * a number you can watch instead of a leap of faith.
 */

import type { AgentDecision, PoolMetrics, PoolState } from "./types.js";
import type { AppConfig } from "./config-service.js";
import type { PositionRecord } from "./db-service.js";
import { buildDecisionJournalRecord, type DecisionJournalRecord } from "./decision-journal.js";
import { costModelFromConfig, estimateRebalanceCostUsd } from "./cost-model.js";
import { evaluateRebalanceEconomics } from "./unit-economics.js";
import { buildPoolFacts, buildPortfolioFacts, buildPositionFacts } from "./core/facts.js";
import { buildPolicy } from "./core/policy.js";
import { decide, type DecideInput, type EngineDecision } from "./core/decide.js";

export interface ShadowPortfolioInput {
  readonly valueUsd: number;
  readonly openPositions: number;
  readonly poolPositions: number;
  readonly poolExposureUsd: number;
  readonly dailyDrawdownPct: number;
  readonly stopLossBreachCycles: number;
  readonly trailingStopBreachCycles: number;
}

export interface ShadowInput {
  readonly now: number;
  readonly cycleId: string;
  readonly config: AppConfig;
  readonly pool: PoolState;
  readonly metrics: PoolMetrics;
  readonly position: PositionRecord | null;
  readonly portfolio: ShadowPortfolioInput;
  readonly volatilityStddev: number;
  readonly netDriftBins: number;
  readonly observedRangePct: number | null;
  /** Size the legacy decision would deploy (ENTER) or the position value (REBALANCE). */
  readonly candidateSizeUsd: number;
  readonly legacyDecision: AgentDecision;
  readonly riskApproved: boolean;
  readonly legacyJournalId: string;
  readonly shadowJournalId: string;
}

export interface EconomicsVerdict {
  /** True when the action's expected value does not clear its cost. */
  readonly blocked: boolean;
  readonly reason: string;
  readonly evUsd: number;
  readonly costUsd: number;
  readonly minSizeUsd: number;
}

export interface ShadowOutput {
  readonly legacyRow: DecisionJournalRecord;
  readonly shadowRow: DecisionJournalRecord | null;
  readonly engineDecision: EngineDecision;
  readonly economics: EconomicsVerdict | null;
}

/**
 * Build the pure rule-core input from facts the caller already has. Shared
 * with `DECISION_ENGINE=rules`, which must evaluate the core BEFORE the risk
 * gates (to adopt its action) and then journal the SAME evaluation afterwards
 * so the row and the dispatch can never describe different inputs.
 */
export function buildDecideInput(input: ShadowInput): DecideInput {
  const policy = buildPolicy(input.config);
  return {
    now: input.now,
    pool: buildPoolFacts({
      pool: input.pool,
      metrics: input.metrics,
      observedRangePct: input.observedRangePct,
      volatilityStddev: input.volatilityStddev,
      netDriftBins: input.netDriftBins,
    }),
    position:
      input.position === null
        ? null
        : buildPositionFacts({ position: input.position, pool: input.pool, now: input.now }),
    portfolio: buildPortfolioFacts({
      valueUsd: input.portfolio.valueUsd,
      openPositions: input.portfolio.openPositions,
      poolPositions: input.portfolio.poolPositions,
      poolExposureUsd: input.portfolio.poolExposureUsd,
      dailyDrawdownPct: input.portfolio.dailyDrawdownPct,
      stopLossBreachCycles: input.portfolio.stopLossBreachCycles,
      trailingStopBreachCycles: input.portfolio.trailingStopBreachCycles,
    }),
    costs: costModelFromConfig(input.config),
    policy,
    candidateSizeUsd: Math.max(0, input.candidateSizeUsd),
  };
}

/** Build both journal rows and the economics verdict for one decision. */
export function runDecisionShadow(input: ShadowInput): ShadowOutput {
  const { config } = input;
  const decideInput = buildDecideInput(input);
  const poolFacts = decideInput.pool;
  const positionFacts = decideInput.position;
  const portfolioFacts = decideInput.portfolio;
  const costs = decideInput.costs;
  const engineDecision = decide(decideInput);

  const factsDigest = {
    pool: poolFacts,
    position: positionFacts,
    portfolio: portfolioFacts,
    regime: engineDecision.regime,
    policyVersion: engineDecision.policyVersion,
    costs: {
      gasPriceGwei: costs.gasPriceGwei,
      nativePriceUsd: costs.nativePriceUsd,
      swapFeeBps: costs.swapFeeBps,
      slippageBps: costs.slippageBps,
    },
  };
  const signalsDigest = engineDecision.reasons.map((r) => ({
    ruleId: r.ruleId,
    stage: r.stage,
    strength: r.strength,
    action: r.action,
    reason: r.reason,
    decisive: r.decisive,
  }));
  const decisionDigest = {
    action: engineDecision.action,
    confidence: engineDecision.confidence,
    reasoning: engineDecision.reasoning,
    evUsd: engineDecision.economics.evUsd,
    costUsd: engineDecision.costUsd,
    minSizeUsd: engineDecision.minSizeUsd,
    vetoes: engineDecision.vetoes.map((v) => v.reason),
  };

  const legacyRow = buildDecisionJournalRecord({
    id: input.legacyJournalId,
    timestamp: input.now,
    cycleId: input.cycleId,
    poolAddress: input.pool.address,
    positionId: input.position?.positionId ?? input.legacyDecision.positionId ?? null,
    engine: "legacy",
    kind: input.riskApproved ? "proposed" : "suppressed",
    action: input.legacyDecision.action,
    confidence: input.legacyDecision.confidence,
    reasoning: input.legacyDecision.reasoning,
    evUsd: engineDecision.economics.evUsd,
    costUsd: engineDecision.costUsd,
    minSizeUsd: engineDecision.minSizeUsd,
    regime: engineDecision.regime,
    facts: factsDigest,
    signals: null,
    decision: {
      action: input.legacyDecision.action,
      confidence: input.legacyDecision.confidence,
      reasoning: input.legacyDecision.reasoning,
      positionSizeUsd: input.legacyDecision.positionSizeUsd ?? null,
    },
  });

  const shadowRow =
    config.decisionEngine === "legacy"
      ? null
      : buildDecisionJournalRecord({
          id: input.shadowJournalId,
          timestamp: input.now,
          cycleId: input.cycleId,
          poolAddress: input.pool.address,
          positionId: input.position?.positionId ?? input.legacyDecision.positionId ?? null,
          engine: "rules",
          kind: "shadow",
          action: engineDecision.action,
          confidence: engineDecision.confidence,
          reasoning: engineDecision.reasoning,
          evUsd: engineDecision.economics.evUsd,
          costUsd: engineDecision.costUsd,
          minSizeUsd: engineDecision.minSizeUsd,
          regime: engineDecision.regime,
          facts: factsDigest,
          signals: signalsDigest,
          decision: decisionDigest,
        });

  return {
    legacyRow,
    shadowRow,
    engineDecision,
    economics: evaluateEconomics(input, engineDecision, costs),
  };
}

function evaluateEconomics(
  input: ShadowInput,
  engineDecision: EngineDecision,
  costs: ReturnType<typeof costModelFromConfig>,
): EconomicsVerdict | null {
  const action = input.legacyDecision.action;
  if (action === "ENTER") {
    // A vetoed entry is not merely uneconomic — it fails a safety/quality
    // invariant (dead pool, implausible fee print, capacity). The gate must
    // honour that, otherwise `enforce` would still let it through.
    const veto = engineDecision.vetoes.find((v) => v.action === "ENTER");
    if (veto !== undefined) {
      return {
        blocked: true,
        reason: veto.reason,
        evUsd: engineDecision.economics.evUsd,
        costUsd: engineDecision.economics.costUsd,
        minSizeUsd: engineDecision.economics.minViableSizeUsd,
      };
    }
    return {
      blocked: !engineDecision.economics.approved,
      reason: engineDecision.economics.reason,
      evUsd: engineDecision.economics.evUsd,
      costUsd: engineDecision.economics.costUsd,
      minSizeUsd: engineDecision.economics.minViableSizeUsd,
    };
  }
  if (action === "REBALANCE") {
    const value = Math.max(0, input.candidateSizeUsd);
    const horizon = Math.max(engineDecision.horizonDays, 0.25);
    // Reuse the entry model's expected fees, but measure the incremental
    // benefit of re-ranging against the rebalance cost.
    const dailyFees = engineDecision.economics.expectedFeesUsd / horizon;
    const dailyYieldPct = value > 0 ? (dailyFees / value) * 100 : 0;
    const cost = estimateRebalanceCostUsd(value, costs).totalUsd;
    const ev = evaluateRebalanceEconomics({
      positionValueUsd: value,
      recoveredYieldPerDayPct: dailyYieldPct,
      horizonDays: horizon,
      costUsd: cost,
      minEvUsd: 0.01,
    });
    return {
      blocked: !ev.approved,
      reason: ev.reason,
      evUsd: ev.evUsd,
      costUsd: ev.costUsd,
      minSizeUsd: 0,
    };
  }
  return null;
}
