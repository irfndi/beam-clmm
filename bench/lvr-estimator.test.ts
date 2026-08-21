import { describe, it, expect } from "vitest";
import {
  annualizedVarianceFromSnapshots,
  estimateLvrEdge,
} from "../engine/lvr-estimator.js";

const HOUR = 3_600_000;

function hourlySeries(prices: number[], startMs = 1_000 * HOUR) {
  return prices.map((price, i) => ({ timestamp: startMs + i * HOUR, price }));
}

describe("annualizedVarianceFromSnapshots", () => {
  it("matches a hand-computed constant-magnitude series", () => {
    // Every hour the price moves exactly ±1%: each log return is
    // ln(1.01) or ln(0.99); mean ≈ 0, so variance ≈ ln(1.01)².
    const prices: number[] = [100];
    for (let i = 0; i < 24; i++) {
      prices.push(i % 2 === 0 ? prices[i]! * 1.01 : prices[i]! / 1.01);
    }
    const res = annualizedVarianceFromSnapshots(
      hourlySeries(prices),
      1_000 * HOUR + 24 * HOUR,
      48,
    );
    expect(res.variance).not.toBeNull();
    const expected = Math.log(1.01) ** 2 * 24 * 365;
    expect(res.variance!).toBeCloseTo(expected, 6);
  });

  it("returns null below the minimum sample threshold", () => {
    const res = annualizedVarianceFromSnapshots(
      hourlySeries([100, 101, 102]),
      1_000 * HOUR + 3 * HOUR,
      48,
    );
    expect(res.variance).toBeNull();
  });

  it("carries last-known price across gaps (irregular cadence)", () => {
    // Snapshots every 2 hours still fill every grid point via LKF.
    const snaps = Array.from({ length: 30 }, (_, i) => ({
      timestamp: 1_000 * HOUR + i * 2 * HOUR,
      price: 100 * (1 + (i % 5) * 0.004),
    }));
    const res = annualizedVarianceFromSnapshots(snaps, 1_000 * HOUR + 60 * HOUR, 60);
    expect(res.variance).not.toBeNull();
    expect(res.samples).toBeGreaterThanOrEqual(12);
  });

  it("returns null for a perfectly flat series (stale feed, not risk-free)", () => {
    const flat = Array.from({ length: 30 }, (_, i) => ({
      timestamp: 1_000 * HOUR + i * HOUR,
      price: 50,
    }));
    const res = annualizedVarianceFromSnapshots(flat, 1_000 * HOUR + 30 * HOUR, 48);
    expect(res.variance).toBeNull();
  });

  it("ignores non-positive prices", () => {
    const snaps = [
      ...hourlySeries([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112]),
      { timestamp: 1_000 * HOUR + 13 * HOUR, price: 0 },
    ];
    const res = annualizedVarianceFromSnapshots(snaps, 1_000 * HOUR + 13 * HOUR, 48);
    expect(res.variance).not.toBeNull();
  });
});

describe("estimateLvrEdge", () => {
  it("σ²/8 drag: 50% vol pool needs ~3.1% fee yield to break even", () => {
    // σ = 0.5 ⇒ σ² = 0.25 ⇒ σ²/8 = 0.03125.
    expect(estimateLvrEdge({ annualizedFeeYield: 0.03125, annualizedVariance: 0.25 })).toBeCloseTo(0, 10);
    expect(estimateLvrEdge({ annualizedFeeYield: 0.02, annualizedVariance: 0.25 })).toBeLessThan(0);
  });

  it("high-vol meme regime is structurally unenterable at realistic fee yields", () => {
    // STACK-type: 150% annualized vol, even a stellar 20% fee yield loses.
    const edge = estimateLvrEdge({ annualizedFeeYield: 0.2, annualizedVariance: 2.25 });
    expect(edge).toBeLessThan(0);
    expect(edge).toBeCloseTo(0.2 - 2.25 / 8, 10);
  });

  it("stable pair with modest fees is comfortably positive", () => {
    // 8% vol, 15% fee yield ⇒ edge ≈ 0.15 − 0.0008.
    const edge = estimateLvrEdge({ annualizedFeeYield: 0.15, annualizedVariance: 0.0064 });
    expect(edge).toBeGreaterThan(0.14);
  });
});
