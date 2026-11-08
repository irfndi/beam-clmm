/**
 * unit-economics.ts — "can this trade pay for itself?" as a pure function.
 *
 * The engine decided ENTER/REBALANCE on a chain of qualitative gates (fee/IL,
 * volume authenticity, range drift, …) but never asked the question that
 * determines profitability at a given bankroll: do the expected fees exceed
 * the round-trip cost plus the IL the position will take over its holding
 * horizon? A $17 position held for two hours earns ~0.003% while a Base round
 * trip costs ~0.35% — a 100× gap that no gate in the old decision path
 * measured.
 *
 * Everything here is pure and unit-tested. All money values are USD, all
 * percentages are percentage points (5 = 5%), all fractions are 0..1.
 */

import type { CostModelConfig } from "./cost-model.js";
import {
  estimateEnterCostUsd,
  estimateExitCostUsd,
  estimateRoundTripCostUsd,
} from "./cost-model.js";

/** Default holding horizon for an entry decision, in days. */
export const DEFAULT_ENTRY_HORIZON_DAYS = 7;
/** Default expected daily |price move| when no volatility read exists, in percent. */
export const DEFAULT_DAILY_MOVE_PCT = 2;
/** Narrow-range capital concentrates fee capture versus a pro-rata share. */
export const MAX_CONCENTRATION_FACTOR = 10;
/**
 * Hard cap on the daily fee yield a single 24h print may imply, as a fraction
 * of position value (0.05 = 5%/day). A smoke run on fresh pools produced
 * fees24h/TVL ≈ 19%/day, which the model extrapolated into a $1,355 EV on a
 * $500 position — one launch-day print is not a sustainable yield, and the EV
 * gate must not green-light a position on fantasy economics.
 */
export const MAX_DAILY_FEE_YIELD = 0.05;
/** Below this, an EV is economically indistinguishable from zero after fees. */
export const DEFAULT_MIN_EV_USD = 0.01;
/**
 * Longest break-even hold a trade may require. A position whose fees need
 * weeks of uninterrupted in-range time to pay its own round trip is not a
 * trade, it is a lottery ticket: the engine observed live holds of ~2h, so a
 * $17 position needing ~6 days to break even could never get there.
 */
export const DEFAULT_MAX_BREAK_EVEN_HOLD_DAYS = 3;

export interface EntryEconomicsInput {
  readonly positionSizeUsd: number;
  readonly poolTvlUsd: number;
  readonly poolFees24hUsd: number;
  /** Expected holding horizon in days. */
  readonly horizonDays: number;
  /** Expected daily absolute price move, percent (e.g. 2 = 2%). */
  readonly dailyMovePct: number;
  /**
   * Fee-capture multiplier from range concentration. 1 = pro-rata share of
   * pool fees; 3 = a range ~3× tighter than the pool's own liquidity
   * distribution. Clamped to [1, MAX_CONCENTRATION_FACTOR].
   */
  readonly concentrationFactor: number;
  /** Expected share of the horizon the position stays in range, 0..1. */
  readonly inRangeFraction: number;
  /** All-in USD cost of entering AND eventually exiting at this size. */
  readonly roundTripCostUsd: number;
  /** Minimum net EV that counts as a real edge. */
  readonly minEvUsd?: number;
  /** Longest break-even hold allowed, in days. */
  readonly maxBreakEvenHoldDays?: number;
}

export interface EntryEconomics {
  /** Expected fees earned over the horizon. */
  readonly expectedFeesUsd: number;
  /** Expected impermanent loss over the horizon. */
  readonly expectedIlUsd: number;
  /** Round-trip execution cost. */
  readonly costUsd: number;
  /** expectedFees − expectedIl − cost. */
  readonly evUsd: number;
  /** Size at which expected fees exactly cover the round-trip cost. */
  readonly minViableSizeUsd: number;
  /** Days of uninterrupted fee accrual needed to pay the round-trip cost. */
  readonly breakEvenHoldDays: number;
  /** True when evUsd clears the configured floor and the size clears break-even. */
  readonly approved: boolean;
  readonly reason: string;
}

/** Full-range IL fraction for a price ratio (r = newPrice / oldPrice). */
export function impermanentLossFraction(priceRatio: number): number {
  if (!Number.isFinite(priceRatio) || priceRatio <= 0) return 0;
  return Math.abs((2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1);
}

/**
 * Expected IL fraction over a horizon from a daily move assumption.
 *
 * Treats daily moves as independent: the horizon move is σ_daily × √horizon.
 * This is deliberately simple and conservative — it understates IL in a
 * trending market (where a single directional move dominates) and is why the
 * regime layer narrows the horizon for trending pools instead of trusting this
 * number alone.
 */
export function estimateExpectedIlFraction(dailyMovePct: number, horizonDays: number): number {
  if (!Number.isFinite(dailyMovePct) || dailyMovePct <= 0) return 0;
  if (!Number.isFinite(horizonDays) || horizonDays <= 0) return 0;
  const horizonMove = (dailyMovePct / 100) * Math.sqrt(horizonDays);
  return impermanentLossFraction(1 + horizonMove);
}

/**
 * Daily fee yield a position of `positionSizeUsd` captures: the pool's 24h
 * fees pro-rated by TVL share, amplified by range concentration and discounted
 * by time out of range.
 */
export function estimatePositionDailyFeesUsd(input: {
  readonly positionSizeUsd: number;
  readonly poolTvlUsd: number;
  readonly poolFees24hUsd: number;
  readonly concentrationFactor: number;
  readonly inRangeFraction: number;
}): number {
  if (input.poolTvlUsd <= 0 || input.poolFees24hUsd <= 0 || input.positionSizeUsd <= 0) return 0;
  const concentration = clampConcentration(input.concentrationFactor);
  const inRange = clampFraction(input.inRangeFraction);
  const dailyYield = Math.min(input.poolFees24hUsd / input.poolTvlUsd, MAX_DAILY_FEE_YIELD);
  return input.positionSizeUsd * dailyYield * concentration * inRange;
}

/**
 * Break-even position size: the size at which expected fees over the horizon
 * exactly cover the round-trip cost. Returns Infinity when the pool yields
 * nothing — you can never pay the cost by sizing up into a dead pool.
 *
 * This is the number to compare against the wallet. If it exceeds the capital
 * available, the correct action is not to trade, not to "try a smaller
 * position".
 */
export function minimumViableSizeUsd(input: {
  readonly poolTvlUsd: number;
  readonly poolFees24hUsd: number;
  readonly horizonDays: number;
  readonly concentrationFactor: number;
  readonly inRangeFraction: number;
  readonly roundTripCostUsd: number;
}): number {
  if (input.poolTvlUsd <= 0 || input.poolFees24hUsd <= 0 || input.horizonDays <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (input.roundTripCostUsd <= 0) return 0;
  // Fee yield per dollar of position over the horizon (capped so a one-off
  // 24h fee print cannot justify an otherwise uneconomic size).
  const yieldPerUsd =
    Math.min(input.poolFees24hUsd / input.poolTvlUsd, MAX_DAILY_FEE_YIELD) *
    clampConcentration(input.concentrationFactor) *
    clampFraction(input.inRangeFraction) *
    input.horizonDays;
  if (!Number.isFinite(yieldPerUsd) || yieldPerUsd <= 0) return Number.POSITIVE_INFINITY;
  return input.roundTripCostUsd / yieldPerUsd;
}

/** Evaluate whether an ENTER at this size and horizon clears its own cost. */
export function evaluateEntryEconomics(input: EntryEconomicsInput): EntryEconomics {
  const size = finiteOrZero(input.positionSizeUsd);
  const horizon = Math.max(0, finiteOrZero(input.horizonDays));
  const minEvUsd = input.minEvUsd ?? DEFAULT_MIN_EV_USD;

  const dailyFees = estimatePositionDailyFeesUsd({
    positionSizeUsd: size,
    poolTvlUsd: input.poolTvlUsd,
    poolFees24hUsd: input.poolFees24hUsd,
    concentrationFactor: input.concentrationFactor,
    inRangeFraction: input.inRangeFraction,
  });
  const expectedFeesUsd = dailyFees * horizon;
  const expectedIlUsd = size * estimateExpectedIlFraction(input.dailyMovePct, horizon);
  const costUsd = Math.max(0, finiteOrZero(input.roundTripCostUsd));
  const evUsd = expectedFeesUsd - expectedIlUsd - costUsd;

  const minSize = minimumViableSizeUsd({
    poolTvlUsd: input.poolTvlUsd,
    poolFees24hUsd: input.poolFees24hUsd,
    horizonDays: horizon,
    concentrationFactor: input.concentrationFactor,
    inRangeFraction: input.inRangeFraction,
    roundTripCostUsd: costUsd,
  });
  const breakEvenHoldDays = dailyFees > 0 ? costUsd / dailyFees : Number.POSITIVE_INFINITY;
  const maxBreakEvenHoldDays = input.maxBreakEvenHoldDays ?? DEFAULT_MAX_BREAK_EVEN_HOLD_DAYS;

  if (size <= 0) {
    return {
      expectedFeesUsd,
      expectedIlUsd,
      costUsd,
      evUsd,
      minViableSizeUsd: minSize,
      breakEvenHoldDays,
      approved: false,
      reason: "Position size is zero — nothing to deploy",
    };
  }
  if (!Number.isFinite(evUsd)) {
    return {
      expectedFeesUsd,
      expectedIlUsd,
      costUsd,
      evUsd,
      minViableSizeUsd: minSize,
      breakEvenHoldDays,
      approved: false,
      reason: "Unit-economics inputs are not finite — refusing entry",
    };
  }
  if (!Number.isFinite(minSize)) {
    return {
      expectedFeesUsd,
      expectedIlUsd,
      costUsd,
      evUsd,
      minViableSizeUsd: minSize,
      breakEvenHoldDays,
      approved: false,
      reason: "Pool yields no fees — round-trip cost can never be recovered",
    };
  }

  const evPasses = evUsd >= minEvUsd;
  const holdPasses = breakEvenHoldDays <= maxBreakEvenHoldDays;
  const approved = evPasses && holdPasses;
  const reason = approved
    ? `Net EV $${evUsd.toFixed(4)} over ${horizon.toFixed(1)}d, ` +
      `breaks even in ${breakEvenHoldDays.toFixed(2)}d ` +
      `(fees $${expectedFeesUsd.toFixed(4)} − IL $${expectedIlUsd.toFixed(4)} − cost $${costUsd.toFixed(4)})`
    : !evPasses
      ? `Net EV $${evUsd.toFixed(4)} over ${horizon.toFixed(1)}d does not clear $${minEvUsd.toFixed(2)} ` +
        `(fees $${expectedFeesUsd.toFixed(4)} − IL $${expectedIlUsd.toFixed(4)} − cost $${costUsd.toFixed(4)}); ` +
        `break-even size $${minSize.toFixed(2)}, this size $${size.toFixed(2)}`
      : `Break-even hold ${breakEvenHoldDays.toFixed(2)}d > ${maxBreakEvenHoldDays}d at $${size.toFixed(2)} ` +
        `(fees $${dailyFees.toFixed(4)}/day vs round-trip cost $${costUsd.toFixed(4)}) — ` +
        `break-even size $${minSize.toFixed(2)}`;
  return {
    expectedFeesUsd,
    expectedIlUsd,
    costUsd,
    evUsd,
    minViableSizeUsd: minSize,
    breakEvenHoldDays,
    approved,
    reason,
  };
}

export interface RebalanceEconomicsInput {
  readonly positionValueUsd: number;
  /** Extra daily fee yield (percent of position value) recovered by re-ranging. */
  readonly recoveredYieldPerDayPct: number;
  readonly horizonDays: number;
  readonly costUsd: number;
  readonly minEvUsd?: number;
}

export interface RebalanceEconomics {
  readonly expectedBenefitUsd: number;
  readonly costUsd: number;
  readonly evUsd: number;
  readonly approved: boolean;
  readonly reason: string;
}

/**
 * Evaluate whether a rebalance pays for itself: the fee yield recovered by
 * moving back into range over the horizon must exceed the rebalance cost.
 */
export function evaluateRebalanceEconomics(input: RebalanceEconomicsInput): RebalanceEconomics {
  const value = Math.max(0, finiteOrZero(input.positionValueUsd));
  const horizon = Math.max(0, finiteOrZero(input.horizonDays));
  const costUsd = Math.max(0, finiteOrZero(input.costUsd));
  const minEvUsd = input.minEvUsd ?? DEFAULT_MIN_EV_USD;
  const expectedBenefitUsd = value * (finiteOrZero(input.recoveredYieldPerDayPct) / 100) * horizon;
  const evUsd = expectedBenefitUsd - costUsd;
  const approved = Number.isFinite(evUsd) && evUsd >= minEvUsd;
  return {
    expectedBenefitUsd,
    costUsd,
    evUsd,
    approved,
    reason: approved
      ? `Rebalance EV $${evUsd.toFixed(4)} (recovered yield $${expectedBenefitUsd.toFixed(4)} − cost $${costUsd.toFixed(4)})`
      : `Rebalance EV $${evUsd.toFixed(4)} does not clear $${minEvUsd.toFixed(2)} ` +
        `(recovered yield $${expectedBenefitUsd.toFixed(4)} − cost $${costUsd.toFixed(4)})`,
  };
}

/**
 * Convenience wrapper for an entry whose cost comes from the cost model, so a
 * caller cannot accidentally pass a stale gas constant. `swaps` defaults to one
 * leg on entry and one on exit.
 */
export function evaluateEntryWithCostModel(
  input: Omit<EntryEconomicsInput, "roundTripCostUsd">,
  model: CostModelConfig,
): EntryEconomics {
  const cost = estimateRoundTripCostUsd(input.positionSizeUsd, model);
  return evaluateEntryEconomics({
    ...input,
    roundTripCostUsd: cost.totalUsd,
  });
}

export interface SplitRoundTripCost {
  readonly enterUsd: number;
  readonly exitUsd: number;
}

/** Split a round-trip cost into its entry and exit halves (for reporting). */
export function splitRoundTripCostUsd(sizeUsd: number, model: CostModelConfig): SplitRoundTripCost {
  return {
    enterUsd: estimateEnterCostUsd(sizeUsd, model).totalUsd,
    exitUsd: estimateExitCostUsd(sizeUsd, model).totalUsd,
  };
}

function clampConcentration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(Math.max(value, 1), MAX_CONCENTRATION_FACTOR);
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
