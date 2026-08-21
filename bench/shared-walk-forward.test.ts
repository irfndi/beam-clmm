import { describe, expect, it } from "vitest";
import {
  runSharedWalkForward,
  type SharedWalkForwardSnapshot,
  type SharedWalkForwardStrategy,
} from "../ops/shared-walk-forward.js";

const DAY = 24 * 3_600_000;
const pair = { scale: 1, invert: false, stablePriceUsd: 1 } as const;

const strategy: SharedWalkForwardStrategy = {
  portfolioUsd: 1_000,
  maxConcurrentPositions: 1,
  maxDeployedPct: 100,
  maxPositionUsd: 1_000,
  halfWidthTicks: 4_600,
  drawdownExitPct: 5,
  yieldDecayFraction: 0.7,
  yieldHysteresis: false,
  rotationCooldownMs: 0,
  stopLossPct: 0.15,
  stopLossEnabled: true,
  trailingStopPct: 0.1,
  minTvlUsd: 1_000,
  poolShareCapPct: 100,
  entryCostUsd: 0,
  exitCostUsd: 0,
  slippageBps: 0,
  minFeeCostRatio: 0,
};

function snapshots(prices: readonly number[]): readonly SharedWalkForwardSnapshot[] {
  return prices.map((currentPrice, index) => ({
    timestamp: index * DAY,
    currentPrice,
    fees24hUsd: 100,
    tvlUsd: 10_000,
    activeBinId: 0,
    drawdown24h: null,
    usdPair: pair,
  }));
}

function run(
  snapshotsByPool: ReadonlyMap<string, readonly SharedWalkForwardSnapshot[]>,
  requirements = {
    minAcceptedTrades: 1,
    maxDrawdownPct: 1,
    minElapsedCoverageMs: DAY,
    minProfitFactor: 0,
  },
) {
  return runSharedWalkForward({
    snapshotsByPool,
    candidates: [strategy],
    toStrategy: () => strategy,
    train: { startMs: 0, endMs: 2 * DAY },
    validation: { startMs: 2 * DAY + 1, endMs: 4 * DAY },
    test: { startMs: 4 * DAY + 1, endMs: 6 * DAY },
    requirements,
  });
}

describe("shared wallet walk-forward", () => {
  it("uses one wallet and enforces concurrent/deployed caps", () => {
    const result = run(
      new Map([
        ["pool-a", snapshots([1, 1, 1, 1, 1, 1, 1])],
        ["pool-b", snapshots([1, 1, 1, 1, 1, 1, 1])],
      ]),
    );

    expect(result.winner?.metrics.acceptedEntries).toBe(1);
    expect(result.winner?.metrics.completedTrades).toBe(1);
  });

  it("does not select a winner below the minimum accepted trades", () => {
    const result = run(new Map([["pool-a", snapshots([1, 1, 1, 1, 1, 1, 1])]]), {
      minAcceptedTrades: 2,
      maxDrawdownPct: 1,
      minElapsedCoverageMs: DAY,
      minProfitFactor: 0,
    });

    expect(result.winner).toBeNull();
    expect(result.candidatesConsidered).toBe(1);
  });

  it("rejects a split with insufficient elapsed coverage", () => {
    const result = run(new Map([["pool-a", snapshots([1, 1, 1, 1, 1, 1, 1])]]), {
      minAcceptedTrades: 1,
      maxDrawdownPct: 1,
      minElapsedCoverageMs: 3 * DAY,
      minProfitFactor: 0,
    });

    expect(result.winner).toBeNull();
  });
});
