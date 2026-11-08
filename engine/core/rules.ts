/**
 * rules.ts — the first rule set for the decision core.
 *
 * Each rule is a few lines, pure, and independently testable. They are all
 * evaluated on every cycle; the resolver decides. The set below covers the
 * conditions responsible for essentially all of the observed PnL:
 *
 *   guards   unit economics, dead pool, quality floors, capacity, drawdown
 *   exits    stop-loss, trailing stop, TVL flight, fee/IL degradation,
 *            out-of-range drift, high-volatility exit
 *   rebalance cost-vs-benefit of re-ranging
 *   entry    positive-EV entry vote
 *
 * Adding a rule is adding one object here (or one file that exports one) and
 * a unit test — never editing a 4,000-line function.
 */

import type { ActionType } from "../types.js";
import { estimateRebalanceCostUsd } from "../cost-model.js";
import { evaluateRebalanceEconomics } from "../unit-economics.js";
import { signal, type Rule, type RuleContext, type RuleSignal } from "./rule.js";

const ENTER: ActionType = "ENTER";
const EXIT: ActionType = "EXIT";
const HOLD: ActionType = "HOLD";
const REBALANCE: ActionType = "REBALANCE";

// ─── Guards (veto a new entry) ───────────────────────────────────────────────

const guardUnitEconomics: Rule = {
  id: "guard.unit_economics",
  stage: "guard",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    if (ctx.position !== null) return [];
    if (!ctx.policy.entry.enabled) {
      return [
        signal({
          ruleId: "guard.unit_economics",
          strength: "veto",
          action: ENTER,
          reason: `Entries disabled by the ${ctx.regime} regime profile`,
        }),
      ];
    }
    if (ctx.economics.approved) return [];
    return [
      signal({
        ruleId: "guard.unit_economics",
        strength: "veto",
        action: ENTER,
        reason: ctx.economics.reason,
      }),
    ];
  },
};

const guardPoolHealth: Rule = {
  id: "guard.pool_health",
  stage: "guard",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    if (ctx.position !== null) return [];
    if (ctx.pool.tvlUsd <= 0) {
      return [
        signal({
          ruleId: "guard.pool_health",
          strength: "veto",
          action: ENTER,
          reason: "Pool reports zero TVL — no book to enter",
        }),
      ];
    }
    if (ctx.pool.fees24hUsd <= 0 && ctx.pool.volume24hUsd <= 0) {
      return [
        signal({
          ruleId: "guard.pool_health",
          strength: "veto",
          action: ENTER,
          reason: "Pool has zero 24h volume and fees — dead feed or dead pool",
        }),
      ];
    }
    return [];
  },
};

const guardFeePlausibility: Rule = {
  id: "guard.fee_plausibility",
  stage: "guard",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    if (ctx.position !== null) return [];
    if (ctx.pool.tvlUsd <= 0) return [];
    const dailyYieldPct = (ctx.pool.fees24hUsd / ctx.pool.tvlUsd) * 100;
    if (dailyYieldPct <= ctx.policy.entry.maxDailyFeeYieldPct) return [];
    return [
      signal({
        ruleId: "guard.fee_plausibility",
        strength: "veto",
        action: ENTER,
        reason:
          `Fee yield ${dailyYieldPct.toFixed(1)}%/day of TVL exceeds ` +
          `${ctx.policy.entry.maxDailyFeeYieldPct}% — one-off print, not a sustainable yield`,
      }),
    ];
  },
};

const guardQualityFloors: Rule = {
  id: "guard.quality_floors",
  stage: "guard",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    if (ctx.position !== null) return [];
    const { entry } = ctx.policy;
    const out: RuleSignal[] = [];
    if (ctx.pool.feeIlRatioKnown && ctx.pool.feeIlRatio < entry.minFeeIlRatio) {
      out.push(
        signal({
          ruleId: "guard.quality_floors",
          strength: "veto",
          action: ENTER,
          reason: `Fee/IL ${ctx.pool.feeIlRatio.toFixed(2)} < ${entry.minFeeIlRatio}`,
        }),
      );
    }
    if (
      ctx.pool.volumeAuthenticityKnown &&
      ctx.pool.volumeAuthenticity < entry.minVolumeAuthenticity
    ) {
      out.push(
        signal({
          ruleId: "guard.quality_floors",
          strength: "veto",
          action: ENTER,
          reason: `Volume authenticity ${ctx.pool.volumeAuthenticity.toFixed(2)} < ${entry.minVolumeAuthenticity}`,
        }),
      );
    }
    if (ctx.pool.binUtilizationKnown && ctx.pool.binUtilization < entry.minBinUtilization) {
      out.push(
        signal({
          ruleId: "guard.quality_floors",
          strength: "veto",
          action: ENTER,
          reason: `Bin utilization ${ctx.pool.binUtilization.toFixed(2)} < ${entry.minBinUtilization}`,
        }),
      );
    }
    if (
      ctx.pool.observedRangePct !== null &&
      ctx.pool.observedRangePct > entry.maxObservedRangePct
    ) {
      out.push(
        signal({
          ruleId: "guard.quality_floors",
          strength: "veto",
          action: ENTER,
          reason:
            `Observed 24h range ${ctx.pool.observedRangePct.toFixed(1)}% > ` +
            `${entry.maxObservedRangePct}% — too volatile to enter`,
        }),
      );
    }
    return out;
  },
};

const guardCapacity: Rule = {
  id: "guard.capacity",
  stage: "guard",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    if (ctx.position !== null) return [];
    const { portfolio, policy } = ctx;
    if (portfolio.poolPositions >= policy.portfolio.maxPositionsPerPool) {
      return [
        signal({
          ruleId: "guard.capacity",
          strength: "veto",
          action: ENTER,
          reason: `Per-pool position cap reached (${portfolio.poolPositions}/${policy.portfolio.maxPositionsPerPool})`,
        }),
      ];
    }
    if (portfolio.openPositions >= policy.portfolio.maxOpenPositions) {
      return [
        signal({
          ruleId: "guard.capacity",
          strength: "veto",
          action: ENTER,
          reason: `Max open positions reached (${portfolio.openPositions}/${policy.portfolio.maxOpenPositions})`,
        }),
      ];
    }
    return [];
  },
};

const guardDrawdown: Rule = {
  id: "guard.drawdown",
  stage: "guard",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    if (ctx.position !== null) return [];
    const cap = ctx.policy.portfolio.maxDailyDrawdownPct;
    if (cap > 0 && ctx.portfolio.dailyDrawdownPct >= cap) {
      return [
        signal({
          ruleId: "guard.drawdown",
          strength: "veto",
          action: ENTER,
          reason: `Daily drawdown ${ctx.portfolio.dailyDrawdownPct.toFixed(1)}% ≥ ${cap}% — entries paused`,
        }),
      ];
    }
    return [];
  },
};

// ─── Exit directives (capital protection) ────────────────────────────────────

const exitStopLoss: Rule = {
  id: "exit.stop_loss",
  stage: "exit",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    const pos = ctx.position;
    if (pos === null || pos.depositedUsd <= 0) return [];
    const lossPct = (pos.currentValueUsd - pos.depositedUsd) / pos.depositedUsd;
    const threshold = -ctx.policy.exit.stopLossPct;
    if (lossPct > threshold) return [];
    if (ctx.portfolio.stopLossBreachCycles < ctx.policy.exit.confirmCycles) return [];
    return [
      signal({
        ruleId: "exit.stop_loss",
        strength: "directive",
        action: EXIT,
        confidence: 1,
        reason:
          `Stop-loss: ${(lossPct * 100).toFixed(1)}% loss ≥ ${(threshold * 100).toFixed(0)}% ` +
          `(${ctx.portfolio.stopLossBreachCycles}/${ctx.policy.exit.confirmCycles} cycles)`,
      }),
    ];
  },
};

const exitTrailingStop: Rule = {
  id: "exit.trailing_stop",
  stage: "exit",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    const pos = ctx.position;
    if (pos === null || pos.peakValueUsd <= 0) return [];
    const drawdown = (pos.peakValueUsd - pos.currentValueUsd) / pos.peakValueUsd;
    if (drawdown <= ctx.policy.exit.trailingStopPct) return [];
    if (ctx.portfolio.trailingStopBreachCycles < ctx.policy.exit.confirmCycles) return [];
    return [
      signal({
        ruleId: "exit.trailing_stop",
        strength: "directive",
        action: EXIT,
        confidence: 0.8,
        reason:
          `Trailing stop: ${(drawdown * 100).toFixed(1)}% off peak $${pos.peakValueUsd.toFixed(2)} ` +
          `(${ctx.portfolio.trailingStopBreachCycles}/${ctx.policy.exit.confirmCycles} cycles)`,
      }),
    ];
  },
};

const exitTvlFlight: Rule = {
  id: "exit.tvl_flight",
  stage: "exit",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    if (ctx.position === null) return [];
    if (ctx.pool.tvlVelocity > -ctx.policy.exit.tvlDropExitPct) return [];
    // A collapse with no volume or fees at all is a dead stats feed, not a
    // flight — the engine learned this from a false USDC/TOKEN relabel EXIT.
    if (ctx.pool.volume24hUsd <= 0 && ctx.pool.fees24hUsd <= 0) return [];
    return [
      signal({
        ruleId: "exit.tvl_flight",
        strength: "directive",
        action: EXIT,
        confidence: 0.9,
        reason: `TVL dropped ${(ctx.pool.tvlVelocity * 100).toFixed(1)}% — capital protection exit`,
      }),
    ];
  },
};

const exitFeeIlDegradation: Rule = {
  id: "exit.fee_il_degradation",
  stage: "exit",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    if (ctx.position === null) return [];
    if (!ctx.pool.feeIlRatioKnown) return [];
    if (ctx.pool.feeIlRatio >= ctx.policy.exit.feeIlExitFloor) return [];
    return [
      signal({
        ruleId: "exit.fee_il_degradation",
        strength: "directive",
        action: EXIT,
        confidence: 0.8,
        reason:
          `Fee/IL ${ctx.pool.feeIlRatio.toFixed(2)} < ${ctx.policy.exit.feeIlExitFloor} — ` +
          `expected fees no longer beat IL`,
      }),
    ];
  },
};

const exitOutOfRange: Rule = {
  id: "exit.out_of_range",
  stage: "exit",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    const pos = ctx.position;
    if (pos === null) return [];
    const drifted = pos.driftPct >= ctx.policy.exit.oorDriftPct / 100;
    const graceExpired = pos.outOfRangeCycles > ctx.policy.exit.oorGraceCycles;
    if (!drifted && !graceExpired) return [];
    const action = ctx.regime === "volatile" || ctx.regime === "degraded" ? EXIT : REBALANCE;
    return [
      signal({
        ruleId: "exit.out_of_range",
        strength: "directive",
        action,
        confidence: 0.75,
        reason:
          `Out of range: drift ${(pos.driftPct * 100).toFixed(0)}% ` +
          `(threshold ${ctx.policy.exit.oorDriftPct}%), ` +
          `${pos.outOfRangeCycles}/${ctx.policy.exit.oorGraceCycles} grace cycles, ` +
          `regime ${ctx.regime} → ${action}`,
      }),
    ];
  },
};

const exitVolatility: Rule = {
  id: "exit.volatility",
  stage: "exit",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    const pos = ctx.position;
    if (pos === null) return [];
    if (ctx.regime !== "volatile") return [];
    if (pos.driftPct < 0.5) return [];
    return [
      signal({
        ruleId: "exit.volatility",
        strength: "directive",
        action: EXIT,
        confidence: 0.7,
        reason:
          `High volatility (σ=${ctx.pool.volatilityStddev.toFixed(2)} ≥ ` +
          `${ctx.policy.exit.maxVolatilityStddev}) with ${(pos.driftPct * 100).toFixed(0)}% drift — ` +
          `exit rather than re-range into the move`,
      }),
    ];
  },
};

// ─── Rebalance economics (vote) ──────────────────────────────────────────────

const rebalanceEconomics: Rule = {
  id: "rebalance.economics",
  stage: "rebalance",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    const pos = ctx.position;
    if (pos === null) return [];
    if (pos.driftPct < 0.3 && pos.outOfRangeCycles === 0) return [];
    const horizon = Math.max(ctx.policy.entry.horizonDays, 0.25);
    const dailyFees = ctx.economics.expectedFeesUsd / horizon;
    const dailyYieldPct = pos.currentValueUsd > 0 ? (dailyFees / pos.currentValueUsd) * 100 : 0;
    const cost = estimateRebalanceCostUsd(pos.currentValueUsd, ctx.costs).totalUsd;
    const ev = evaluateRebalanceEconomics({
      positionValueUsd: pos.currentValueUsd,
      recoveredYieldPerDayPct: dailyYieldPct,
      horizonDays: horizon,
      costUsd: cost,
    });
    return [
      signal({
        ruleId: "rebalance.economics",
        strength: "vote",
        action: ev.approved ? REBALANCE : HOLD,
        score: ev.approved ? Math.max(0.1, ev.evUsd / Math.max(cost, 1e-9)) : 1,
        confidence: ev.approved ? 0.7 : 0.6,
        reason: ev.reason,
      }),
    ];
  },
};

// ─── Entry (vote) ────────────────────────────────────────────────────────────

const entryEconomics: Rule = {
  id: "entry.economics",
  stage: "entry",
  evaluate(ctx: RuleContext): readonly RuleSignal[] {
    if (ctx.position !== null) return [];
    if (!ctx.economics.approved) return [];
    const edge = ctx.economics.evUsd / Math.max(ctx.economics.costUsd, 1e-9);
    return [
      signal({
        ruleId: "entry.economics",
        strength: "vote",
        action: ENTER,
        score: Math.min(Math.max(edge, 0.1), 10),
        confidence: Math.min(0.95, 0.5 + edge / 20),
        reason: ctx.economics.reason,
      }),
    ];
  },
};

/** Every rule, evaluated in this order every cycle. */
export const RULES: ReadonlyArray<Rule> = [
  guardUnitEconomics,
  guardPoolHealth,
  guardFeePlausibility,
  guardQualityFloors,
  guardCapacity,
  guardDrawdown,
  exitStopLoss,
  exitTrailingStop,
  exitTvlFlight,
  exitFeeIlDegradation,
  exitOutOfRange,
  exitVolatility,
  rebalanceEconomics,
  entryEconomics,
];

/** Evaluate every rule against one context. Pure; never throws. */
export function evaluateRules(
  ctx: RuleContext,
  rules: ReadonlyArray<Rule> = RULES,
): ReadonlyArray<RuleSignal> {
  const out: RuleSignal[] = [];
  for (const rule of rules) {
    try {
      out.push(...rule.evaluate(ctx));
    } catch {
      // A rule bug must not take the cycle down. The resolver sees no signal
      // from it, which fails closed (no ENTER vote) rather than open.
    }
  }
  return out;
}
