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
 *   - ENTER mega-gate, in live order: per-pool position-cap slot, [fee-il-gate]
 *     hard floor, ×1.5 candidate conditions (fee/IL, volume authenticity,
 *     bin utilization, TVL), challenge hard floor + per-pool loss cooldown,
 *     weighted entry score, per-pool allocation cap (incl. the challenge
 *     pool-share cap), then ENTER with the live confidence
 *     min(0.5 + feeIlRatio·0.05, 0.85) sized by the allocation headroom.
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
import { evaluateRisk, evaluatePerPoolAllocation, type RiskConfig } from "../risk-service.js";
import { weightedEntryScore } from "../strategy-service.js";
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

  // ── Phase 1: EXIT evaluation ──────────────────────────────────────────────
  // Challenge drawdown gate (live first branch): Krystal-measured 24h drawdown
  // breaches exit this cycle — capital protection on meme harvest pools.
  if (input.challengeMode === true && position) {
    const drawdown = input.drawdown24hPct ?? metrics.pool.drawdown24h ?? 0;
    if (drawdown < 0) {
      const rotation = challengeRotationSignal(
        { ...metrics.pool, drawdown24h: drawdown },
        input.avgYieldPerDayPct ?? null,
        input.challengeDrawdownExitPct ?? 5,
      );
      if (rotation.action !== "hold") {
        decision = {
          action: "EXIT",
          poolAddress,
          confidence: rotation.action === "exit" ? 0.95 : 0.85,
          reasoning: `[challenge-rotation] ${rotation.reason}`,
        };
      }
    }
  }

  // Dust cleanup: dead capital below the dust threshold reclaims its slot.
  if (
    !decision &&
    position &&
    input.dustExitUsd > 0 &&
    position.currentValueUsd < input.dustExitUsd
  ) {
    decision = {
      action: "EXIT",
      poolAddress,
      confidence: 1,
      reasoning: `[dust-cleanup] Position value $${position.currentValueUsd.toFixed(2)} below $${input.dustExitUsd.toFixed(2)} dust threshold — reclaiming slot`,
    };
  }

  // TVL velocity — capital-protection EXIT on a sharp drop (per-position, as
  // live's EXIT chain runs inside the per-position loop).
  if (!decision && position && metrics.tvlVelocity < -input.tvlDropExitPct) {
    decision = {
      action: "EXIT",
      poolAddress,
      confidence: 0.85,
      reasoning: `TVL dropped ${(Math.abs(metrics.tvlVelocity) * 100).toFixed(1)}% — capital protection exit`,
    };
  }

  // Volume authenticity — fabricated/wash volume below threshold.
  if (
    !decision &&
    position &&
    metrics.volumeAuthenticityKnown &&
    volumeAuth < input.volumeAuthThreshold
  ) {
    decision = {
      action: "EXIT",
      poolAddress,
      confidence: 0.8,
      reasoning: `Volume authenticity ${volumeAuth.toFixed(2)} below threshold`,
    };
  }

  // Fee/IL ratio — fees cannot beat IL (measured ratio only).
  if (!decision && position && metrics.feeIlRatioKnown && feeIlRatio < 0.5) {
    decision = {
      action: "EXIT",
      poolAddress,
      confidence: 0.75,
      reasoning: `Fee/IL ratio ${feeIlRatio.toFixed(2)} below 0.5`,
    };
  }

  // Hard stop-loss (in-range capital floor): entry-based EXIT mirrored from
  // live — fires regardless of out-of-range state when the mark falls below
  // entry − risk.stopLossPct. Shares the trailing stop's #153 confirm-cycles
  // debounce (a single noisy snapshot read cannot churn a position out).
  if (!decision && position && position.depositedUsd > 0) {
    const lossPct = (position.currentValueUsd - position.depositedUsd) / position.depositedUsd;
    const breached = lossPct < -input.risk.stopLossPct;
    stopLossBreaches = breached ? input.stopLossBreaches + 1 : 0;
    if (breached && stopLossBreaches >= input.trailingStopConfirmCycles) {
      decision = {
        action: "EXIT",
        poolAddress,
        confidence: 1,
        reasoning: `Stop-loss: position loss ${(Math.abs(lossPct) * 100).toFixed(1)}% exceeds ${(input.risk.stopLossPct * 100).toFixed(0)}% (${stopLossBreaches}/${input.trailingStopConfirmCycles} cycles) — capital protection exit`,
      };
    }
  }

  // Trailing exit (profit protection) — the #153 confirm-cycles debounce
  // matches live: breach must persist across consecutive cycles.
  if (!decision && position) {
    const estimatedValue = position.currentValueUsd;
    const highest = position.highestValueUsd;
    const drawdown = highest > 0 ? (highest - estimatedValue) / highest : 0;
    const breached = drawdown > input.trailingStopPct;
    trailingBreaches = breached ? input.trailingStopBreaches + 1 : 0;
    if (breached && trailingBreaches >= input.trailingStopConfirmCycles) {
      decision = {
        action: "EXIT",
        poolAddress,
        confidence: 0.8,
        reasoning: `Trailing stop: value dropped ${(drawdown * 100).toFixed(1)}% from peak $${highest.toFixed(2)} (${trailingBreaches}/${input.trailingStopConfirmCycles} cycles)`,
      };
    }
  }

  // ── Phase 2: HOLD for a surviving position ────────────────────────────────
  // Live per-position HOLD (healthy fee/IL + no recent warnings) or the
  // pool-default HOLD ("No strong signal") otherwise.
  if (!decision && position) {
    const healthy = feeIlRatio > input.minFeeIlRatio && input.memoryWarningCount === 0;
    decision = {
      action: "HOLD",
      poolAddress,
      confidence: healthy ? Math.min(0.6 + feeIlRatio * 0.05, 0.9) : 0.5,
      reasoning: healthy
        ? `Fee/IL ${feeIlRatio.toFixed(2)} above threshold. Holding.`
        : `No strong signal. Fee/IL: ${feeIlRatio.toFixed(2)}`,
    };
  }

  // ── ENTER mega-gate (one slot per pool per cycle) ─────────────────────────
  if (!decision && !position) {
    const poolPositions = input.openPositions.filter((p) => p.poolAddress === poolAddress);
    let enterRejected: string | null = null;
    if (poolPositions.length >= input.risk.maxPositionsPerPool) {
      enterRejected = `Per-pool position cap reached (${poolPositions.length}/${input.risk.maxPositionsPerPool}) for pool ${poolAddress}`;
    } else if (
      input.ilProtectionEnabled === true &&
      metrics.feeIlRatioKnown &&
      feeIlRatio < input.minFeeIlRatio
    ) {
      // [fee-il-gate] hard ENTER floor — expected fees must beat IL.
      enterRejected = `[fee-il-gate] Fee/IL ratio ${feeIlRatio.toFixed(2)} below minimum ${input.minFeeIlRatio} — expected fees cannot beat IL`;
    } else if (
      (input.enterRoundTripGasUsd ?? 0) > 0 &&
      metrics.pool.fees24hUsd > 0 &&
      input.poolTvlUsd > 0 &&
      metrics.pool.fees24hUsd * (input.proposedSizeUsd / input.poolTvlUsd) * 7 <
        (input.enterRoundTripGasUsd ?? 0) * (input.enterMin7dFeeOverGas ?? 1)
    ) {
      // [fee-gas-gate] profitability floor — mirror of the live gate: a
      // position must expect to earn its own round-trip gas within a week of
      // measured fees. Measured-only: 0 fees does not vote either way.
      const expected7d = metrics.pool.fees24hUsd * (input.proposedSizeUsd / input.poolTvlUsd) * 7;
      const gasCost = (input.enterRoundTripGasUsd ?? 0) * (input.enterMin7dFeeOverGas ?? 1);
      enterRejected = `[fee-gas-gate] expected 7d fees $${expected7d.toFixed(3)} < round-trip gas $${gasCost.toFixed(3)} — entry cannot pay for itself`;
    } else if (
      !(metrics.feeIlRatioKnown ? feeIlRatio > input.minFeeIlRatio * 1.5 : true) ||
      !metrics.volumeAuthenticityKnown ||
      volumeAuth <= 0.8 ||
      !metrics.binUtilizationKnown ||
      metrics.binUtilization <= 0.4 ||
      input.poolTvlUsd <= input.minPoolTvlUsd * 2
    ) {
      // ×1.5 candidate conditions — measured-only, mirroring live.
      enterRejected = "[candidate-gate] pool failed the ×1.5 candidate conditions";
    } else if (
      input.challengeMode === true &&
      (!Number.isFinite(challengeScore) ||
        !Number.isFinite(input.challengeMinScore ?? 4) ||
        challengeScore < (input.challengeMinScore ?? 4))
    ) {
      enterRejected = `[challenge-score-gate] score ${Number.isFinite(challengeScore) ? challengeScore.toFixed(3) : "unavailable"} < minimum ${input.challengeMinScore ?? 4}`;
    } else if (
      input.challengeMode === true &&
      (input.poolAgeMs === undefined ||
        !Number.isFinite(input.poolAgeMs) ||
        input.poolAgeMs < (input.challengeMinPoolAgeMs ?? 6 * 3_600_000))
    ) {
      enterRejected = `[challenge-age-gate] reconstructed pool age ${input.poolAgeMs === undefined ? "unavailable" : `${input.poolAgeMs}ms`} < minimum ${input.challengeMinPoolAgeMs ?? 6 * 3_600_000}ms`;
    } else if (
      input.challengeMode === true &&
      (input.challengePeakEquityUsd ?? 0) > 0 &&
      input.portfolioValueUsd <
        (input.challengePeakEquityUsd ?? 0) * ((input.challengeHardFloorPct ?? 50) / 100)
    ) {
      // Portfolio hard floor (safety audit): no ENTERs below the floor % of
      // all-time peak equity — a rug sequence must not drain the wallet.
      enterRejected =
        `[hard-floor] portfolio $${input.portfolioValueUsd.toFixed(0)} below ` +
        `${input.challengeHardFloorPct ?? 50}% of peak equity $${(input.challengePeakEquityUsd ?? 0).toFixed(0)}`;
    } else if (
      input.challengeMode === true &&
      (input.lossCooldownUntilMs ?? 0) > 0 &&
      (input.nowMs ?? Date.now()) < (input.lossCooldownUntilMs ?? 0)
    ) {
      // Per-pool loss cooldown (safety audit): a pool that realized a loss is
      // barred from re-entry until its stale drawdown has refreshed.
      enterRejected = "[loss-cooldown] pool recently realized a loss — re-entry barred";
    } else {
      const entryScore = weightedEntryScore(metrics, input.signalWeights ?? DEFAULT_SIGNAL_WEIGHTS);
      if (entryScore <= input.weightedEntryScoreThreshold) {
        enterRejected = `[weighted-score] score ${entryScore.toFixed(3)} <= threshold ${input.weightedEntryScoreThreshold}`;
      } else {
        const allocationArgs = {
          proposedDepositUsd: input.proposedSizeUsd,
          portfolioValueUsd: input.portfolioValueUsd,
          openPositions: input.openPositions.map(toRiskPosition),
          maxPerPoolAllocationPct: input.risk.maxPerPoolAllocationPct,
          maxOpenPositions: input.maxOpenPositions,
          poolAddress,
          maxPositionsPerPool: input.risk.maxPositionsPerPool,
          poolTvlUsd: input.poolTvlUsd,
        };
        if (input.challengePoolShareCapPct !== undefined) {
          Object.assign(allocationArgs, {
            challengePoolShareCapPct: input.challengePoolShareCapPct,
          });
        }
        const allocation = evaluatePerPoolAllocation(allocationArgs);
        if (!allocation.approved) {
          enterRejected = `[alloc-gate] ${allocation.reason}`;
        } else {
          decision = {
            action: "ENTER",
            poolAddress,
            confidence: Math.min(0.5 + feeIlRatio * 0.05, 0.85),
            reasoning: `Strong pool: Fee/IL ${feeIlRatio.toFixed(2)}, auth ${volumeAuth.toFixed(2)}, TVL $${input.poolTvlUsd.toFixed(0)}`,
            positionSizeUsd: allocation.adjustedDepositUsd,
          };
        }
      }
    }
    // A rejected ENTER is a live no-decision (audited, no raw decision) — the
    // replay returns a confidence-0 HOLD so no position is opened.
    if (!decision) {
      decision = {
        action: "HOLD",
        poolAddress,
        confidence: 0,
        reasoning: `[enter-gate] ${enterRejected ?? "ENTER slot skipped"}`,
      };
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
