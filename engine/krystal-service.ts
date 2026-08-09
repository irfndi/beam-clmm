import { Effect, Layer } from "effect";
import { KrystalService, type KrystalApi } from "./services.js";
import type { PoolState } from "./types.js";
import { createLogger } from "./logger.js";

/**
 * Krystal LP explorer — the primary pool-stats source on Robinhood Chain.
 *
 * Unlike gecko (whose CL-pool fee fields are null → fees become a modeled
 * binStep rate) and the legacy datapi (chain-specific), Krystal reports
 * MEASURED on-chain fee income: `stat24h.feeUsd = volumeUsd × lpFee`,
 * verified exactly against raw v4 PoolManager Swap events (2026-08-09:
 * CASHCAT 1.104% on every swap; the ETH/USDG dynamic pool's volume-weighted
 * ~1.4% → 18–26%/day of TVL). Krystal is the only measured-fee source on
 * this chain, so `statsSource: "krystal"` re-enables the fee/IL gate and the
 * weighted-entry-score fee term (feeIlRatioKnown = true).
 *
 * It also carries the challenge strategy's risk signals: `drawdown24h` and
 * `priceVolatility`.
 *
 * One `top_pools` call (limit 500 + skipCheckAutomation=true — REQUIRED, the
 * automation-supported anchor pools are invisible without it) refreshes the
 * whole universe; the 10-min TTL matches Krystal's own ~5–15 min cache
 * rebuild. `offset`/`orderBy` are ignored by the API — never paginate.
 */

const logger = createLogger("krystal");

const DEFAULT_API_URL = "https://api.krystal.app";
const UNIVERSE_TTL_MS = 10 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

// ─── Response types ───────────────────────────────────────────────────────────

export interface KrystalPoolStats {
  readonly tvlUsd: number;
  readonly volume24hUsd: number;
  readonly feeUsd24h: number;
  readonly apr: number;
  readonly drawdown24h: number;
  readonly priceVolatility: number;
  readonly feeTier: number;
  readonly lpFee: number;
  readonly dynamicFee: boolean;
  readonly protocolFee: number;
  readonly token0Symbol: string;
  readonly token1Symbol: string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ─── Response parsing (live-verified semantics) ──────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Parse one top_pools entry → KrystalPoolStats. Returns null on shape drift
 *  (the caller fails through to gecko/heuristic — never crashes the cycle). */
export function parseKrystalPool(raw: unknown): KrystalPoolStats | null {
  if (!isObject(raw)) return null;
  const stat24h = isObject(raw.stat24h) ? raw.stat24h : {};
  const token0 = isObject(raw.token0) ? raw.token0 : {};
  const token1 = isObject(raw.token1) ? raw.token1 : {};
  const tvlUsd = readFiniteNumber(raw.tvlUsd);
  if (tvlUsd === null || tvlUsd <= 0) return null;
  const volume24hUsd = readFiniteNumber(stat24h.volumeUsd) ?? 0;
  const feeUsd24h = readFiniteNumber(stat24h.feeUsd) ?? 0;
  return {
    tvlUsd,
    volume24hUsd,
    feeUsd24h,
    apr: readFiniteNumber(stat24h.apr) ?? 0,
    drawdown24h: readFiniteNumber(raw.drawdown24h) ?? 0,
    priceVolatility: readFiniteNumber(raw.priceVolatility) ?? 0,
    feeTier: readFiniteNumber(raw.feeTier) ?? 0,
    lpFee: readFiniteNumber(raw.lpFee) ?? 0,
    dynamicFee: raw.dynamicFee === true,
    protocolFee: readFiniteNumber(raw.protocolFee) ?? 0,
    token0Symbol: typeof token0.symbol === "string" ? token0.symbol : "",
    token1Symbol: typeof token1.symbol === "string" ? token1.symbol : "",
  };
}

// ─── Pool enrichment (source-aware) ──────────────────────────────────────────

/**
 * Replace heuristic tvl/volume/fees with MEASURED Krystal values. Mirrors
 * enrichPoolFromGecko but keeps the measured fee income (not a model) and
 * carries drawdown24h/priceVolatility for the strategy.
 */
export function enrichPoolFromKrystal(pool: PoolState, stats: KrystalPoolStats): PoolState {
  return {
    ...pool,
    tvlUsd: stats.tvlUsd > 0 ? stats.tvlUsd : pool.tvlUsd,
    volume24hUsd: stats.volume24hUsd,
    fees24hUsd: stats.feeUsd24h,
    apr: stats.apr,
    drawdown24h: stats.drawdown24h,
    priceVolatility: stats.priceVolatility,
    statsSource: "krystal",
  };
}

// ─── Fetcher (cached universe, never throws) ─────────────────────────────────

interface UniverseCache {
  readonly fetchedAt: number;
  readonly pools: ReadonlyMap<string, KrystalPoolStats>;
}

let universeCache: UniverseCache | null = null;

/** TEST-ONLY: clear the universe cache between tests. */
export function clearKrystalCache(): void {
  universeCache = null;
}

export async function fetchKrystalUniverse(
  options: { readonly baseUrl?: string; readonly fetchImpl?: FetchLike } = {},
): Promise<ReadonlyMap<string, KrystalPoolStats>> {
  const now = Date.now();
  if (universeCache !== null && now - universeCache.fetchedAt < UNIVERSE_TTL_MS) {
    return universeCache.pools;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? process.env.KRYSTAL_API_URL ?? DEFAULT_API_URL)
    .trim()
    .replace(/\/+$/, "");
  const url =
    `${base}/all/v2/lp_explorer/top_pools` +
    `?chainId=4663&protocols=uniswapv2,uniswapv3,uniswapv4&quoteSymbols=usd` +
    `&limit=500&skipCheckAutomation=true`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      logger.warn("Krystal universe fetch rejected", { status: response.status });
      return universeCache?.pools ?? new Map();
    }
    const raw: unknown = await response.json();
    const result = isObject(raw) ? raw.result : null;
    if (!Array.isArray(result)) {
      logger.warn("Krystal universe response malformed");
      return universeCache?.pools ?? new Map();
    }
    const pools = new Map<string, KrystalPoolStats>();
    for (const entry of result) {
      if (!isObject(entry) || typeof entry.poolAddress !== "string") continue;
      const stats = parseKrystalPool(entry);
      if (stats !== null) {
        pools.set(entry.poolAddress.toLowerCase(), stats);
      }
    }
    universeCache = { fetchedAt: Date.now(), pools };
    logger.info("Krystal universe refreshed", { count: pools.size });
    return pools;
  } catch (e) {
    logger.warn("Krystal universe fetch failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return universeCache?.pools ?? new Map();
  }
}

// ─── Effect service wiring ────────────────────────────────────────────────────

export const KrystalLive = Layer.succeed(KrystalService, {
  getPoolStats: (poolAddress: string): Effect.Effect<KrystalPoolStats | null, never> =>
    Effect.tryPromise(() =>
      fetchKrystalUniverse().then((pools) => pools.get(poolAddress.toLowerCase()) ?? null),
    ).pipe(Effect.catch(() => Effect.succeed(null))),
  getUniverse: (): Effect.Effect<ReadonlyMap<string, KrystalPoolStats>, never> =>
    Effect.tryPromise(() => fetchKrystalUniverse()).pipe(
      Effect.catch(() => Effect.succeed(new Map())),
    ),
} satisfies KrystalApi);
