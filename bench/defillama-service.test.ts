import { describe, it, expect, beforeEach } from "vitest";
import {
  buildUniverse,
  clearDefiLlamaCache,
  enrichPoolFromDefiLlama,
  getDefiLlamaPoolStats,
  pairKey,
  parseFeeTierPct,
  tickSpacingToFeeTierPct,
} from "../engine/defillama-service.js";
import type { PoolState } from "../engine/types.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const V3_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
// A v4 pool id is a bytes32, not a 20-byte address.
const V4_ID = "0x0590e03f159b40055b4f9423f23bdd814edac2f340d6afed1280dee36c30effe";

type DlRow = {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  volumeUsd1d: number | null;
  apyBase: number | null;
  poolMeta: string | null;
  underlyingTokens: ReadonlyArray<string>;
  pool: string;
};

function row(overrides: Partial<DlRow> = {}): DlRow {
  return {
    chain: "Base",
    project: "uniswap-v3",
    symbol: "WETH-USDC",
    tvlUsd: 8_545_369,
    volumeUsd1d: 15_712_826,
    apyBase: 33.55725,
    poolMeta: "0.05%",
    underlyingTokens: [USDC, WETH],
    pool: "8b3cadb9-b9f1-4539-998c-18c02e9e65a0",
    ...overrides,
  };
}

function payload(rows: ReadonlyArray<unknown>) {
  return { data: rows };
}

describe("parseFeeTierPct", () => {
  it("converts a percentage label to its numeric percent", () => {
    expect(parseFeeTierPct("0.05%")).toBe(0.05);
    expect(parseFeeTierPct("1%")).toBe(1);
    expect(parseFeeTierPct(" 0.3 % ")).toBe(0.3);
  });

  it("rejects non-percentage labels", () => {
    expect(parseFeeTierPct("stable")).toBeNull();
    expect(parseFeeTierPct(null)).toBeNull();
    expect(parseFeeTierPct(3)).toBeNull();
    expect(parseFeeTierPct("0%")).toBeNull();
  });
});

describe("tickSpacingToFeeTierPct", () => {
  it("maps the Uniswap v3 ladder and refuses unknown spacings", () => {
    expect(tickSpacingToFeeTierPct(1)).toBe(0.01);
    expect(tickSpacingToFeeTierPct(10)).toBe(0.05);
    expect(tickSpacingToFeeTierPct(60)).toBe(0.3);
    expect(tickSpacingToFeeTierPct(200)).toBe(1);
    expect(tickSpacingToFeeTierPct(400)).toBeNull();
    expect(tickSpacingToFeeTierPct(0)).toBeNull();
  });
});

describe("pairKey", () => {
  it("is order independent and case insensitive", () => {
    expect(pairKey(WETH, USDC)).toBe(pairKey(USDC.toLowerCase(), WETH.toLowerCase()));
  });
});

describe("buildUniverse", () => {
  it("keeps only Base uniswap-v3 rows with fee, volume and apy data", () => {
    const byKey = buildUniverse(
      payload([
        row(),
        row({ chain: "Ethereum" }),
        row({ project: "uniswap-v4" }),
        row({ apyBase: null }),
        row({ apyBase: 0 }),
        row({ volumeUsd1d: null }),
        row({ tvlUsd: 0 }),
        row({ poolMeta: "stable" }),
        row({ underlyingTokens: [WETH] }),
      ]),
      "Base",
    );
    expect(byKey.size).toBe(1);
    expect(byKey.get(`${pairKey(WETH, USDC)}|0.05`)?.length).toBe(1);
  });

  it("keeps duplicate keys as separate rows so the caller can see ambiguity", () => {
    const byKey = buildUniverse(payload([row(), row({ pool: "other-uuid" })]), "Base");
    expect(byKey.get(`${pairKey(WETH, USDC)}|0.05`)?.length).toBe(2);
  });

  it("returns an empty map for a malformed payload", () => {
    expect(buildUniverse(null, "Base").size).toBe(0);
    expect(buildUniverse({ data: "nope" }, "Base").size).toBe(0);
  });
});

describe("getDefiLlamaPoolStats", () => {
  beforeEach(() => clearDefiLlamaCache());

  const deps = (rows: ReadonlyArray<unknown>) => ({
    fetchImpl: async () => Response.json(payload(rows)),
  });

  it("returns measured stats derived from apyBase for the single matching pool", async () => {
    const stats = await getDefiLlamaPoolStats(
      {
        poolAddress: V3_POOL,
        tokenX: WETH,
        tokenY: USDC,
        tickSpacing: 10,
      },
      deps([row()]),
    );
    expect(stats).not.toBeNull();
    expect(stats!.tvlUsd).toBe(8_545_369);
    expect(stats!.volume24hUsd).toBe(15_712_826);
    expect(stats!.apyBasePct).toBeCloseTo(33.55725, 5);
    // fees = tvl × apyBase / 100 / 365
    expect(stats!.fees24hUsd).toBeCloseTo((8_545_369 * 33.55725) / 100 / 365, 6);
  });

  it("refuses an ambiguous pair+tier instead of picking a row", async () => {
    const stats = await getDefiLlamaPoolStats(
      { poolAddress: V3_POOL, tokenX: WETH, tokenY: USDC, tickSpacing: 10 },
      deps([row(), row({ pool: "second-uuid", tvlUsd: 9_000_000 })]),
    );
    expect(stats).toBeNull();
  });

  it("never matches a v4 pool id against v3 rows", async () => {
    const stats = await getDefiLlamaPoolStats(
      { poolAddress: V4_ID, tokenX: WETH, tokenY: USDC, tickSpacing: 10 },
      deps([row()]),
    );
    expect(stats).toBeNull();
  });

  it("returns null for an unmapped tick spacing or a tier with no row", async () => {
    const base = { poolAddress: V3_POOL, tokenX: WETH, tokenY: USDC };
    expect(await getDefiLlamaPoolStats({ ...base, tickSpacing: 400 }, deps([row()]))).toBeNull();
    expect(await getDefiLlamaPoolStats({ ...base, tickSpacing: 60 }, deps([row()]))).toBeNull();
  });

  it("ignores a row that lacks fee or volume data", async () => {
    const stats = await getDefiLlamaPoolStats(
      { poolAddress: V3_POOL, tokenX: WETH, tokenY: USDC, tickSpacing: 10 },
      deps([row({ apyBase: null })]),
    );
    expect(stats).toBeNull();
  });

  it("returns null when the fetch fails and never throws", async () => {
    const stats = await getDefiLlamaPoolStats(
      { poolAddress: V3_POOL, tokenX: WETH, tokenY: USDC, tickSpacing: 10 },
      {
        fetchImpl: async () => {
          throw new Error("down");
        },
      },
    );
    expect(stats).toBeNull();
  });

  it("reuses one cached universe across calls", async () => {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return Response.json(payload([row()]));
    };
    const input = { poolAddress: V3_POOL, tokenX: WETH, tokenY: USDC, tickSpacing: 10 };
    await getDefiLlamaPoolStats(input, { fetchImpl: counting });
    await getDefiLlamaPoolStats(input, { fetchImpl: counting });
    expect(calls).toBe(1);
  });
});

describe("enrichPoolFromDefiLlama", () => {
  // SAFETY: the fixture supplies the PoolState fields this enrichment reads;
  // the production type carries many more optional fields.
  const pool = {
    address: V3_POOL,
    activeBinId: 1,
    binStep: 10,
    tokenX: WETH,
    tokenY: USDC,
    tokenXSymbol: "WETH",
    tokenYSymbol: "USDC",
    currentPrice: 2500,
    tvlUsd: 1,
    volume24hUsd: 1,
    fees24hUsd: 1,
    apr: 5,
    hasFarm: null,
    farmAprPct: null,
    statsSource: "geckoterminal",
  } as PoolState;

  it("replaces tvl/volume/fees, recomputes APR and tags the measured source", () => {
    const enriched = enrichPoolFromDefiLlama(pool, {
      tvlUsd: 100_000,
      volume24hUsd: 500_000,
      fees24hUsd: 100,
      apyBasePct: 36.5,
    });
    expect(enriched.statsSource).toBe("defillama");
    expect(enriched.tvlUsd).toBe(100_000);
    expect(enriched.volume24hUsd).toBe(500_000);
    expect(enriched.fees24hUsd).toBe(100);
    expect(enriched.apr).toBeCloseTo(((100 * 365) / 100_000) * 100, 6);
  });
});
