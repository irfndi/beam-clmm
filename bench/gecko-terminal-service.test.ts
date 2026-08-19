import { describe, it, expect, beforeEach } from "vitest";
import {
  parseGeckoPoolStats,
  enrichPoolFromGecko,
  getGeckoPoolStats,
  clearGeckoCache,
  type GeckoPoolStats,
} from "../engine/gecko-terminal-service.js";
import type { PoolState } from "../engine/types.js";

const BASE_FEE_RATE = 0.0025;
type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue };

function pool(overrides: Partial<PoolState> = {}): PoolState {
  // SAFETY: the fixture supplies the PoolState fields consumed by Gecko enrichment.
  return {
    address: "0xpool",
    activeBinId: 5000,
    binStep: 10,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    currentPrice: 100,
    tvlUsd: 50_000,
    volume24hUsd: 1000,
    fees24hUsd: 10,
    apr: 5,
    hasFarm: false,
    farmAprPct: null,
    statsSource: "heuristic",
    ...overrides,
  } as PoolState;
}

// ─── parseGeckoPoolStats ──────────────────────────────────────────────────────

describe("parseGeckoPoolStats", () => {
  const attrs = (a: JsonObject) => ({ data: { attributes: a } });

  it("parses a valid payload with string numeric fields and derives fees from baseFeeRate", () => {
    const raw = attrs({
      volume_usd: { h24: "1000" },
      reserve_in_usd: "50000",
      pool_fee_percentage: null,
      base_token_price_usd: "1.5",
      quote_token_price_usd: "0.01",
    });
    const stats = parseGeckoPoolStats(raw, BASE_FEE_RATE);
    expect(stats).not.toBeNull();
    expect(stats!.volume24hUsd).toBe(1000);
    expect(stats!.tvlUsd).toBe(50000);
    expect(stats!.fees24hUsd).toBeCloseTo(1000 * BASE_FEE_RATE, 8);
    expect(stats!.basePriceUsd).toBe(1.5);
    expect(stats!.quotePriceUsd).toBe(0.01);
  });

  it("uses pool_fee_percentage (a percentage) when present, taking precedence", () => {
    const raw = attrs({
      volume_usd: { h24: 1000 },
      reserve_in_usd: 50000,
      pool_fee_percentage: 1, // 1% → fraction 0.01
    });
    const stats = parseGeckoPoolStats(raw, BASE_FEE_RATE);
    expect(stats!.fees24hUsd).toBeCloseTo(10, 8);
  });

  it("returns null for non-object / missing data / missing attributes / missing volume", () => {
    expect(parseGeckoPoolStats(null, BASE_FEE_RATE)).toBeNull();
    expect(parseGeckoPoolStats({}, BASE_FEE_RATE)).toBeNull();
    expect(parseGeckoPoolStats({ data: null }, BASE_FEE_RATE)).toBeNull();
    expect(parseGeckoPoolStats({ data: { attributes: null } }, BASE_FEE_RATE)).toBeNull();
    expect(parseGeckoPoolStats(attrs({}), BASE_FEE_RATE)).toBeNull();
  });

  it("rejects non-positive or missing volume entirely", () => {
    expect(parseGeckoPoolStats(attrs({ volume_usd: { h24: 0 } }), BASE_FEE_RATE)).toBeNull();
    expect(parseGeckoPoolStats(attrs({ volume_usd: { h24: -5 } }), BASE_FEE_RATE)).toBeNull();
    expect(parseGeckoPoolStats(attrs({ volume_usd: { h24: "bad" } }), BASE_FEE_RATE)).toBeNull();
  });

  it("nulls a non-positive reserve (treats TVL as unavailable)", () => {
    const stats = parseGeckoPoolStats(
      attrs({ volume_usd: { h24: 1000 }, reserve_in_usd: 0 }),
      BASE_FEE_RATE,
    );
    expect(stats).not.toBeNull();
    expect(stats!.tvlUsd).toBeNull();
  });

  it("keeps a positive reserve and nulls absent token prices", () => {
    const stats = parseGeckoPoolStats(
      attrs({ volume_usd: { h24: 1000 }, reserve_in_usd: 50000 }),
      BASE_FEE_RATE,
    );
    expect(stats!.tvlUsd).toBe(50000);
    expect(stats!.basePriceUsd).toBeNull();
  });
});

// ─── enrichPoolFromGecko ──────────────────────────────────────────────────────

describe("enrichPoolFromGecko", () => {
  const stats: GeckoPoolStats = {
    tvlUsd: 100_000,
    volume24hUsd: 5000,
    fees24hUsd: 12.5,
    basePriceUsd: null,
    quotePriceUsd: null,
  };

  it("replaces tvl/volume/fees and recomputes APR, tagging statsSource geckoterminal", () => {
    const enriched = enrichPoolFromGecko(pool(), stats);
    expect(enriched.tvlUsd).toBe(100_000);
    expect(enriched.volume24hUsd).toBe(5000);
    expect(enriched.fees24hUsd).toBe(12.5);
    expect(enriched.statsSource).toBe("geckoterminal");
    // APR = (12.5 * 365 / 100000) * 100
    expect(enriched.apr).toBeCloseTo(((12.5 * 365) / 100000) * 100, 6);
  });

  it("clears farm signals and keeps the original APR when TVL/fees are non-positive", () => {
    const enriched = enrichPoolFromGecko(pool({ apr: 42 }), {
      ...stats,
      tvlUsd: 0,
      fees24hUsd: 0,
    });
    expect(enriched.apr).toBe(42);
    expect(enriched.tvlUsd).toBe(50_000); // falls back to original pool tvl
    expect(enriched.hasFarm).toBeNull();
    expect(enriched.farmAprPct).toBeNull();
  });

  it("keeps the original APR when tvlUsd is null", () => {
    const enriched = enrichPoolFromGecko(pool({ apr: 9 }), { ...stats, tvlUsd: null });
    expect(enriched.apr).toBe(9);
  });
});

// ─── getGeckoPoolStats ────────────────────────────────────────────────────────

describe("getGeckoPoolStats", () => {
  beforeEach(() => clearGeckoCache());

  const okBody = {
    data: {
      attributes: {
        volume_usd: { h24: "1000" },
        reserve_in_usd: "50000",
        pool_fee_percentage: null,
      },
    },
  };

  it("fetches and returns parsed stats on success", async () => {
    const fetchImpl = async () => Response.json(okBody);
    const stats = await getGeckoPoolStats("0xpool", { baseFeeRate: BASE_FEE_RATE, fetchImpl });
    expect(stats).not.toBeNull();
    expect(stats!.volume24hUsd).toBe(1000);
    expect(stats!.tvlUsd).toBe(50000);
  });

  it("returns null on a non-ok HTTP status", async () => {
    const fetchImpl = async () => new Response("nf", { status: 404 });
    const stats = await getGeckoPoolStats("0xpool", { baseFeeRate: BASE_FEE_RATE, fetchImpl });
    expect(stats).toBeNull();
  });

  it("returns null on an unparseable payload", async () => {
    const fetchImpl = async () => Response.json({ data: null });
    const stats = await getGeckoPoolStats("0xpool", { baseFeeRate: BASE_FEE_RATE, fetchImpl });
    expect(stats).toBeNull();
  });

  it("returns null when the reserve is missing (treats stats as unavailable)", async () => {
    const fetchImpl = async () =>
      Response.json({ data: { attributes: { volume_usd: { h24: 1000 } } } });
    const stats = await getGeckoPoolStats("0xpool", { baseFeeRate: BASE_FEE_RATE, fetchImpl });
    expect(stats).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchImpl = async () => {
      throw new Error("down");
    };
    const stats = await getGeckoPoolStats("0xpool", { baseFeeRate: BASE_FEE_RATE, fetchImpl });
    expect(stats).toBeNull();
  });
});
