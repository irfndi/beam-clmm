import { describe, it, expect } from "vitest";
import {
  challengePoolScore,
  challengeRangeFromVolatility,
  challengeRotationSignal,
  avgFeeYieldPct,
} from "../engine/challenge-strategy.js";
import { makePool } from "./helpers.js";

describe("challengePoolScore", () => {
  it("scores a measured-fee pool by yield x (1+dd) with stable-leg bonus", () => {
    const pool = makePool({
      tvlUsd: 200_000,
      volume24hUsd: 2_000_000,
      fees24hUsd: 36_000, // 18%/day
      drawdown24h: -0.02,
      tokenXSymbol: "ETH",
      tokenYSymbol: "USDG",
      statsSource: "krystal",
    });
    const s = challengePoolScore(pool);
    expect(s.yieldPerDayPct).toBeCloseTo(18, 3);
    expect(s.tier).toBe("S");
    expect(s.score).toBeGreaterThan(18); // stable bonus
    expect(s.reasons).toContain("stable-leg");
  });

  it("rejects a crashing pool (dd < -10%)", () => {
    const pool = makePool({
      tvlUsd: 5_000,
      volume24hUsd: 200_000,
      fees24hUsd: 1_800, // 36%/day
      drawdown24h: -35,
      tokenXSymbol: "ETH",
      statsSource: "krystal",
    });
    const s = challengePoolScore(pool);
    expect(s.tier).toBe("none");
    expect(s.score).toBe(0);
  });

  it("rejects pools with no measured fees", () => {
    const pool = makePool({ tvlUsd: 10_000, fees24hUsd: 0, statsSource: "heuristic" });
    expect(challengePoolScore(pool).tier).toBe("none");
  });

  it("ranks the CASHCAT archetype as A (high yield, no drawdown)", () => {
    const pool = makePool({
      tvlUsd: 5_300,
      volume24hUsd: 193_500,
      fees24hUsd: 1_940, // 36.6%/day
      drawdown24h: 0,
      tokenXSymbol: "ETH",
      tokenYSymbol: "CASHCAT",
      statsSource: "krystal",
    });
    const s = challengePoolScore(pool);
    expect(s.tier).toBe("A");
    expect(s.yieldPerDayPct).toBeCloseTo(36.6, 1);
  });
});

describe("challengeRangeFromVolatility", () => {
  it("sizes a k-sigma range from priceVolatility, spacing-aligned", () => {
    const r = challengeRangeFromVolatility(-200_735, 60, 24, 1.5);
    // 24%/day vol -> halfWidth ~ ln(1+0.36)/ln(1.0001) ~ 3072 ticks... but the
    // tick is large/negative: the range must contain the active tick.
    expect(r.lowerBinId).toBeLessThan(-200_735);
    expect(r.upperBinId).toBeGreaterThan(-200_735);
    expect(Math.abs(r.lowerBinId % 60)).toBe(0);
    expect(Math.abs(r.upperBinId % 60)).toBe(0);
    expect(r.halfWidth).toBeGreaterThan(0);
  });

  it("clamps degenerate volatility to a minimal range", () => {
    const r = challengeRangeFromVolatility(0, 60, 0.001, 1.5);
    expect(r.halfWidth).toBeGreaterThanOrEqual(2);
  });
});

describe("challengeRotationSignal", () => {
  const base = () =>
    makePool({
      tvlUsd: 5_000,
      volume24hUsd: 200_000,
      fees24hUsd: 1_800,
      drawdown24h: 0,
      statsSource: "krystal",
    });

  it("exits below the drawdown exit threshold", () => {
    expect(challengeRotationSignal(base(), null).action).toBe("hold");
    expect(challengeRotationSignal({ ...base(), drawdown24h: -6 }, null).action).toBe("halve");
    expect(challengeRotationSignal({ ...base(), drawdown24h: -12 }, null).action).toBe("exit");
  });

  it("exits on yield decay below 50% of the trailing average", () => {
    const pool = { ...base(), fees24hUsd: 900 }; // 18%/day vs 40%/day avg
    const s = challengeRotationSignal(pool, 40);
    expect(s.action).toBe("exit");
  });

  it("halves on yield decay between 50-70%", () => {
    const pool = { ...base(), fees24hUsd: 1_200 }; // 24%/day vs 40%/day avg (60% < 70%)
    expect(challengeRotationSignal(pool, 40).action).toBe("halve");
  });
});

describe("avgFeeYieldPct", () => {
  it("averages per-snapshot fee yield, skipping zero-TVL rows", () => {
    const avg = avgFeeYieldPct([
      { tvlUsd: 10_000, fees24hUsd: 1_000 }, // 10%/d
      { tvlUsd: 20_000, fees24hUsd: 4_000 }, // 20%/d
      { tvlUsd: 0, fees24hUsd: 500 },
    ]);
    expect(avg).toBeCloseTo(15, 3);
  });

  it("returns null on empty history", () => {
    expect(avgFeeYieldPct([])).toBeNull();
  });
});
