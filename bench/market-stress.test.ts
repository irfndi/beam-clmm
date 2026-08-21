import { describe, it, expect } from "vitest";
import {
  assessMarketStress,
  assessStressZScore,
} from "../engine/market-stress.js";

const HOUR = 3_600_000;

/** Build a price series: `prices[i]` is the price at grid point i. */
function series(prices: number[], startMs = 1_000 * HOUR) {
  return prices.map((price, i) => ({ timestamp: startMs + i * HOUR, price }));
}

describe("assessMarketStress", () => {
  it("returns high correlation for pools moving in lockstep", () => {
    const common = [100, 102, 99, 105, 103, 108, 106, 111, 109, 115, 112, 118, 121];
    const pools = new Map([
      ["pA", series(common)],
      ["pB", series(common.map((v) => v * 2))],
      ["pC", series(common.map((v) => v * 0.5))],
    ]);
    const res = assessMarketStress(pools, 1_000 * HOUR + 12 * HOUR, 12);
    expect(res.meanCorrelation).not.toBeNull();
    expect(res.meanCorrelation!).toBeGreaterThan(0.95);
    expect(res.poolCount).toBe(3);
    expect(res.sampleCount).toBe(12);
  });

  it("returns near-zero correlation for independent random walks", () => {
    // Deterministic pseudo-noise (LCG) — no shared factor.
    let seed = 42;
    const noise = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 2 ** 31 - 1;
    };
    const walk = (): number[] => {
      const out = [100];
      for (let i = 0; i < 24; i++) out.push(Math.max(1, out[i]! * (1 + noise() * 0.02)));
      return out;
    };
    const pools = new Map<string, ReturnType<typeof series>>([
      ["pA", series(walk())],
      ["pB", series(walk())],
      ["pC", series(walk())],
      ["pD", series(walk())],
    ]);
    const res = assessMarketStress(pools, 1_000 * HOUR + 24 * HOUR, 24);
    expect(res.meanCorrelation).not.toBeNull();
    expect(Math.abs(res.meanCorrelation!)).toBeLessThan(0.6);
  });

  it("returns null when fewer than 3 pools have enough samples", () => {
    const short = series([100, 101, 102]);
    const pools = new Map([
      ["pA", short],
      ["pB", short],
    ]);
    const res = assessMarketStress(pools, 1_000 * HOUR + 3 * HOUR, 12);
    expect(res.meanCorrelation).toBeNull();
    expect(res.zScore).toBeNull();
  });

  it("ignores flat series (zero variance carries no correlation info)", () => {
    const moving = [100, 104, 98, 107, 101, 110, 103, 112, 106, 115, 108, 118, 114];
    const flat = Array.from({ length: 13 }, () => 50);
    const pools = new Map([
      ["pA", series(moving)],
      ["pB", series(moving.map((v) => v * 1.01))],
      ["pFlat", series(flat)],
    ]);
    const res = assessMarketStress(pools, 1_000 * HOUR + 12 * HOUR, 12);
    // Only the two moving pools form a pair; correlation stays high.
    expect(res.meanCorrelation).not.toBeNull();
    expect(res.meanCorrelation!).toBeGreaterThan(0.9);
  });

  it("aligns irregular snapshot cadences onto the hourly grid", () => {
    // pB snapshots at odd offsets starting one hour BEFORE the window — each
    // grid tick must still pick up the same-shaped price.
    const common = [100, 102, 99, 105, 103, 108, 106, 111, 109, 115, 112, 118, 121];
    const irregular = common.map((price, i) => ({
      timestamp: 999 * HOUR + i * HOUR + 600_000,
      price,
    }));
    const pools = new Map([
      ["pA", series(common)],
      ["pB", irregular],
      ["pC", series(common.map((v) => v * 3))],
    ]);
    const res = assessMarketStress(pools, 1_000 * HOUR + 12 * HOUR, 12);
    expect(res.meanCorrelation).not.toBeNull();
    expect(res.meanCorrelation!).toBeGreaterThan(0.9);
  });
});

describe("assessStressZScore", () => {
  it("is null before the minimum baseline exists", () => {
    expect(assessStressZScore(0.5, [0.4, 0.45, 0.5])).toBeNull();
  });

  it("scores an extreme spike well above the baseline", () => {
    const baseline = Array.from({ length: 20 }, (_, i) => 0.1 + (i % 3) * 0.01);
    const z = assessStressZScore(0.4, baseline);
    expect(z).not.toBeNull();
    expect(z!).toBeGreaterThan(5);
  });

  it("is null when the baseline has zero variance", () => {
    expect(assessStressZScore(0.5, Array.from({ length: 10 }, () => 0.3))).toBeNull();
  });
});
