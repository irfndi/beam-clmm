import { describe, it, expect } from "vitest";
import { defaultAppConfig, makePool, makeBinArray } from "./helpers.js";
import type { PoolMetrics, Position, SignalWeights } from "../engine/types.js";
import {
  baseCandidateViolation,
  entrySizeFromConfig,
  evaluateEntryGates,
  feeGasFloorViolation,
  feeIlFloorViolation,
  type EntryGateInput,
} from "../engine/entry-gates.js";

const WEIGHTS: SignalWeights = {
  feeIlRatio: 1,
  volumeAuthenticity: 1,
  binUtilization: 1,
  tvlUsd: 1,
  tvlVelocity: 1,
  updatedAt: 0,
};

function makeMetrics(
  pool = makePool({ tvlUsd: 5_000_000, fees24hUsd: 3_000 }),
  overrides: Partial<
    Pick<PoolMetrics, "feeIlRatioKnown" | "volumeAuthenticityKnown" | "binUtilizationKnown">
  > = {},
): PoolMetrics {
  return {
    pool,
    binArray: makeBinArray(),
    tvlVelocity: 0.01,
    feeIlRatio: 3,
    volumeAuthenticity: 0.95,
    binUtilization: 0.6,
    volumeAuthenticityKnown: true,
    feeIlRatioKnown: true,
    binUtilizationKnown: true,
    farmAprPct: null,
    ...overrides,
  };
}

function makeOpenPosition(): Position {
  return {
    id: "pos-1",
    poolAddress: "OtherPool",
    poolName: "WETH/USDC",
    lowerBinId: 1,
    upperBinId: 9,
    liquidityShares: 0n,
    depositedUsd: 500,
    currentValueUsd: 500,
    unrealizedPnlUsd: 0,
    feesEarnedUsd: 0,
    openedAt: 1_000,
  };
}

function gateInput(overrides: Partial<EntryGateInput> = {}): EntryGateInput {
  const pool = makePool({ tvlUsd: 5_000_000, fees24hUsd: 3_000 });
  return {
    config: defaultAppConfig({
      ilProtectionEnabled: true,
      enterRoundTripGasUsd: 0.15,
      enterMin7dFeeOverGas: 1,
    }),
    poolAddress: pool.address,
    poolTvlUsd: pool.tvlUsd,
    poolFees24hUsd: pool.fees24hUsd,
    metrics: makeMetrics(pool),
    feeIlRatio: 3,
    volumeAuth: 0.95,
    binUtilization: 0.6,
    signalWeights: WEIGHTS,
    minFeeIlRatio: 1.2,
    volumeAuthThreshold: 0.7,
    // The caller sizes the deposit; the live rule is entrySizeFromConfig
    // (equity share bounded by TVL share, cap and floor) — 500 here.
    proposedSizeUsd: 500,
    portfolioValueUsd: 10_000,
    openPositions: [],
    ownBookOpenPositions: 0,
    ownBookPoolPositions: 0,
    ...overrides,
  };
}

describe("entry gates", () => {
  it("approves a paying pool and returns the capped size", () => {
    const verdict = evaluateEntryGates(gateInput());
    expect(verdict.approved).toBe(true);
    expect(verdict.code).toBe("ok");
    expect(verdict.positionSizeUsd).toBe(500);
    expect(verdict.entryScore).toBeGreaterThan(0.6);
  });

  it("blocks a measured fee/IL below the floor", () => {
    const input = gateInput({ feeIlRatio: 0.5 });
    expect(feeIlFloorViolation(input)).toContain("fee-il-gate");
    expect(evaluateEntryGates(input).code).toBe("fee-il-floor");
  });

  it("gives a modeled fee/IL no vote in either direction", () => {
    const input = gateInput({
      feeIlRatio: 0.5,
      metrics: makeMetrics(undefined, { feeIlRatioKnown: false }),
    });
    expect(feeIlFloorViolation(input)).toBeNull();
    expect(evaluateEntryGates(input).approved).toBe(true);
  });

  it("blocks a pool whose 7d fees cannot cover the round trip", () => {
    const input = gateInput({ poolFees24hUsd: 0.001 });
    expect(feeGasFloorViolation(input)).not.toBeNull();
    expect(evaluateEntryGates(input).code).toBe("fee-gas-floor");
  });

  it("requires measured volume", () => {
    const input = gateInput({
      metrics: makeMetrics(undefined, { volumeAuthenticityKnown: false }),
    });
    expect(baseCandidateViolation(input)).toBe("volume-unknown");
    expect(evaluateEntryGates(input).code).toBe("volume-unknown");
  });

  it("blocks low volume authenticity against the measured 0.8 bar", () => {
    const input = gateInput({ volumeAuth: 0.5 });
    expect(evaluateEntryGates(input).code).toBe("volume-authenticity");
  });

  it("blocks thin on-chain bin utilization", () => {
    const input = gateInput({ binUtilization: 0.3 });
    expect(evaluateEntryGates(input).code).toBe("bin-utilization");
  });

  it("requires twice the minimum pool TVL to be a candidate", () => {
    const input = gateInput({ poolTvlUsd: 90_000 });
    expect(evaluateEntryGates(input).code).toBe("tvl-floor");
  });

  it("blocks a pool under the weighted score threshold", () => {
    const input = gateInput({
      config: defaultAppConfig({ weightedEntryScoreThreshold: 10 }),
    });
    expect(evaluateEntryGates(input).code).toBe("weighted-score");
  });

  it("caps the entry at the per-pool allocation headroom", () => {
    const input = gateInput({
      openPositions: [makeOpenPosition()],
      ownBookOpenPositions: 1,
      ownBookPoolPositions: 0,
      config: defaultAppConfig({
        maxOpenPositions: 1,
        maxEntrySizeUsd: 500,
      }),
    });
    expect(evaluateEntryGates(input).code).toBe("allocation");
    expect(evaluateEntryGates(input).positionSizeUsd).toBe(0);
  });

  it("sizes within the configured cap and the wallet", () => {
    const sizing = { walletBalanceUsd: 10_000, portfolioValueUsd: 10_000, poolTvlUsd: 5_000_000 };
    expect(entrySizeFromConfig(defaultAppConfig({ maxEntrySizeUsd: 100 }), sizing)).toBe(100);
    const walletBound = entrySizeFromConfig(
      defaultAppConfig({ maxEntrySizeUsd: 10_000, entrySizeEquityFraction: 0.2 }),
      { walletBalanceUsd: 1_000, portfolioValueUsd: 1_000, poolTvlUsd: 5_000_000 },
    );
    expect(walletBound).toBeLessThanOrEqual(500);
  });
});
