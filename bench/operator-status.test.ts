import { describe, expect, it } from "vitest";
import {
  OPERATOR_STATUS_SCHEMA_VERSION,
  autonomousStatus,
  buildOperatorStatus,
  portfolioStatusFromPositions,
  positionStatusFromRecord,
  positionStatusFromSnapshot,
} from "../engine/operator-status.js";
import type { PositionRecord } from "../engine/db-service.js";

const record: PositionRecord = {
  positionId: "paper-pool-1",
  poolAddress: "pool-1",
  positionPubKey: null,
  depositedUsd: 100,
  currentValueUsd: 105,
  tokenXSymbol: "WETH",
  tokenYSymbol: "USDC",
  activeBinId: 1,
  lowerBinId: 0,
  upperBinId: 2,
  timestamp: Date.now() - 3_600_000,
  outOfRangeSince: null,
  oorCycleCount: 0,
  lastFeeClaimAt: 0,
  trailingStopThreshold: null,
  highestValueUsd: null,
  lastRebalanceAt: 0,
  paperExitedAt: null,
  entrySignalTimestamp: null,
  entrySignalSnapshotId: null,
  entryPriceUsd: null,
  entryAmountXUsd: null,
  entryAmountYUsd: null,
  cumulativeFeesClaimedUsd: 2,
  cumulativeRewardsClaimedUsd: 1,
  closedAt: null,
  realizedPnlUsd: null,
};

describe("operator status read model", () => {
  it("computes one position from a record including fees and rewards", () => {
    const position = positionStatusFromRecord(record, null, Date.now());
    expect(position.unrealizedPnlUsd).toBe(8);
    expect(position.unrealizedPnlPct).toBe(8);
    expect(position.feesClaimedUsd).toBe(2);
    expect(position.rewardsClaimedUsd).toBe(1);
  });

  it("aggregates the portfolio from the same position rows", () => {
    const portfolio = portfolioStatusFromPositions([record, { ...record, positionId: "p2" }], 50);
    expect(portfolio.totalValueUsd).toBe(210);
    expect(portfolio.totalDepositedUsd).toBe(200);
    expect(portfolio.totalUnrealizedPnlUsd).toBe(16);
    expect(portfolio.totalFeesClaimedUsd).toBe(4);
    expect(portfolio.totalRewardsClaimedUsd).toBe(2);
    expect(portfolio.totalEquityUsd).toBe(260);
    expect(portfolio.positionCount).toBe(2);
    expect(portfolio.walletKnown).toBe(true);
  });

  it("fills the shared envelope with schema version and empty sections", () => {
    const status = buildOperatorStatus({
      source: "http",
      running: true,
      version: "0.1.12",
      portfolio: portfolioStatusFromPositions([], null),
    });
    expect(status.schemaVersion).toBe(OPERATOR_STATUS_SCHEMA_VERSION);
    expect(status.source).toBe("http");
    expect(status.positions).toEqual([]);
    expect(status.decisions).toEqual([]);
    expect(status.autonomous).toBeNull();
    expect(status.portfolio.walletBalanceUsd).toBeNull();
  });

  it("maps the loop's in-memory position snapshot without fabricating fees", () => {
    const position = positionStatusFromSnapshot({
      positionId: "p",
      poolAddress: "pool",
      tokenXSymbol: "A",
      tokenYSymbol: "B",
      depositedUsd: 100,
      currentValueUsd: 110,
      activeBinId: 1,
      lowerBinId: 0,
      upperBinId: 2,
      lastAction: "HOLD",
      lastActionAt: 123,
      hoursHeld: 2,
    });
    expect(position.unrealizedPnlUsd).toBe(10);
    expect(position.feesClaimedUsd).toBe(0);
    expect(position.lastAction).toBe("HOLD");
    expect(position.ageMs).toBe(7_200_000);
  });

  it("maps autonomous runtime records to the canonical section", () => {
    const autonomous = autonomousStatus({
      mode: "shadow",
      walletAddress: null,
      agentInstanceId: "beam-base",
      candidates: [],
      operations: [],
      settlements: [],
      safetyPause: {
        walletAddress: "paper",
        agentInstanceId: "beam-base",
        reason: "test",
        triggeredAt: 1,
        resolvedAt: null,
      },
    });
    expect(autonomous.agentInstanceId).toBe("beam-base");
    expect(autonomous.safetyPause?.active).toBe(true);
  });
});
