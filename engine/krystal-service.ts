import { Effect, Layer } from "effect";
import { KrystalService, type KrystalApi } from "./services.js";
import { registerV4Pool, type V4PoolKey } from "./adapter-service.js";
import type { PoolState } from "./types.js";
import { NATIVE_MINT } from "./constants.js";
import { createLogger } from "./logger.js";
import { ACTIVE_CHAIN_ID } from "./chain-registry.js";

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
  /** Normalized leg addresses (0xeeee… native → address(0), lowercase).
   *  Symbols on Robinhood Chain are unreliable ("TOKEN"/"TOKEN"), so the
   *  harvest-book native-pair filter keys off these. */
  readonly token0Address: string;
  readonly token1Address: string;
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
    token0Address:
      typeof token0.address === "string"
        ? normalizeNativeAddress(token0.address)
        : "",
    token1Address:
      typeof token1.address === "string"
        ? normalizeNativeAddress(token1.address)
        : "",
  };
}

/** Normalize a leg address for comparisons: Krystal renders native ETH as
 *  0xeeee…; the engine's isNative checks address(0). Lowercased. */
function normalizeNativeAddress(address: string): string {
  const lower = address.toLowerCase();
  return lower === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    ? NATIVE_MINT
    : lower;
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
// Last-known stats per pool, kept beyond the universe window — when a pool
// drops out of Krystal's top-500 (e.g. a crash collapsing its volume), the
// drawdown signal must NOT silently vanish (safety audit: the rotation gate
// disabled exactly when a pool starts crashing). Capped at ~2h freshness.
const lastKnownStats = new Map<string, { readonly stats: KrystalPoolStats; readonly at: number }>();
const LAST_KNOWN_TTL_MS = 2 * 60 * 60 * 1_000;

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
    `?chainId=${ACTIVE_CHAIN_ID}&protocols=uniswapv2,uniswapv3,uniswapv4&quoteSymbols=usd` +
    `&limit=500&skipCheckAutomation=true`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      logger.warn("Krystal universe fetch rejected", { status: response.status });
      // Safety: on fetch failure return the cache ONLY if reasonably fresh
      // (2x TTL) — a multi-day outage must not feed stale "measured" stats
      // into the drawdown/fee gates (safety audit).
      return universeCache !== null && now - universeCache.fetchedAt <= UNIVERSE_TTL_MS * 2
        ? universeCache.pools
        : new Map();
    }
    const raw: unknown = await response.json();
    const result = isObject(raw) ? raw.result : null;
    if (!Array.isArray(result)) {
      logger.warn("Krystal universe response malformed");
      // Safety: on fetch failure return the cache ONLY if reasonably fresh
      // (2x TTL) — a multi-day outage must not feed stale "measured" stats
      // into the drawdown/fee gates (safety audit).
      return universeCache !== null && now - universeCache.fetchedAt <= UNIVERSE_TTL_MS * 2
        ? universeCache.pools
        : new Map();
    }
    const pools = new Map<string, KrystalPoolStats>();
    for (const entry of result) {
      if (!isObject(entry) || typeof entry.poolAddress !== "string") continue;
      const stats = parseKrystalPool(entry);
      if (stats === null) continue;
      const poolId = entry.poolAddress.toLowerCase();
      pools.set(poolId, stats);
      lastKnownStats.set(poolId, { stats, at: Date.now() });
      // Auto-register v4 pool keys so the adapter's StateView reads can name
      // the legs. The key's fee/tickSpacing are cosmetic here (StateView reads
      // by poolId; the poolId is a one-way hash, so the key is only a symbol
      // carrier) — tokens are the truth. Krystal renders native ETH as
      // 0xeeee…; the engine's isNative checks address(0).
      if (entry.protocol === "uniswapv4") {
        const token0 = isObject(entry.token0) ? entry.token0 : null;
        const token1 = isObject(entry.token1) ? entry.token1 : null;
        if (token0 !== null && token1 !== null && typeof token0.address === "string") {
          const normalize = (addr: string): `0x${string}` =>
            addr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
              ? NATIVE_MINT
              : (addr.toLowerCase() as `0x${string}`);
          const key: V4PoolKey = {
            currency0: normalize(token0.address),
            currency1:
              typeof token1.address === "string"
                ? normalize(token1.address)
                : (NATIVE_MINT as `0x${string}`),
            fee: Math.max(0, Math.round((stats.lpFee || stats.feeTier) * 10_000)),
            // Cosmetic: the chain convention is tickSpacing 400; only used for
            // binStep display (StateView reads by poolId, not key).
            tickSpacing: 400,
            hooks: "0x0000000000000000000000000000000000000000",
          };
          if (key.currency0.length > 0 && key.currency1.length > 0) {
            registerV4Pool(poolId, key);
          }
        }
      }
    }
    universeCache = { fetchedAt: Date.now(), pools };
    // Prune stale last-known entries (>2h) so the fallback never goes cold-
    // stale for a pool that has genuinely died.
    const now2 = Date.now();
    for (const [addr, entry] of lastKnownStats) {
      if (now2 - entry.at > LAST_KNOWN_TTL_MS) lastKnownStats.delete(addr);
    }
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
      fetchKrystalUniverse().then((pools) => {
        const addr = poolAddress.toLowerCase();
        const fresh = pools.get(addr);
        if (fresh) return fresh;
        // Safety: fall back to the last-known stats (up to 2h) so a pool that
        // dropped out of the top-500 keeps its drawdown signal instead of
        // silently disabling the rotation gate mid-crash.
        const last = lastKnownStats.get(addr);
        return last !== undefined && Date.now() - last.at <= LAST_KNOWN_TTL_MS
          ? last.stats
          : null;
      }),
    ).pipe(Effect.catch(() => Effect.succeed(null))),
  getUniverse: (): Effect.Effect<ReadonlyMap<string, KrystalPoolStats>, never> =>
    Effect.tryPromise(() => fetchKrystalUniverse()).pipe(
      Effect.catch(() => Effect.succeed(new Map())),
    ),
} satisfies KrystalApi);
