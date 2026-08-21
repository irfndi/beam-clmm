import { describe, expect, it } from "vitest";
import { enrichPoolFromKrystal, type KrystalPoolStats } from "../engine/krystal-service.js";
import type { PoolState } from "../engine/types.js";

const pool: PoolState = {
  address: "0xpool",
  tokenX: "0xaaa",
  tokenY: "0xbbb",
  tokenXSymbol: "TOKEN",
  tokenYSymbol: "TOKEN",
  tvlUsd: 1,
  volume24hUsd: 0,
  fees24hUsd: 0,
  apr: 0,
  activeBinId: 0,
  binStep: 1,
  currentPrice: 1,
  timestamp: 1,
};

const stats: KrystalPoolStats = {
  tvlUsd: 100,
  volume24hUsd: 200,
  feeUsd24h: 3,
  apr: 10,
  drawdown24h: -1,
  priceVolatility: 2,
  feeTier: 3000,
  lpFee: 0.003,
  dynamicFee: false,
  protocolFee: 0,
  token0Symbol: "ETH",
  token1Symbol: "USDG",
  token0Address: "0xbbb",
  token1Address: "0xaaa",
};

describe("Krystal pool enrichment", () => {
  it("maps Krystal leg symbols to the adapter token order", () => {
    const enriched = enrichPoolFromKrystal(pool, stats);
    expect(enriched.tokenXSymbol).toBe("USDG");
    expect(enriched.tokenYSymbol).toBe("ETH");
    expect(enriched.statsSource).toBe("krystal");
  });
});
