import { describe, expect, it } from "vitest";
import {
  computeEntryHodlLegsUsd,
  normalizeStoredDrawdown,
  reconstructedDrawdown24h,
} from "../ops/mark-backtest-math.js";
import { verifiedUsdPair } from "../ops/verified-usd-price.js";

describe("mark backtest math", () => {
  it("derives the concentrated-range entry mix instead of assuming 50/50", () => {
    const pair = verifiedUsdPair("ETH", "USDG");
    expect(pair).not.toBeNull();
    const legs = computeEntryHodlLegsUsd({
      depositedUsd: 1_000,
      entryPriceUsd: 1_500,
      lowerBinId: 6_900,
      upperBinId: 7_200,
      usdPair: pair!,
    });
    expect(legs).not.toBeNull();
    expect(legs!.movingUsd + legs!.numeraireUsd).toBeCloseTo(1_000, 8);
    expect(legs!.movingUsd).not.toBeCloseTo(500, 2);
  });

  it("normalizes stored percentage points and fractions consistently", () => {
    expect(normalizeStoredDrawdown(-5)).toBeCloseTo(-0.05);
    expect(normalizeStoredDrawdown(-0.05)).toBeCloseTo(-0.05);
    expect(normalizeStoredDrawdown(null)).toBeNull();
  });

  it("measures inverse stable-pair drawdown in USD direction", () => {
    const pair = verifiedUsdPair("USDG", "ETH");
    expect(pair).not.toBeNull();
    const snapshots = [
      { timestamp: 0, currentPrice: 1 / 1_900e-9, usdPair: pair },
      { timestamp: 60_000, currentPrice: 1 / 1_800e-9, usdPair: pair },
    ];
    expect(reconstructedDrawdown24h(snapshots, 1, 24 * 3_600_000)).toBeCloseTo(-100 / 1_900, 6);
  });
});
