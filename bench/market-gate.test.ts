import { describe, it, expect } from "vitest";
import {
  gateAndRankMarketPools,
  marketLegPasses,
  SOL_MINT,
  type MarketGateConfig,
} from "../engine/market-gate.js";
import type { DiscoveredPool } from "../engine/services.js";

const config: MarketGateConfig = {
  minTvlUsd: 1000,
  minFeeApr: 5,
  minVolumeTurnover: 0.5,
  maxVolumeTurnover: 10,
  minHolders: 100,
  minBinStep: 1,
  maxBinStep: 100,
  stablecoinMints: new Set(["USDC", "USDT"]),
};

function pool(overrides: Partial<DiscoveredPool>): DiscoveredPool {
  return {
    address: "pool1",
    tvlUsd: 100_000,
    volume24hUsd: 100_000, // turnover 1.0, inside [0.5, 10]
    fees24hUsd: 100, // fee APR 36.5% >= 5
    apr: 10,
    binStep: 10,
    tokenX: SOL_MINT,
    tokenY: "USDC",
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    ...overrides,
  };
}

describe("marketLegPasses", () => {
  it("always passes stablecoins and SOL", () => {
    expect(marketLegPasses({ isStableOrSol: true, verified: undefined, freezeDisabled: undefined, holders: undefined }, 100)).toBe(true);
  });

  it("passes verified + freeze-disabled regardless of holders", () => {
    expect(marketLegPasses({ isStableOrSol: false, verified: true, freezeDisabled: true, holders: 0 }, 100)).toBe(true);
  });

  it("passes verified + freeze-enabled only when holders >= min (or absent)", () => {
    expect(marketLegPasses({ isStableOrSol: false, verified: true, freezeDisabled: false, holders: 1000 }, 100)).toBe(true);
    expect(marketLegPasses({ isStableOrSol: false, verified: true, freezeDisabled: false, holders: 50 }, 100)).toBe(false);
    expect(marketLegPasses({ isStableOrSol: false, verified: true, freezeDisabled: false, holders: undefined }, 100)).toBe(true);
  });

  it("rejects unverified + known freeze-enabled", () => {
    expect(marketLegPasses({ isStableOrSol: false, verified: false, freezeDisabled: false, holders: 9999 }, 100)).toBe(false);
  });

  it("passes unverified + freeze-disabled with enough holders (or absent)", () => {
    expect(marketLegPasses({ isStableOrSol: false, verified: false, freezeDisabled: true, holders: 500 }, 100)).toBe(true);
    expect(marketLegPasses({ isStableOrSol: false, verified: false, freezeDisabled: true, holders: 50 }, 100)).toBe(false);
    expect(marketLegPasses({ isStableOrSol: false, verified: false, freezeDisabled: true, holders: undefined }, 100)).toBe(true);
  });
});

describe("gateAndRankMarketPools", () => {
  it("ranks admissible pools by composite score (fee APR × liquidity factor)", () => {
    const lowFees = pool({ address: "low", tvlUsd: 100_000, fees24hUsd: 50, volume24hUsd: 100_000 });
    const highFees = pool({ address: "high", tvlUsd: 100_000, fees24hUsd: 500, volume24hUsd: 100_000 });
    const result = gateAndRankMarketPools([lowFees, highFees], config);
    expect(result.rejected).toHaveLength(0);
    expect(result.ranked.map((r) => r.pool.address)).toEqual(["high", "low"]);
    expect(result.ranked[0]!.notes.join(" ")).toContain("fee APR");
  });

  it("rejects pools below the min TVL", () => {
    const result = gateAndRankMarketPools([pool({ address: "tiny", tvlUsd: 100 })], config);
    expect(result.ranked).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain("tvl");
  });

  it("rejects pools with no 24h fees or non-finite TVL", () => {
    const result = gateAndRankMarketPools(
      [
        pool({ address: "nofees", fees24hUsd: 0 }),
        pool({ address: "nontvl", tvlUsd: Number.NaN }),
      ],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toContain("no 24h fees");
  });

  it("rejects pools below min fee APR and below/above volume turnover", () => {
    // fee APR = 100*365*100/100000 = 36.5% — vary turnover to trigger gates.
    const lowTurnover = pool({ address: "lowturn", volume24hUsd: 100 }); // 0.001 turnover
    const highTurnover = pool({ address: "highturn", volume24hUsd: 2_000_000 }); // 20 turnover
    const result = gateAndRankMarketPools([lowTurnover, highTurnover], config);
    expect(result.rejected.some((r) => r.reason.includes("volume turnover"))).toBe(true);
  });

  it("rejects pools whose bin step is out of range or non-integer", () => {
    const result = gateAndRankMarketPools(
      [
        pool({ address: "fine", binStep: 0 }),
        pool({ address: "coarse", binStep: 1000 }),
        pool({ address: "frac", binStep: 1.5 }),
      ],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(result.rejected.some((r) => r.reason.includes("binStep"))).toBe(true);
  });

  it("rejects pools with a failing token-safety leg", () => {
    const badX = pool({ tokenX: "SHIT", tokenXVerified: false, tokenXFreezeDisabled: false, tokenXHolders: 5 });
    const badY = pool({ tokenY: "SHIT2", tokenYVerified: false, tokenYFreezeDisabled: false, tokenYHolders: 5 });
    const result = gateAndRankMarketPools([badX, badY], config);
    expect(result.ranked).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain("fails token safety");
  });

  it("passes a token whose mint is SOL even when metadata is absent", () => {
    const result = gateAndRankMarketPools([pool({})], config);
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0]!.pool.tokenX).toBe(SOL_MINT);
  });
});