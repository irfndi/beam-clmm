/**
 * entry-gates.ts — the ENTER gate stack as pure predicates.
 *
 * The gates used to live inline in `program.ts`'s ENTER branch, so a second
 * caller (the rule core under `DECISION_ENGINE=rules`, and the snapshot replay
 * in engine/cycle/evaluate-pool.ts) had no way to dispatch an entry without
 * re-implementing them. This module holds the deterministic part of that stack —
 * the quality floors, the weighted score and the allocation cap — and every
 * caller runs the SAME functions, so the paths cannot drift.
 *
 * Order matters and mirrors the live branch:
 *   fee/IL floor → round-trip gas floor → measured candidate conditions →
 *   weighted score → allocation cap.
 *
 * The deposit is an INPUT (`proposedSizeUsd`): sizing policy lives in
 * entry-sizing.ts and stays with the caller — the live branch sizes off equity
 * and TVL through `entrySizeFromConfig`, the backtest through its own rule.
 *
 * Deliberately NOT here (I/O, and the live branch owns their side effects):
 * fee persistence, exit-route proof, token-risk consultation, pool cooldown,
 * wallet reads. A caller that wants "the whole gate" must run those too; the
 * rule-core entry planner refuses challenge mode for exactly that reason.
 */

import type { AppConfig } from "./config-service.js";
import { computeEntrySizeUsd } from "./entry-sizing.js";
import { evaluatePerPoolAllocation } from "./risk-service.js";
import { weightedEntryScore } from "./strategy-service.js";
import type { PoolMetrics, Position, SignalWeights } from "./types.js";

/**
 * The config fields the gates actually read — a structural subset of
 * `AppConfig`. The live engine passes its config straight through; a replay
 * caller that only has its own parity knobs can build one without inventing a
 * full config.
 */
export interface EntryGateConfig {
  readonly minPoolTvlUsd: number;
  readonly minFeeIlRatio: number;
  readonly weightedEntryScoreThreshold: number;
  readonly maxPerPoolAllocationPct: number;
  readonly maxOpenPositions: number;
  readonly maxPositionsPerPool: number;
  readonly ilProtectionEnabled?: boolean;
  readonly enterRoundTripGasUsd?: number;
  readonly enterMin7dFeeOverGas?: number;
  readonly challengePoolShareCapPct?: number;
}

export interface EntryGateInput {
  readonly config: EntryGateConfig;
  readonly poolAddress: string;
  readonly poolTvlUsd: number;
  readonly poolFees24hUsd: number | null | undefined;
  readonly metrics: PoolMetrics;
  /** Deposit BEFORE the allocation cap — the caller's sizing rule (see
   *  `entrySizeFromConfig` for the live one). */
  readonly proposedSizeUsd: number;
  /** Measured fee/IL ratio (strategy-service); 0..20, never null. */
  readonly feeIlRatio: number;
  readonly volumeAuth: number;
  readonly binUtilization: number;
  readonly signalWeights: SignalWeights;
  /** Evolved (per-pool) thresholds, not the raw config values. */
  readonly minFeeIlRatio: number;
  readonly volumeAuthThreshold: number;
  readonly portfolioValueUsd: number;
  readonly openPositions: ReadonlyArray<Position>;
  /** Own-book counts for the position-count caps (see ownBookPositionCounts). */
  readonly ownBookOpenPositions: number;
  readonly ownBookPoolPositions: number;
}

export type EntryGateCode =
  | "ok"
  | "fee-il-floor"
  | "fee-gas-floor"
  | "fee-il-edge"
  | "volume-unknown"
  | "volume-authenticity"
  | "bin-utilization"
  | "tvl-floor"
  | "weighted-score"
  | "allocation";

export interface EntryGateVerdict {
  readonly approved: boolean;
  readonly code: EntryGateCode;
  /** Machine-tagged reason, safe for audit rows and logs. */
  readonly reason: string;
  readonly entryScore: number;
  /** Allocation-capped deposit; 0 when not approved. */
  readonly positionSizeUsd: number;
}

export interface EntrySizeContext {
  readonly walletBalanceUsd: number;
  readonly portfolioValueUsd: number;
  readonly poolTvlUsd: number;
}

/**
 * The live sizing rule (equity share bounded by TVL share, cap and floor),
 * lifted out of the gate input so callers size the deposit themselves and the
 * gates only judge it.
 */
export function entrySizeFromConfig(config: AppConfig, ctx: EntrySizeContext): number {
  return computeEntrySizeUsd({
    walletBalanceUsd: ctx.walletBalanceUsd,
    portfolioValueUsd: ctx.portfolioValueUsd,
    equityFractionUsd: config.entrySizeEquityFraction,
    tvlUsd: ctx.poolTvlUsd,
    maxSizeUsd: config.maxEntrySizeUsd,
    tvlFractionUsd: config.entrySizeTvlFraction,
    floorUsd: config.entrySizeFloorUsd,
  });
}

/**
 * `[fee-il-gate]` hard floor: expected fees must beat IL. Skipped entirely when
 * IL protection is off or the ratio is modeled (a modeled number gets no vote).
 */
export function feeIlFloorViolation(input: EntryGateInput): string | null {
  if (input.config.ilProtectionEnabled !== true) return null;
  if (!input.metrics.feeIlRatioKnown) return null;
  if (input.feeIlRatio >= input.config.minFeeIlRatio) return null;
  return `[fee-il-gate] Fee/IL ${input.feeIlRatio.toFixed(2)} < ${input.config.minFeeIlRatio}`;
}

/**
 * `[fee-gas-gate]` round-trip gas floor: a position must expect to earn its own
 * gas within a week of measured 24h fees. A pool with no measured fees is
 * skipped, not blocked.
 */
export function feeGasFloorViolation(
  input: EntryGateInput,
): { readonly expected7dFeesUsd: number; readonly gasCostUsd: number } | null {
  const fees24hUsd = input.poolFees24hUsd ?? 0;
  if (fees24hUsd <= 0 || input.poolTvlUsd <= 0) return null;
  if ((input.config.enterRoundTripGasUsd ?? 0) <= 0) return null;
  const expected7dFeesUsd = fees24hUsd * (input.proposedSizeUsd / input.poolTvlUsd) * 7;
  const gasCostUsd =
    (input.config.enterRoundTripGasUsd ?? 0) * (input.config.enterMin7dFeeOverGas ?? 1);
  return expected7dFeesUsd < gasCostUsd ? { expected7dFeesUsd, gasCostUsd } : null;
}

/**
 * The measured candidate conditions (the "×1.5" band). Modeled fee/IL is
 * excluded in either direction: the fee conjunct is skipped when the ratio is
 * unknown, while real volume and on-chain bin utilization are still required.
 */
export function baseCandidateViolation(input: EntryGateInput): EntryGateCode | null {
  if (input.metrics.feeIlRatioKnown && input.feeIlRatio <= input.minFeeIlRatio * 1.5) {
    return "fee-il-edge";
  }
  if (!input.metrics.volumeAuthenticityKnown) return "volume-unknown";
  const volumeBar = input.metrics.feeIlRatioKnown ? 0.8 : input.volumeAuthThreshold;
  if (input.volumeAuth < volumeBar) return "volume-authenticity";
  if (!input.metrics.binUtilizationKnown) return "bin-utilization";
  if (input.binUtilization <= 0.4) return "bin-utilization";
  if (input.poolTvlUsd <= input.config.minPoolTvlUsd * 2) return "tvl-floor";
  return null;
}

function baseCandidateReason(input: EntryGateInput, code: EntryGateCode): string {
  switch (code) {
    case "fee-il-edge":
      return `[fee-il-edge] Fee/IL ${input.feeIlRatio.toFixed(2)} <= ${(input.minFeeIlRatio * 1.5).toFixed(2)} (1.5× candidate floor)`;
    case "volume-unknown":
      return "[volume] volume authenticity unknown — measured volume required";
    case "volume-authenticity":
      return `[volume] authenticity ${input.volumeAuth.toFixed(2)} below ${
        input.metrics.feeIlRatioKnown ? "0.80" : input.volumeAuthThreshold.toFixed(2)
      }`;
    case "bin-utilization":
      return input.metrics.binUtilizationKnown
        ? `[bin-utilization] ${input.binUtilization.toFixed(2)} <= 0.40`
        : "[bin-utilization] unknown — on-chain utilization required";
    case "tvl-floor":
      return `[tvl] $${input.poolTvlUsd.toFixed(0)} <= 2× minimum $${(
        input.config.minPoolTvlUsd * 2
      ).toFixed(0)}`;
    default:
      return `[candidate] ${code}`;
  }
}

const deniedGate = (code: EntryGateCode, reason: string): EntryGateVerdict => ({
  approved: false,
  code,
  reason,
  entryScore: 0,
  positionSizeUsd: 0,
});

/**
 * The quality floors alone — fee/IL floor, round-trip gas floor, measured
 * candidate conditions — in live order. The snapshot replay runs these, then
 * its own challenge gates, then the tail (`evaluateEntryGates` minus this), so
 * the reported reason stays in the live order.
 */
export function qualityGateViolation(input: EntryGateInput): EntryGateVerdict | null {
  const feeIl = feeIlFloorViolation(input);
  if (feeIl !== null) return deniedGate("fee-il-floor", feeIl);

  const gas = feeGasFloorViolation(input);
  if (gas !== null) {
    return deniedGate(
      "fee-gas-floor",
      `[fee-gas-gate] 7d fees $${gas.expected7dFeesUsd.toFixed(3)} < gas $${gas.gasCostUsd.toFixed(3)}`,
    );
  }

  const base = baseCandidateViolation(input);
  if (base !== null) return deniedGate(base, baseCandidateReason(input, base));

  return null;
}

/**
 * Full deterministic ENTER gate. Returns `approved: false` with the first
 * violated gate, in the live branch's order, plus the capped deposit when it
 * passes. Callers still own the I/O gates (token risk, cooldown, proofs).
 */
export function evaluateEntryGates(input: EntryGateInput): EntryGateVerdict {
  const quality = qualityGateViolation(input);
  if (quality !== null) return quality;

  const entryScore = weightedEntryScore(input.metrics, input.signalWeights);
  if (entryScore <= input.config.weightedEntryScoreThreshold) {
    return deniedGate(
      "weighted-score",
      `[weighted-score] ${entryScore.toFixed(3)} <= ${input.config.weightedEntryScoreThreshold}`,
    );
  }

  const challengeCap = input.config.challengePoolShareCapPct;
  const allocation = evaluatePerPoolAllocation({
    proposedDepositUsd: input.proposedSizeUsd,
    portfolioValueUsd: input.portfolioValueUsd,
    openPositions: input.openPositions,
    maxPerPoolAllocationPct: input.config.maxPerPoolAllocationPct,
    maxOpenPositions: input.config.maxOpenPositions,
    poolAddress: input.poolAddress,
    maxPositionsPerPool: input.config.maxPositionsPerPool,
    poolTvlUsd: input.poolTvlUsd,
    countedOpenPositions: input.ownBookOpenPositions,
    countedPoolPositions: input.ownBookPoolPositions,
    ...(challengeCap !== undefined && { challengePoolShareCapPct: challengeCap }),
  });
  if (!allocation.approved) {
    return {
      approved: false,
      code: "allocation",
      reason: `[alloc-gate] ${allocation.reason}`,
      entryScore,
      positionSizeUsd: 0,
    };
  }

  return {
    approved: true,
    code: "ok",
    reason: `entry gates passed — score ${entryScore.toFixed(3)}, $${allocation.adjustedDepositUsd.toFixed(0)}`,
    entryScore,
    positionSizeUsd: allocation.adjustedDepositUsd,
  };
}
