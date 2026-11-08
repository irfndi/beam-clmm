import { describe, it, expect, beforeEach } from "vitest";
import {
  parseGeckoPoolStats,
  enrichPoolFromGecko,
  getGeckoPoolStats,
  prefetchGeckoPools,
  isGeckoRateLimited,
  clearGeckoCache,
  setGeckoRequestIntervalMsForTests,
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

// ─── prefetchGeckoPools (batched /pools/multi) ────────────────────────────────

describe("prefetchGeckoPools", () => {
  beforeEach(() => {
    clearGeckoCache();
    setGeckoRequestIntervalMsForTests(0);
  });

  const address = (i: number): string => `0x${i.toString(16).padStart(40, "0")}`;

  type PoolRowAttributes = {
    address: string;
    volume_usd: { h24: string | number };
    pool_fee_percentage: null;
    base_token_price_usd: string;
    quote_token_price_usd: string;
    reserve_in_usd?: string | number;
  };

  function poolRow(addr: string, h24: string | number, reserve: string | number | null) {
    const base: PoolRowAttributes = {
      address: addr,
      volume_usd: { h24 },
      pool_fee_percentage: null,
      base_token_price_usd: "1.0",
      quote_token_price_usd: "2500",
    };
    const attributes: PoolRowAttributes =
      reserve === null ? base : { ...base, reserve_in_usd: reserve };
    return { id: `base_${addr}`, attributes };
  }

  function requestUrl(input: string | URL | Request): string {
    if (input instanceof Request) return input.url;
    if (input instanceof URL) return input.href;
    return input;
  }

  function captureBatchFetch(rows: ReadonlyArray<unknown>) {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      calls.push(requestUrl(input));
      return Response.json({ data: rows });
    };
    return { calls, fetchImpl };
  }

  it("resolves a whole scan set with ONE multi request and serves per-pool reads from cache", async () => {
    const addrs = [
      address(1),
      address(2),
      address(3),
      address(4),
      address(5),
      address(6),
      address(7),
    ];
    const { calls, fetchImpl } = captureBatchFetch(
      addrs.map((a, i) => poolRow(a, 1000 * (i + 1), 50_000)),
    );

    const result = await prefetchGeckoPools(addrs, { fetchImpl });
    expect(result.requests).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/networks/");
    expect(calls[0]).toContain("/pools/multi/");
    expect(calls[0]!.split("/multi/")[1]!.split(",")).toHaveLength(7);

    // Per-pool reads hit the warmed cache: no further requests, and the
    // caller-supplied base fee rate is applied on read.
    let laterCalls = 0;
    const noNetwork = async () => {
      laterCalls += 1;
      return Response.json({ data: null });
    };
    const stats = await getGeckoPoolStats(addrs[2]!, {
      baseFeeRate: 0.003,
      fetchImpl: noNetwork,
    });
    expect(laterCalls).toBe(0);
    expect(stats!.volume24hUsd).toBe(3000);
    expect(stats!.fees24hUsd).toBeCloseTo(3000 * 0.003, 8);
  });

  it("chunks at the 30-address API cap (40 pools → 30 + 10)", async () => {
    const addrs = Array.from({ length: 40 }, (_, i) => address(i + 1));
    const { calls, fetchImpl } = captureBatchFetch(addrs.map((a) => poolRow(a, 500, 100_000)));

    const result = await prefetchGeckoPools(addrs, { fetchImpl });
    expect(result.requests).toBe(2);
    const sizes = calls.map((c) => c.split("/multi/")[1]!.split(",").length);
    expect(sizes).toEqual([30, 10]);
  });

  it("caches zero-volume and untracked pools as unavailable (never marks them measured)", async () => {
    const tracked = address(11);
    const zeroVolume = address(12);
    const untracked = address(13);
    const { fetchImpl } = captureBatchFetch([
      poolRow(tracked, 1000, 50_000),
      poolRow(zeroVolume, 0, 50_000),
      // `untracked` is absent from the response entirely.
    ]);

    await prefetchGeckoPools([tracked, zeroVolume, untracked], { fetchImpl });

    const never = async () => {
      throw new Error("network must not be hit for cached entries");
    };
    expect(
      await getGeckoPoolStats(tracked, { baseFeeRate: BASE_FEE_RATE, fetchImpl: never }),
    ).not.toBeNull();
    expect(
      await getGeckoPoolStats(zeroVolume, { baseFeeRate: BASE_FEE_RATE, fetchImpl: never }),
    ).toBeNull();
    expect(
      await getGeckoPoolStats(untracked, { baseFeeRate: BASE_FEE_RATE, fetchImpl: never }),
    ).toBeNull();
  });

  it("dedupes repeated and differently-cased addresses into one request", async () => {
    const a = address(21);
    const { calls, fetchImpl } = captureBatchFetch([poolRow(a, 1000, 50_000)]);
    await prefetchGeckoPools([a, a.toUpperCase().replace("0X", "0x"), a], { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.split("/multi/")[1]!.split(",")).toHaveLength(1);
  });

  it("stands down for the cooldown after a 429 instead of retrying per pool", async () => {
    const addrs = [address(31), address(32)];
    let calls = 0;
    const rateLimited = async () => {
      calls += 1;
      return new Response("slow down", { status: 429 });
    };

    const result = await prefetchGeckoPools(addrs, { fetchImpl: rateLimited });
    expect(result.requests).toBe(1);
    expect(isGeckoRateLimited()).toBe(true);

    // Both the batch path and the single-pool path stay local while cooling down.
    expect(await prefetchGeckoPools(addrs, { fetchImpl: rateLimited })).toMatchObject({
      requests: 0,
    });
    expect(
      await getGeckoPoolStats(addrs[0]!, { baseFeeRate: BASE_FEE_RATE, fetchImpl: rateLimited }),
    ).toBeNull();
    expect(calls).toBe(1);

    // Clearing the cache (operator/restart path) also clears the cooldown.
    clearGeckoCache();
    expect(isGeckoRateLimited()).toBe(false);
  });

  it("returns without a request when every address is already cached fresh", async () => {
    const addrs = [address(41)];
    const { fetchImpl } = captureBatchFetch([poolRow(addrs[0]!, 1000, 50_000)]);
    await prefetchGeckoPools(addrs, { fetchImpl });

    let calls = 0;
    const counting = async () => {
      calls += 1;
      return Response.json({ data: [] });
    };
    const second = await prefetchGeckoPools(addrs, { fetchImpl: counting });
    expect(second.requests).toBe(0);
    expect(calls).toBe(0);
  });
});
