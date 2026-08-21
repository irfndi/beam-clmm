import { describe, it, expect } from "vitest";
import { computeClmmValueUsd } from "../engine/pnl.js";
import { rawTickToUsd, verifiedUsdPair } from "../ops/verified-usd-price.js";

// Exact Uniswap v3/v4 CLMM IL math (square-root price bounds). The mark is
// range-aware: below Pa the LP is 100% token0, above Pb 100% token1, and the
// value plateaus outside the range while the HODL benchmark keeps moving —
// so IL keeps growing after the price exits the range.
//
// Fixture: entry price 150, range ticks [49907, 50307] → prices [147.00, 153.00]
// (a symmetric ~±2% range). L is anchored so the LP value at 150 equals the
// deposited $1000.

describe("computeClmmValueUsd", () => {
  const base = {
    depositedUsd: 1000,
    entryPriceUsd: 150,
    lowerBinId: 49907,
    upperBinId: 50307,
    currentPriceUsd: 150,
  };

  it("equals the cost basis at the entry price", () => {
    expect(computeClmmValueUsd({ ...base, currentPriceUsd: 150 })).toBeCloseTo(1000, 2);
  });

  it("is lower than HODL inside the range (real IL)", () => {
    // At price 147 (lower bound), HODL = 500*(147/150)+500 = 990; the CLMM
    // LP is worth 985.02 — the spread is the in-range impermanent loss.
    expect(computeClmmValueUsd({ ...base, currentPriceUsd: 147 })).toBeCloseTo(985.02, 2);
  });

  it("plateaus above the range (all token1) while HODL keeps climbing", () => {
    // At 165 (above Pb=153) the LP is 100% token1, value = L·(√Pb−√Pa)=1004.93.
    // HODL at 165 = 1050, so IL = 45.07 and keeps growing as price pumps.
    expect(computeClmmValueUsd({ ...base, currentPriceUsd: 165 })).toBeCloseTo(1004.93, 2);
  });

  it("is all token0 below the range (value tracks token0 price)", () => {
    // At 135 (below Pa=147) the LP is 100% token0: value = L·(1/√Pa−1/√Pb)·P.
    expect(computeClmmValueUsd({ ...base, currentPriceUsd: 135 })).toBeCloseTo(904.61, 2);
  });

  it("returns null on degenerate inputs", () => {
    expect(computeClmmValueUsd({ ...base, currentPriceUsd: 0 })).toBeNull();
    expect(computeClmmValueUsd({ ...base, entryPriceUsd: 0 })).toBeNull();
    expect(computeClmmValueUsd({ ...base, depositedUsd: 0 })).toBeNull();
    expect(computeClmmValueUsd({ ...base, lowerBinId: 50307, upperBinId: 49907 })).toBeNull();
    expect(computeClmmValueUsd({ ...base, currentPriceUsd: Number.NaN })).toBeNull();
  });

  it("accepts decimal-aware USD bounds for unequal-decimal pairs", () => {
    const pair = verifiedUsdPair("ETH", "USDG");
    expect(pair).not.toBeNull();
    const lowerPriceUsd = rawTickToUsd(-205_000, pair!);
    const upperPriceUsd = rawTickToUsd(-201_000, pair!);
    const currentPriceUsd = rawTickToUsd(-203_000, pair!);
    expect(lowerPriceUsd).not.toBeNull();
    expect(upperPriceUsd).not.toBeNull();
    expect(currentPriceUsd).not.toBeNull();
    const corrected = computeClmmValueUsd({
      depositedUsd: 1_000,
      entryPriceUsd: 1_500,
      lowerBinId: -205_000,
      upperBinId: -201_000,
      currentPriceUsd: currentPriceUsd!,
      lowerPriceUsd: lowerPriceUsd!,
      upperPriceUsd: upperPriceUsd!,
    });
    expect(corrected).not.toBeNull();
    expect(corrected).not.toBeCloseTo(1_000, 3);
  });
});
