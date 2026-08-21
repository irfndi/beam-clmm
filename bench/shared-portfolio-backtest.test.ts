import { describe, expect, it } from "vitest";
import {
  simulateSharedPortfolio,
  type SharedPortfolioConfig,
  type SharedPortfolioEvent,
} from "../ops/shared-portfolio-backtest.js";

const config: SharedPortfolioConfig = {
  initialCapitalUsd: 1_000,
  maxConcurrentPositions: 2,
  maxTotalDeployedUsd: 700,
  maxAllocationPerPoolUsd: 500,
};

function run(events: readonly SharedPortfolioEvent[]) {
  return simulateSharedPortfolio(events, config);
}

describe("simulateSharedPortfolio", () => {
  it("rejects entries when wallet and allocation caps are exceeded", () => {
    const result = run([
      { type: "entry-request", timestamp: 1, pool: "a", amountUsd: 500 },
      { type: "entry-request", timestamp: 2, pool: "b", amountUsd: 300 },
      { type: "entry-request", timestamp: 3, pool: "c", amountUsd: 250 },
      { type: "entry-request", timestamp: 4, pool: "a", amountUsd: 100 },
    ]);

    expect(result.rejectedEntries).toBe(3);
    expect(result.finalEquityUsd).toBe(1_000);
    expect(result.perPoolExposureConcentration.a?.peakDeployedUsd).toBe(500);
    expect(result.perPoolExposureConcentration.a?.peakShareOfDeployed).toBe(1);
  });

  it("settles marked exits and fee cash flows into net PnL", () => {
    const result = run([
      { type: "entry-request", timestamp: 1, pool: "a", amountUsd: 400 },
      { type: "mark", timestamp: 2, pool: "a", valueUsd: 460 },
      { type: "fee", timestamp: 3, pool: "a", amountUsd: 10 },
      { type: "fee", timestamp: 4, pool: "a", amountUsd: -5 },
      { type: "exit", timestamp: 5, pool: "a", valueUsd: 460 },
    ]);

    expect(result.finalEquityUsd).toBe(1_065);
    expect(result.netPnlUsd).toBe(65);
    expect(result.maxDrawdownUsd).toBe(5);
  });

  it("tracks drawdown from the highest observed equity", () => {
    const result = run([
      { type: "entry-request", timestamp: 1, pool: "a", amountUsd: 400 },
      { type: "mark", timestamp: 2, pool: "a", valueUsd: 600 },
      { type: "mark", timestamp: 3, pool: "a", valueUsd: 300 },
      { type: "exit", timestamp: 4, pool: "a", valueUsd: 300 },
    ]);

    expect(result.maxDrawdownUsd).toBe(300);
    expect(result.maxDrawdownPct).toBe(300 / 1_200);
    expect(result.finalEquityUsd).toBe(900);
    expect(result.netPnlUsd).toBe(-100);
  });
});
