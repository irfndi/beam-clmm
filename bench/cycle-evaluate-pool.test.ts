import { describe, expect, it } from "vitest";
import { evaluateReplayPool } from "../engine/cycle/evaluate-pool.js";
import { evaluateRisk } from "../engine/risk-service.js";
import type { PoolMetrics, PoolState, Position } from "../engine/types.js";
import type { ReplayEvaluationInput } from "../engine/cycle/evaluate-pool.js";

const metrics: PoolMetrics = {
  // SAFETY: this fixture supplies only the PoolState fields read by replay evaluation.
  pool: { tvlUsd: 150_000, fees24hUsd: 0, volume24hUsd: 0 } as PoolState,
  // SAFETY: replay tests do not inspect bin contents.
  binArray: {} as PoolMetrics["binArray"],
  tvlVelocity: 0,
  feeIlRatio: 4,
  volumeAuthenticity: 0.9,
  binUtilization: 0.8,
  volumeAuthenticityKnown: true,
  feeIlRatioKnown: true,
  binUtilizationKnown: true,
  farmAprPct: null,
};

const base = {
  poolAddress: "pool-a",
  activeBinId: 100,
  metrics,
  portfolioValueUsd: 10_000,
  recentPnlUsd: 0,
  memoryWarningCount: 0,
  confidenceThreshold: 0.65,
  trailingStopPct: 0.1,
  risk: {
    confidenceThreshold: 0.65,
    maxRebalanceRangeBins: 50,
    stopLossPct: 0.15,
    maxPerPoolAllocationPct: 0.4,
    maxPositionsPerPool: 2,
    maxObservedPriceRangePct: 30,
  },
  proposedSizeUsd: 9_000,
  // Live-chain parity knobs (engine/config-service.ts defaults).
  poolTvlUsd: 150_000,
  trailingStopConfirmCycles: 1,
  minFeeIlRatio: 1.2,
  volumeAuthThreshold: 0.7,
  minBinUtilization: 0.3,
  minPoolTvlUsd: 50_000,
  weightedEntryScoreThreshold: 0.6,
  ilProtectionEnabled: true,
  dustExitUsd: 5,
  tvlDropExitPct: 0.3,
  maxOpenPositions: 3,
  trailingStopBreaches: 0,
  stopLossBreaches: 0,
  challengeMinScore: 0,
  challengeMinPoolAgeMs: 6 * 3_600_000,
  poolAgeMs: 6 * 3_600_000,
} as const;

const heldPosition = {
  poolAddress: "pool-a",
  positionPubKey: "position-1",
  lowerBinId: 90,
  upperBinId: 110,
  depositedUsd: 1_000,
  currentValueUsd: 1_000,
  highestValueUsd: 1_000,
};

describe("evaluateReplayPool", () => {
  it("caps an ENTER through the same per-pool risk gate as the engine", () => {
    const result = evaluateReplayPool({ ...base, position: undefined, openPositions: [] });

    expect(result.decision.action).toBe("ENTER");
    // Live ENTER confidence: min(0.5 + feeIlRatio*0.05, 0.85) = 0.7 ≥ 0.65.
    expect(result.decision.confidence).toBe(0.7);
    expect(result.riskApproved).toBe(true);
    expect(result.adjustedSizeUsd).toBe(4_000);
  });

  it("[fee-gas-gate] blocks an ENTER whose 7d expected fees cannot cover gas", () => {
    // Measured fees exist but are tiny relative to the round-trip gas cost.
    const lowFeeInput: ReplayEvaluationInput = {
      ...base,
      position: undefined,
      openPositions: [],
      enterRoundTripGasUsd: 0.15,
      enterMin7dFeeOverGas: 1.0,
      metrics: {
        ...metrics,
        pool: {
          ...metrics.pool,
          tvlUsd: 150_000,
          fees24hUsd: 0.2, // $0.20/day on a $9,000 entry → ~$0.08/week < $0.15 gas
        },
      },
    };
    const result = evaluateReplayPool(lowFeeInput);
    expect(result.decision.action).toBe("HOLD");
    // The rejection reason is exposed through the decision reasoning (live
    // parity) — verify the gate fired and was not some other gate.
    expect(result.decision.reasoning).toContain("[fee-gas-gate]");
  });

  it("[fee-gas-gate] lets a fee-rich pool ENTER (7d fees ≥ gas)", () => {
    const richFeeInput: ReplayEvaluationInput = {
      ...base,
      position: undefined,
      openPositions: [],
      enterRoundTripGasUsd: 0.15,
      enterMin7dFeeOverGas: 1.0,
      metrics: {
        ...metrics,
        pool: {
          ...metrics.pool,
          tvlUsd: 150_000,
          fees24hUsd: 50, // $50/day on a $9,000 entry → ~$21/week
        },
      },
    };
    const result = evaluateReplayPool(richFeeInput);
    expect(result.decision.action).toBe("ENTER");
    expect(result.riskApproved).toBe(true);
  });

  it("forces a capital-protection EXIT when the trailing stop is breached", () => {
    const result = evaluateReplayPool({
      ...base,
      openPositions: [],
      position: {
        ...heldPosition,
        currentValueUsd: 875,
      },
    });

    expect(result.decision.action).toBe("EXIT");
    expect(result.riskApproved).toBe(true);
    expect(result.riskReason).toContain("capital protection");
  });

  it("confirms the #153 trailing-stop breach across consecutive cycles", () => {
    const breached = { ...heldPosition, currentValueUsd: 875 };
    const first = evaluateReplayPool({
      ...base,
      trailingStopConfirmCycles: 2,
      trailingStopBreaches: 0,
      position: breached,
      openPositions: [breached],
    });
    expect(first.decision.action).toBe("HOLD");
    expect(first.trailingStopBreachCount).toBe(1);

    const second = evaluateReplayPool({
      ...base,
      trailingStopConfirmCycles: 2,
      trailingStopBreaches: 1,
      position: breached,
      openPositions: [breached],
    });
    expect(second.decision.action).toBe("EXIT");
    expect(second.trailingStopBreachCount).toBe(2);
  });

  it("exits on the hard stop-loss when an in-range position falls below entry minus stopLossPct", () => {
    // deposited 1000, peak == mark 800 → no trailing-stop drawdown, but the
    // entry-based loss is -20% < -15% (risk.stopLossPct), so stop-loss fires.
    const result = evaluateReplayPool({
      ...base,
      position: {
        ...heldPosition,
        depositedUsd: 1_000,
        highestValueUsd: 800,
        currentValueUsd: 800,
      },
      openPositions: [
        {
          ...heldPosition,
          depositedUsd: 1_000,
          highestValueUsd: 800,
          currentValueUsd: 800,
        },
      ],
    });

    expect(result.decision.action).toBe("EXIT");
    expect(result.decision.reasoning).toContain("Stop-loss");
  });

  it("does not fire the hard stop-loss when the loss is within stopLossPct", () => {
    // -12% loss is within the 15% stop-loss; peak == mark means the 10%
    // trailing-stop drawdown is not breached either, so the position holds.
    const result = evaluateReplayPool({
      ...base,
      position: {
        ...heldPosition,
        depositedUsd: 1_000,
        highestValueUsd: 880,
        currentValueUsd: 880,
      },
      openPositions: [
        {
          ...heldPosition,
          depositedUsd: 1_000,
          highestValueUsd: 880,
          currentValueUsd: 880,
        },
      ],
    });

    expect(result.decision.action).toBe("HOLD");
  });

  it("confirms the hard stop-loss breach across consecutive cycles (#153 parity)", () => {
    const breached = {
      ...heldPosition,
      depositedUsd: 1_000,
      highestValueUsd: 800,
      currentValueUsd: 800,
    };
    const first = evaluateReplayPool({
      ...base,
      trailingStopConfirmCycles: 2,
      stopLossBreaches: 0,
      position: breached,
      openPositions: [breached],
    });
    expect(first.decision.action).toBe("HOLD");
    expect(first.stopLossBreachCount).toBe(1);

    const second = evaluateReplayPool({
      ...base,
      trailingStopConfirmCycles: 2,
      stopLossBreaches: 1,
      position: breached,
      openPositions: [breached],
    });
    expect(second.decision.action).toBe("EXIT");
    expect(second.stopLossBreachCount).toBe(2);
  });

  it("respects the exact stop-loss boundary: −15.0% holds, −15.1% exits", () => {
    const atBoundary = evaluateReplayPool({
      ...base,
      position: {
        ...heldPosition,
        depositedUsd: 1_000,
        highestValueUsd: 850,
        currentValueUsd: 850,
      },
      openPositions: [
        {
          ...heldPosition,
          depositedUsd: 1_000,
          highestValueUsd: 850,
          currentValueUsd: 850,
        },
      ],
    });
    // Exactly −15% is not strictly below −15% (and no trailing-stop drawdown).
    expect(atBoundary.decision.action).toBe("HOLD");

    const pastBoundary = evaluateReplayPool({
      ...base,
      position: {
        ...heldPosition,
        depositedUsd: 1_000,
        highestValueUsd: 849,
        currentValueUsd: 849,
      },
      openPositions: [
        {
          ...heldPosition,
          depositedUsd: 1_000,
          highestValueUsd: 849,
          currentValueUsd: 849,
        },
      ],
    });
    expect(pastBoundary.decision.action).toBe("EXIT");
    expect(pastBoundary.decision.reasoning).toContain("Stop-loss");
  });

  it("never fires the EXIT chain without a position — a crashing-TVL pool still gets the ENTER gate", () => {
    // Live's EXIT chain runs per-position; with no position the pool goes
    // straight to the ENTER mega-gate (which does not check tvlVelocity).
    const result = evaluateReplayPool({
      ...base,
      metrics: {
        ...metrics,
        tvlVelocity: -0.9,
      },
      position: undefined,
      openPositions: [],
    });

    expect(result.decision.action).toBe("ENTER");
    expect(result.riskApproved).toBe(true);
  });

  it("exits on measured Fee/IL below 0.5 (live gate)", () => {
    const result = evaluateReplayPool({
      ...base,
      metrics: { ...metrics, feeIlRatio: 0.3 },
      position: heldPosition,
      openPositions: [heldPosition],
    });

    expect(result.decision.action).toBe("EXIT");
    expect(result.decision.reasoning).toContain("Fee/IL ratio 0.30 below 0.5");
  });

  it("skips the Fee/IL EXIT when the ratio is not measured (gecko/heuristic)", () => {
    const result = evaluateReplayPool({
      ...base,
      metrics: { ...metrics, feeIlRatio: 0.3, feeIlRatioKnown: false },
      position: heldPosition,
      openPositions: [heldPosition],
    });

    expect(result.decision.action).toBe("HOLD");
  });

  it("exits on volume authenticity below threshold when measured", () => {
    const result = evaluateReplayPool({
      ...base,
      metrics: { ...metrics, volumeAuthenticity: 0.5 },
      position: heldPosition,
      openPositions: [heldPosition],
    });

    expect(result.decision.action).toBe("EXIT");
    expect(result.decision.reasoning).toContain("Volume authenticity 0.50 below threshold");
  });

  it("exits on TVL velocity below the drop threshold (capital protection)", () => {
    const result = evaluateReplayPool({
      ...base,
      metrics: { ...metrics, tvlVelocity: -0.4 },
      position: heldPosition,
      openPositions: [heldPosition],
    });

    expect(result.decision.action).toBe("EXIT");
    expect(result.decision.reasoning).toContain("capital protection exit");
  });

  it("exits a dust position below the dust threshold", () => {
    const result = evaluateReplayPool({
      ...base,
      position: { ...heldPosition, currentValueUsd: 3 },
      openPositions: [],
    });

    expect(result.decision.action).toBe("EXIT");
    expect(result.decision.reasoning).toContain("dust-cleanup");
  });

  it("lets recent memory warnings drop a held position to the default HOLD", () => {
    const result = evaluateReplayPool({
      ...base,
      position: heldPosition,
      openPositions: [heldPosition],
      memoryWarningCount: 3,
    });

    // Live HOLD: no positive formula with a recent warning — default HOLD 0.5
    // falls below the confidence gate, mirroring the engine's risk tail.
    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.confidence).toBe(0.5);
    expect(result.riskApproved).toBe(false);
    expect(result.riskReason).toContain("below threshold");
  });

  it("matches the engine decision for a recorded trailing-stop snapshot", () => {
    const position = {
      ...heldPosition,
      currentValueUsd: 875,
    };
    const replay = evaluateReplayPool({
      ...base,
      position,
      openPositions: [position],
    });
    const enginePosition: Position = {
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
      openedAt: 1_700_000_000_000,
    };
    const engineRisk = evaluateRisk(
      base.risk,
      {
        action: "EXIT",
        poolAddress: position.poolAddress,
        confidence: 0.8,
        reasoning: "Trailing stop from recorded snapshot",
      },
      {
        openPositions: [enginePosition],
        portfolioValueUsd: base.portfolioValueUsd,
        recentPnlUsd: 0,
        poolAddress: position.poolAddress,
        activeBinId: base.activeBinId,
      },
    );

    expect(replay.decision.action).toBe("EXIT");
    expect(replay.riskApproved).toBe(engineRisk.approved);
    expect(replay.decision.poolAddress).toBe(position.poolAddress);
  });

  it("rejects ENTER when the W10 per-pool position cap is reached", () => {
    const positions = [1, 2].map((index) => ({
      ...heldPosition,
      positionPubKey: `position-${index}`,
    }));
    const result = evaluateReplayPool({
      ...base,
      position: undefined,
      openPositions: positions,
    });

    // Live: the ENTER slot is skipped entirely — no ENTER decision is made.
    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.reasoning).toContain("Per-pool position cap reached");
    expect(result.riskApproved).toBe(false);
  });

  it("rejects ENTER via the [fee-il-gate] hard floor when fees cannot beat IL", () => {
    const result = evaluateReplayPool({
      ...base,
      metrics: { ...metrics, feeIlRatio: 0.9 },
      position: undefined,
      openPositions: [],
    });

    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.reasoning).toContain("fee-il-gate");
  });

  it("skips ENTER entirely for a heuristic pool (no measured volume/fee signals)", () => {
    const result = evaluateReplayPool({
      ...base,
      metrics: {
        ...metrics,
        volumeAuthenticityKnown: false,
        feeIlRatioKnown: false,
      },
      position: undefined,
      openPositions: [],
    });

    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.reasoning).toContain("candidate-gate");
  });

  it("exits on the challenge-rotation drawdown (Krystal 24h drawdown)", () => {
    const result = evaluateReplayPool({
      ...base,
      challengeMode: true,
      drawdown24hPct: -12,
      position: heldPosition,
      openPositions: [heldPosition],
    });

    expect(result.decision.action).toBe("EXIT");
    expect(result.decision.reasoning).toContain("challenge-rotation");
  });

  it("blocks ENTER below the challenge hard floor of peak equity", () => {
    const result = evaluateReplayPool({
      ...base,
      challengeMode: true,
      challengePeakEquityUsd: 100_000,
      challengeHardFloorPct: 50,
      poolTvlUsd: 150_000,
      position: undefined,
      openPositions: [],
    });

    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.reasoning).toContain("hard-floor");
  });

  it("blocks challenge ENTER when the pool score is below the configured floor", () => {
    const result = evaluateReplayPool({
      ...base,
      challengeMode: true,
      challengeMinScore: 1,
      position: undefined,
      openPositions: [],
    });

    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.reasoning).toContain("[challenge-score-gate]");
  });

  it("blocks challenge ENTER when reconstructed pool age is below the configured minimum", () => {
    const result = evaluateReplayPool({
      ...base,
      challengeMode: true,
      challengeMinPoolAgeMs: 6 * 3_600_000,
      poolAgeMs: 5 * 3_600_000,
      position: undefined,
      openPositions: [],
    });

    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.reasoning).toContain("[challenge-age-gate]");
  });

  it("blocks ENTER during the challenge per-pool loss cooldown", () => {
    const result = evaluateReplayPool({
      ...base,
      challengeMode: true,
      lossCooldownUntilMs: Date.now() + 3_600_000,
      poolTvlUsd: 150_000,
      position: undefined,
      openPositions: [],
    });

    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.reasoning).toContain("loss-cooldown");
  });

  it("uses the supplied replay clock for historical loss cooldowns", () => {
    const result = evaluateReplayPool({
      ...base,
      challengeMode: true,
      lossCooldownUntilMs: 2_000,
      nowMs: 1_000,
      poolTvlUsd: 150_000,
      position: undefined,
      openPositions: [],
    });

    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.reasoning).toContain("loss-cooldown");
  });

  it("caps ENTER size at the challenge pool-share cap of pool TVL", () => {
    const result = evaluateReplayPool({
      ...base,
      challengeMode: true,
      challengePoolShareCapPct: 1,
      poolTvlUsd: 150_000,
      proposedSizeUsd: 9_000,
      position: undefined,
      openPositions: [],
    });

    // 1% of $150k TVL = $1,500 headroom beats the 40% portfolio cap ($4,000).
    expect(result.decision.action).toBe("ENTER");
    expect(result.decision.positionSizeUsd).toBe(1_500);
  });
});
