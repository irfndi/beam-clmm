/**
 * Snapshot-replay decision evaluator — mirrors the LIVE decision chain in
 * engine/program.ts `evaluatePool` so a backtest decision equals what the
 * engine would decide on the same snapshot data.
 *
 * Parity scope (mirrors program.ts exactly):
 *   - EXIT chain, in live order: challenge-rotation drawdown (Krystal 24h
 *     drawdown), dust cleanup, TVL-drop, volume-authenticity, Fee/IL < 0.5,
 *     the hard stop-loss (entry-based, in-range), and the trailing stop
 *     (with the #153 consecutive-cycle confirm debounce).
 *   - HOLD: live per-position confidence (fee/IL > minFeeIlRatio + no recent
 *     warnings → min(0.6 + feeIlRatio·0.05, 0.9); otherwise the pool-default
 *     HOLD at confidence 0.5).
 *   - ENTER mega-gate, in live order: the shared quality floors from
 *     engine/entry-gates.ts ([fee-il-gate], [fee-gas-gate], ×1.5 candidate
 *     conditions — fee/IL, volume authenticity, bin utilization, TVL), then the
 *     challenge score/age/hard-floor/loss-cooldown gates, then the shared
 *     weighted-score + allocation tail (incl. the challenge pool-share cap),
 *     then ENTER with the live confidence min(0.5 + feeIlRatio·0.05, 0.85)
 *     sized by the allocation headroom. The quality floors, the score and the
 *     allocation are the SAME functions the live branch runs, so a replay
 *     decision and a live decision can only differ where this file says so.
 *   - Confidence formulas and `evaluateRisk` overlay are the live ones.
 *
 * Remaining delta (live branches NOT replayed — see program.ts):
 *   - IL-dominance EXIT: needs on-chain entry legs + out-of-range timestamps
 *     absent from snapshots.
 *   - Fallen-angel lifecycle (EXIT + ENTER): config off by default.
 *   - W15 fast EXIT (stablecoin depeg / liquidity drain): needs per-pool
 *     snapshot-history signal detection.
 *   - Wallet-read / wallet-refresh / entry-backoff / DB pool-cooldown gates:
 *     live session state absent in replay; replay treats every pool as
 *     approved and paper (all gates pass).
 *   - Jupiter token-risk ENTER consult: network overlay, fail-open in replay.
 *   - Challenge pool-score/age candidate conjuncts: replayed from the
 *     snapshot's reconstructed PoolState and explicit pool-age input.
 *   - Threshold/weight evolution: replay uses the config defaults, not
 *     DB-evolved values.
 *   - TVL-velocity/volume/fee gates act on the snapshot's metrics exactly as
 *     the live pool metrics; challenge rotation uses `drawdown24hPct` input
 *     (snapshots do not persist Krystal drawdown).
 */
import { evaluateRisk, type RiskConfig } from "../risk-service.js";
import { evaluateEntryGates, qualityGateViolation, type EntryGateInput } from "../entry-gates.js";
import { challengePoolScore, challengeRotationSignal } from "../challenge-strategy.js";
import type { AgentDecision, PoolMetrics, Position, SignalWeights } from "../types.js";
import type { RiskContext } from "../services.js";

export interface ReplayPosition {
  readonly positionPubKey: string;
  readonly poolAddress: string;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly highestValueUsd: number;
}

export interface ReplayEvaluationInput {
  readonly poolAddress: string;
  readonly activeBinId: number;
  readonly metrics: PoolMetrics;
  readonly position: ReplayPosition | undefined;
  readonly openPositions: readonly ReplayPosition[];
  readonly portfolioValueUsd: number;
  readonly recentPnlUsd: number;
  readonly memoryWarningCount: number;
  readonly confidenceThreshold: number;
  readonly trailingStopPct: number;
  readonly risk: RiskConfig;
  readonly proposedSizeUsd: number;

  // ── Live-chain parity knobs (values = the live engine's config) ─────────
  /** Pool TVL (USD) — mirrors the enriched `pool.tvlUsd` the live gates read. */
  readonly poolTvlUsd: number;
  /** Live TRAILING_STOP_CONFIRM_CYCLES (#153 consecutive-breach debounce). */
  readonly trailingStopConfirmCycles: number;
  /** Live MIN_FEE_IL_RATIO (evolvedThresholds base). */
  readonly minFeeIlRatio: number;
  /** Live ENTER_ROUND_TRIP_GAS_USD — [fee-gas-gate] round-trip gas cost. */
  readonly enterRoundTripGasUsd?: number;
  /** Live ENTER_MIN_7D_FEE_OVER_GAS — [fee-gas-gate] 7d-fees/gas multiple. */
  readonly enterMin7dFeeOverGas?: number;
  /** Live VOLUME_AUTH_THRESHOLD (evolvedThresholds base). */
  readonly volumeAuthThreshold: number;
  /** Live MIN_BIN_UTILIZATION (evolvedThresholds base). */
  readonly minBinUtilization: number;
  /** Live MIN_POOL_TVL_USD. */
  readonly minPoolTvlUsd: number;
  /** Live WEIGHTED_ENTRY_SCORE_THRESHOLD. */
  readonly weightedEntryScoreThreshold: number;
  /** Live IL_PROTECTION_ENABLED — arms the [fee-il-gate] ENTER floor. */
  readonly ilProtectionEnabled: boolean;
  /** Live DUST_EXIT_USD (0 disables the dust EXIT). */
  readonly dustExitUsd: number;
  /** Live TVL_DROP_EXIT_PCT — capital-protection EXIT when velocity < -pct. */
  readonly tvlDropExitPct: number;
  /** Live MAX_OPEN_POSITIONS — portfolio-wide cap for the allocation gate. */
  readonly maxOpenPositions: number;
  /** SignalWeights for weightedEntryScore; defaults to the live defaults. */
  readonly signalWeights?: SignalWeights;
  /** Consecutive prior cycles the trailing stop was breached (loop state). */
  readonly trailingStopBreaches: number;
  /** Consecutive prior cycles the hard stop-loss was breached (loop state). */
  readonly stopLossBreaches: number;

  // ── Challenge-mode parity (all inert unless challengeMode === true) ─────
  readonly challengeMode?: boolean;
  /** Krystal 24h drawdown % (negative) — challenge-rotation EXIT signal. */
  readonly drawdown24hPct?: number;
  /** Rolling 7d avg fee yield % — challenge-rotation yield-decay signal. */
  readonly avgYieldPerDayPct?: number;
  /** Live CHALLENGE_DRAWDOWN_EXIT_PCT (default 5). */
  readonly challengeDrawdownExitPct?: number;
  /** All-time peak equity — hard-floor denominator (live: challengePeakEquityUsd). */
  readonly challengePeakEquityUsd?: number;
  /** Live CHALLENGE_HARD_FLOOR_PCT (default 50). */
  readonly challengeHardFloorPct?: number;
  /** Per-pool loss-cooldown deadline (ms epoch) — bars re-entry while active. */
  readonly lossCooldownUntilMs?: number;
  /** Evaluation clock for deterministic replay; live callers may omit it. */
  readonly nowMs?: number;
  /** Live CHALLENGE_MIN_SCORE; defaults to the live config default (4). */
  readonly challengeMinScore?: number;
  /** Live CHALLENGE_MIN_POOL_AGE_MS; defaults to six hours. */
  readonly challengeMinPoolAgeMs?: number;
  /** Reconstructed pool age at this snapshot, in milliseconds. */
  readonly poolAgeMs?: number;
  /** Live CHALLENGE_POOL_SHARE_CAP_PCT — caps per-pool exposure at % of TVL. */
  readonly challengePoolShareCapPct?: number;
}

export interface ReplayEvaluation {
  readonly decision: AgentDecision;
  readonly riskApproved: boolean;
  readonly riskReason: string;
  readonly adjustedSizeUsd: number;
  /** New consecutive-trailing-breach count — the caller carries it forward. */
  readonly trailingStopBreachCount: number;
  /** New consecutive-stop-loss-breach count — the caller carries it forward. */
  readonly stopLossBreachCount: number;
}

const toRiskPosition = (position: ReplayPosition): Position => ({
  id: position.positionPubKey,
  poolAddress: position.poolAddress,
  poolName: position.poolAddress,
  lowerBinId: position.lowerBinId,
  upperBinId: position.upperBinId,
  liquidityShares: 0n,
  depositedUsd: position.depositedUsd,
  currentValueUsd: position.currentValueUsd,
  unrealizedPnlUsd: position.currentValueUsd - position.depositedUsd,
  feesEarnedUsd: 0,
  openedAt: 0,
});

// Live DEFAULT_SIGNAL_WEIGHTS (program.ts) — replay does not evolve weights.
const DEFAULT_SIGNAL_WEIGHTS: SignalWeights = {
  feeIlRatio: 1.0,
  volumeAuthenticity: 1.0,
  binUtilization: 1.0,
  tvlUsd: 1.0,
  tvlVelocity: 1.0,
  updatedAt: 0,
};

interface ReplayTrailingExit {
  readonly decision: AgentDecision | null;
  readonly trailingBreaches: number;
  readonly stopLossBreaches: number;
}

function replayExitWithTrailing(
  input: ReplayEvaluationInput,
  poolAddress: string,
  trailingBreaches: number,
  stopLossBreaches: number,
): ReplayTrailingExit {
  const position = input.position;
  if (!position) return { decision: null, trailingBreaches, stopLossBreaches };
  let tB = trailingBreaches;
  let sB = stopLossBreaches;

  // Hard stop-loss
  if (position.depositedUsd > 0) {
    const lossPct = (position.currentValueUsd - position.depositedUsd) / position.depositedUsd;
    const breached = lossPct < -input.risk.stopLossPct;
    sB = breached ? input.stopLossBreaches + 1 : 0;
    if (breached && sB >= input.trailingStopConfirmCycles) {
      return {
        decision: {
          action: "EXIT",
          poolAddress,
          confidence: 1,
          reasoning: `Stop-loss: position loss ${(Math.abs(lossPct) * 100).toFixed(1)}% exceeds ${(input.risk.stopLossPct * 100).toFixed(0)}% (${sB}/${input.trailingStopConfirmCycles} cycles) — capital protection exit`,
        },
        trailingBreaches: tB,
        stopLossBreaches: sB,
      };
    }
  }
  // Trailing exit
  {
    const estimatedValue = position.currentValueUsd;
    const highest = position.highestValueUsd;
    const drawdown = highest > 0 ? (highest - estimatedValue) / highest : 0;
    const breached = drawdown > input.trailingStopPct;
    tB = breached ? input.trailingStopBreaches + 1 : 0;
    if (breached && tB >= input.trailingStopConfirmCycles) {
      return {
        decision: {
          action: "EXIT",
          poolAddress,
          confidence: 0.8,
          reasoning: `Trailing stop: value dropped ${(drawdown * 100).toFixed(1)}% from peak $${highest.toFixed(2)} (${tB}/${input.trailingStopConfirmCycles} cycles)`,
        },
        trailingBreaches: tB,
        stopLossBreaches: sB,
      };
    }
  }
  return { decision: null, trailingBreaches: tB, stopLossBreaches: sB };
}

function replayChallengeExit(
  input: ReplayEvaluationInput,
  poolAddress: string,
  metrics: PoolMetrics,
): AgentDecision | null {
  if (input.challengeMode !== true || !input.position) return null;
  const drawdown = input.drawdown24hPct ?? metrics.pool.drawdown24h ?? 0;
  if (drawdown >= 0) return null;
  const rotation = challengeRotationSignal(
    { ...metrics.pool, drawdown24h: drawdown },
    input.avgYieldPerDayPct ?? null,
    input.challengeDrawdownExitPct ?? 5,
  );
  if (rotation.action === "hold") return null;
  return {
    action: "EXIT",
    poolAddress,
    confidence: rotation.action === "exit" ? 0.95 : 0.85,
    reasoning: `[challenge-rotation] ${rotation.reason}`,
  };
}
function replayGateExit(
  input: ReplayEvaluationInput,
  metrics: PoolMetrics,
  poolAddress: string,
): AgentDecision | null {
  const position = input.position;
  if (!position) return null;
  if (input.dustExitUsd > 0 && position.currentValueUsd < input.dustExitUsd) {
    return {
      action: "EXIT",
      poolAddress,
      confidence: 1,
      reasoning: `[dust-cleanup] Position value $${position.currentValueUsd.toFixed(2)} below $${input.dustExitUsd.toFixed(2)} dust threshold — reclaiming slot`,
    };
  }
  if (metrics.tvlVelocity < -input.tvlDropExitPct) {
    // Feed-outage parity with live: a zero-activity read is a dead feed, not a
    // flight — HOLD. (Live additionally checks symbol flips and TVL collapse
    // against the previous snapshot; replay metrics carry no previous row, so
    // the zero-volume/zero-fees shape is the portable signal.)
    const feedDead =
      metrics.pool.volume24hUsd <= 0 && metrics.pool.fees24hUsd <= 0 && metrics.tvlVelocity < 0;
    if (!feedDead) {
      return {
        action: "EXIT",
        poolAddress,
        confidence: 0.85,
        reasoning: `TVL dropped ${(Math.abs(metrics.tvlVelocity) * 100).toFixed(1)}% — capital protection exit`,
      };
    }
  }
  if (metrics.volumeAuthenticityKnown && metrics.volumeAuthenticity < input.volumeAuthThreshold) {
    return {
      action: "EXIT",
      poolAddress,
      confidence: 0.8,
      reasoning: `Volume authenticity ${metrics.volumeAuthenticity.toFixed(2)} below threshold`,
    };
  }
  if (metrics.feeIlRatioKnown && metrics.feeIlRatio < 0.5) {
    return {
      action: "EXIT",
      poolAddress,
      confidence: 0.75,
      reasoning: `Fee/IL ratio ${metrics.feeIlRatio.toFixed(2)} below 0.5`,
    };
  }
  return null;
}
function replayHoldDecision(
  input: ReplayEvaluationInput,
  feeIlRatio: number,
  poolAddress: string,
): AgentDecision {
  const healthy = feeIlRatio > input.minFeeIlRatio && input.memoryWarningCount === 0;
  return {
    action: "HOLD",
    poolAddress,
    confidence: healthy ? Math.min(0.6 + feeIlRatio * 0.05, 0.9) : 0.5,
    reasoning: healthy
      ? `Fee/IL ${feeIlRatio.toFixed(2)} above threshold. Holding.`
      : `No strong signal. Fee/IL: ${feeIlRatio.toFixed(2)}`,
  };
}
/**
 * The shared gate input (engine/entry-gates.ts) built from the replay's parity
 * knobs: the same config subset the live engine reads, the snapshot metrics,
 * and the replay's own sizing rule. The allocation cap counts exactly what this
 * branch can see (the replay's open book).
 */
export function replayEntryGateInput(input: ReplayEvaluationInput): EntryGateInput {
  const poolPositions = input.openPositions.filter((p) => p.poolAddress === input.poolAddress);
  return {
    config: {
      minPoolTvlUsd: input.minPoolTvlUsd,
      minFeeIlRatio: input.minFeeIlRatio,
      weightedEntryScoreThreshold: input.weightedEntryScoreThreshold,
      maxPerPoolAllocationPct: input.risk.maxPerPoolAllocationPct,
      maxOpenPositions: input.maxOpenPositions,
      maxPositionsPerPool: input.risk.maxPositionsPerPool,
      ilProtectionEnabled: input.ilProtectionEnabled,
      ...(input.enterRoundTripGasUsd !== undefined && {
        enterRoundTripGasUsd: input.enterRoundTripGasUsd,
      }),
      ...(input.enterMin7dFeeOverGas !== undefined && {
        enterMin7dFeeOverGas: input.enterMin7dFeeOverGas,
      }),
      ...(input.challengePoolShareCapPct !== undefined && {
        challengePoolShareCapPct: input.challengePoolShareCapPct,
      }),
    },
    poolAddress: input.poolAddress,
    poolTvlUsd: input.poolTvlUsd,
    poolFees24hUsd: input.metrics.pool.fees24hUsd,
    metrics: input.metrics,
    proposedSizeUsd: input.proposedSizeUsd,
    feeIlRatio: input.metrics.feeIlRatio,
    volumeAuth: input.metrics.volumeAuthenticity,
    binUtilization: input.metrics.binUtilization,
    signalWeights: input.signalWeights ?? DEFAULT_SIGNAL_WEIGHTS,
    minFeeIlRatio: input.minFeeIlRatio,
    volumeAuthThreshold: input.volumeAuthThreshold,
    portfolioValueUsd: input.portfolioValueUsd,
    openPositions: input.openPositions.map(toRiskPosition),
    ownBookOpenPositions: input.openPositions.length,
    ownBookPoolPositions: poolPositions.length,
  };
}
function replayChallengeScoreGate(
  input: ReplayEvaluationInput,
  challengeScore: number,
): string | null {
  if (input.challengeMode !== true) return null;
  if (
    !Number.isFinite(challengeScore) ||
    !Number.isFinite(input.challengeMinScore ?? 4) ||
    challengeScore < (input.challengeMinScore ?? 4)
  ) {
    return `[challenge-score-gate] score ${Number.isFinite(challengeScore) ? challengeScore.toFixed(3) : "unavailable"} < minimum ${input.challengeMinScore ?? 4}`;
  }
  return null;
}
function replayChallengeAgeGate(input: ReplayEvaluationInput): string | null {
  if (input.challengeMode !== true) return null;
  if (
    input.poolAgeMs === undefined ||
    !Number.isFinite(input.poolAgeMs) ||
    input.poolAgeMs < (input.challengeMinPoolAgeMs ?? 6 * 3_600_000)
  ) {
    return `[challenge-age-gate] reconstructed pool age ${input.poolAgeMs === undefined ? "unavailable" : `${input.poolAgeMs}ms`} < minimum ${input.challengeMinPoolAgeMs ?? 6 * 3_600_000}ms`;
  }
  return null;
}
function replayChallengeHardFloorGate(input: ReplayEvaluationInput): string | null {
  if (input.challengeMode !== true) return null;
  if ((input.challengePeakEquityUsd ?? 0) <= 0) return null;
  if (
    input.portfolioValueUsd <
    (input.challengePeakEquityUsd ?? 0) * ((input.challengeHardFloorPct ?? 50) / 100)
  ) {
    return (
      `[hard-floor] portfolio $${input.portfolioValueUsd.toFixed(0)} below ` +
      `${input.challengeHardFloorPct ?? 50}% of peak equity $${(input.challengePeakEquityUsd ?? 0).toFixed(0)}`
    );
  }
  return null;
}
function replayLossCooldownGate(input: ReplayEvaluationInput): string | null {
  if (input.challengeMode !== true) return null;
  if ((input.lossCooldownUntilMs ?? 0) <= 0) return null;
  if ((input.nowMs ?? Date.now()) >= (input.lossCooldownUntilMs ?? 0)) return null;
  return "[loss-cooldown] pool recently realized a loss — re-entry barred";
}
/**
 * The challenge gates this branch models on top of the shared stack, evaluated
 * between the quality floors and the weighted score exactly as the live ENTER
 * branch orders them.
 */
function replayChallengeEnterGates(
  input: ReplayEvaluationInput,
  challengeScore: number,
): string | null {
  return (
    replayChallengeScoreGate(input, challengeScore) ??
    replayChallengeAgeGate(input) ??
    replayChallengeHardFloorGate(input) ??
    replayLossCooldownGate(input)
  );
}
function replayRiskTail(
  input: ReplayEvaluationInput,
  poolAddress: string,
  finalDecision: AgentDecision,
  trailingBreaches: number,
  stopLossBreaches: number,
): ReplayEvaluation {
  const openPositions = input.openPositions.map(toRiskPosition);
  const context: RiskContext = {
    openPositions,
    portfolioValueUsd: input.portfolioValueUsd,
    recentPnlUsd: input.recentPnlUsd,
    poolAddress,
    activeBinId: input.activeBinId,
  };
  const riskResult = evaluateRisk(input.risk, finalDecision, context);
  return {
    decision: finalDecision,
    riskApproved: riskResult.approved,
    riskReason: riskResult.reason,
    adjustedSizeUsd:
      riskResult.adjustedSizeUsd ??
      (finalDecision.action === "ENTER" && finalDecision.positionSizeUsd !== undefined
        ? finalDecision.positionSizeUsd
        : 0),
    trailingStopBreachCount: trailingBreaches,
    stopLossBreachCount: stopLossBreaches,
  };
}
export function evaluateReplayPool(input: ReplayEvaluationInput): ReplayEvaluation {
  const { position, poolAddress, metrics } = input;
  const feeIlRatio = metrics.feeIlRatio;
  const volumeAuth = metrics.volumeAuthenticity;
  const challengeScore = input.challengeMode === true ? challengePoolScore(metrics.pool).score : 0;
  let decision: AgentDecision | null = null;
  // #153 debounce: the count only advances inside the trailing-stop block
  // (live tracks per-position breach state in evaluatePool, pre-risk-tail).
  let trailingBreaches = 0;
  let stopLossBreaches = 0;

  decision =
    replayChallengeExit(input, poolAddress, metrics) ??
    replayGateExit(input, metrics, poolAddress) ??
    null;
  if (!decision) {
    const stopTrail = replayExitWithTrailing(
      input,
      poolAddress,
      trailingBreaches,
      stopLossBreaches,
    );
    if (stopTrail.decision) decision = stopTrail.decision;
    trailingBreaches = stopTrail.trailingBreaches;
    stopLossBreaches = stopTrail.stopLossBreaches;
  }

  // ── Phase 2: HOLD for a surviving position ────────────────────────────────
  if (!decision && position) decision = replayHoldDecision(input, feeIlRatio, poolAddress);

  // ── ENTER mega-gate (one slot per pool per cycle) ─────────────────────────
  if (!decision && !position) {
    const gate = replayEntryGateInput(input);
    // Live order: quality floors → challenge gates → weighted score →
    // allocation. The quality floors are re-evaluated inside
    // `evaluateEntryGates`; they are pure, so interleaving the challenge gates
    // only decides which reason a rejected ENTER reports.
    const quality = qualityGateViolation(gate);
    const challenge = quality === null ? replayChallengeEnterGates(input, challengeScore) : null;
    const rejection = quality !== null ? quality.reason : challenge;
    if (rejection !== null) {
      decision = {
        action: "HOLD",
        poolAddress,
        confidence: 0,
        reasoning: `[enter-gate] ${rejection}`,
      };
    } else {
      const verdict = evaluateEntryGates(gate);
      if (verdict.approved) {
        decision = {
          action: "ENTER",
          poolAddress,
          confidence: Math.min(0.5 + feeIlRatio * 0.05, 0.85),
          reasoning: `Strong pool: Fee/IL ${feeIlRatio.toFixed(2)}, auth ${volumeAuth.toFixed(2)}, TVL $${input.poolTvlUsd.toFixed(0)}`,
          positionSizeUsd: verdict.positionSizeUsd,
        };
      } else {
        decision = {
          action: "HOLD",
          poolAddress,
          confidence: 0,
          reasoning: `[enter-gate] ${verdict.reason}`,
        };
      }
    }
  }

  // Every path above assigns `decision` (a held position always resolves to an
  // EXIT or HOLD; an empty slot always resolves to ENTER or the gate HOLD).
  // This fallback is defensive for the typechecker — it never fires.
  const finalDecision: AgentDecision = decision ?? {
    action: "HOLD",
    poolAddress,
    confidence: 0,
    reasoning: "[enter-gate] ENTER slot skipped",
  };

  return replayRiskTail(input, poolAddress, finalDecision, trailingBreaches, stopLossBreaches);
}
