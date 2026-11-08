// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- JSON parser predicates are the I/O boundary for this keyless API.
import { Effect, Layer } from "effect";
import { createLogger } from "./logger.js";
import { GeckoTerminalService } from "./services.js";
import type { PoolState } from "./types.js";
import { DEFAULT_GECKO_SLUG } from "./chain-registry.js";

/**
 * GeckoTerminal secondary pool-stats source. Sits between the Meteora Data API
 * (primary, datapi-exclusive safety signals) and the adapter's fabricated
 * heuristic (last resort). When the Data API is unreachable, GeckoTerminal's
 * keyless public API (30 req/min) supplies REAL 24h volume and reserve TVL so
 * volume-authenticity, TVL gates and the fee/IL ratio are computed from
 * measured data instead of `tvlUsd × modeled turnover`.
 *
 * Module-function core with an injectable `fetchImpl` (so the pure parsing and
 * the pacing stay unit-testable without layers), plus a thin `GeckoTerminalLive`
 * Effect layer at the bottom. program.ts consumes it through the
 * `GeckoTerminalService` Context.Tag — the `Effect.promise` network call lives
 * in that layer, not in program logic.
 *
 * LIVE-VERIFIED contract (2026-07-22, 5 pools across meteora/orca/raydium-clmm/
 * pancakeswap-v3-solana + raydium-v4 CPMM):
 *   - `data.attributes.volume_usd.h24`  → real 24h volume as a numeric STRING.
 *   - `data.attributes.reserve_in_usd`  → real reserve TVL as a numeric STRING.
 *   - `data.attributes.pool_fee_percentage` → **null for EVERY pool tested.**
 *     GeckoTerminal does not expose a usable fee rate for concentrated-liquidity
 *     pools (their fees are dynamic per bin). The field name is
 *     `pool_fee_percentage` (NOT `fee_percentage`); do NOT rediscover the API.
 *   - Unknown pool → HTTP 404 `{"errors":[{"status":"404","title":"Not Found"}]}`.
 *
 * Because `pool_fee_percentage` is null for the pools Prism watches, fees are
 * derived as `realVolume24h × baseFeeRate`, where the caller passes the pool's
 * binStep-derived base-fee rate (`0.0025 + binStep/1e4`, same model the adapter
 * uses) — applied to REAL volume, so it is materially better than the heuristic
 * (which applies the rate to FABRICATED volume), and is honestly tagged
 * `statsSource: "geckoterminal"` rather than `datapi`. When GeckoTerminal does
 * populate `pool_fee_percentage` (a percentage, e.g. 0.25 = 0.25%) it takes
 * precedence. Data-API-exclusive safety signals (blacklist/freeze/verification/
 * farm) are NEVER sourced from here — they stay null and the safety screener's
 * fail-open handling of null is unaffected.
 */

const logger = createLogger("gecko-terminal");

const DEFAULT_BASE_URL = "https://api.geckoterminal.com/api/v2";
// The ACTIVE chain's GeckoTerminal network slug (from chain-registry: base,
// robinhood, ...). Env GECKO_NETWORK_SLUG overrides.
const GECKO_NETWORK_SLUG = process.env.GECKO_NETWORK_SLUG ?? DEFAULT_GECKO_SLUG;
const REQUEST_TIMEOUT_MS = 10_000;

// ─── Request pacing (30 req/min keyless endpoint) ────────────────────────────
// Discovery can fan out ~50 pools per cycle; if the Data API is down mid-scan
// every one of them falls through to GeckoTerminal, whose keyless tier allows
// 30 req/min. At ≥2.1s between requests (28/min) a full 50-pool list drains over
// ~2 minutes instead of exhausting the quota mid-list — the 429 → null
// fail-through in getGeckoPoolStats remains the backstop for bursts pacing
// cannot absorb.

const DEFAULT_REQUEST_INTERVAL_MS = 2_100;
// Absolute timestamp of the next slot a request may occupy. Reserved
// synchronously (before any await) so concurrent callers cannot all pass the
// pacing check at once and burst past the keyless rate limit.
let nextGeckoRequestAt = 0;

// ─── Batched reads (the fix for multi-agent 429s) ────────────────────────────
// `/networks/{slug}/pools/multi/{a,b,c}` returns every requested pool in ONE
// response. LIVE-VERIFIED 2026-10-20 from both the operator host and the VPS:
// 7 watchlist addresses → HTTP 200 with 7 pool objects; 31+ addresses → HTTP
// 400 `{"errors":[{"status":"400","title":"maximum 30 addresses allowed"}]}`.
// Batching is what keeps several agents behind one IP inside the keyless 30
// req/min budget: three pm2 apps each scanning 7-30 pools used to spend
// 7-30 requests per cycle each (and tripped 429 as soon as their per-process
// pacing drifted past the shared IP budget); one batched read per cycle per
// agent spends exactly one.
const GECKO_MAX_BATCH = 30; // hard API cap — do not exceed (400)

// A 429 means the IP budget is already spent: every further request inside the
// window only deepens the penalty, so the whole module stands down and the
// caller falls through to the heuristic (honest `statsSource` tagging) instead
// of retrying per pool.
const RATE_LIMIT_COOLDOWN_MS = 60_000;
let rateLimitedUntil = 0;

// ─── Response cache (TTL) ────────────────────────────────────────────────
// Krystal is primary (measured fees); gecko is fallback. Without a cache the
// fallback serializes N pools × 2.1s = 63s per 30-pool cycle. A 10-min TTL
// matches the Krystal universe TTL and the 24h-volume half-life — volume
// barely moves intraday — so one bulk failure still pays one gecko round per
// 10 min instead of per pool per cycle.
//
// The cache stores RAW stats (volume/reserve/fee-percentage), not derived
// fees: the same pool is priced with a caller-supplied base fee rate, and a
// batched prefetch cannot know each pool's binStep-derived rate up front. The
// fee rate is applied on read, so one batched entry serves every caller.
const GECKO_CACHE_TTL_MS = 10 * 60 * 1000;

/** Raw (pre-fee-model) GeckoTerminal pool stats. */
export interface GeckoRawStats {
  readonly tvlUsd: number | null;
  readonly volume24hUsd: number;
  readonly volume5mUsd: number | null;
  /** Decimal fraction from `pool_fee_percentage`, or null (always, for CL pools). */
  readonly feeRateFraction: number | null;
  readonly basePriceUsd: number | null;
  readonly quotePriceUsd: number | null;
}

const geckoCache = new Map<string, { stats: GeckoRawStats | null; at: number }>();

export function clearGeckoCache(): void {
  geckoCache.clear();
  rateLimitedUntil = 0;
  nextGeckoRequestAt = 0;
}

/** TEST-ONLY: shorten the keyless pacing (0 disables it) so batching tests do
 *  not sleep 2.1s per request. Production never calls this. */
export function setGeckoRequestIntervalMsForTests(ms: number): void {
  pacingOverrideMs = ms;
}

let pacingOverrideMs: number | null = null;

function currentRequestIntervalMs(): number {
  return pacingOverrideMs ?? DEFAULT_REQUEST_INTERVAL_MS;
}

/** True while the module is standing down after a 429. Exposed for tests. */
export function isGeckoRateLimited(now = Date.now()): boolean {
  return now < rateLimitedUntil;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The `fetch` call surface the module needs. A bare call signature rather than
 * the runtime's full `typeof fetch`, so the global `fetch` and a plain injected
 * fake are both assignable without casts.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Real pool stats resolved from GeckoTerminal. `tvlUsd` is null when the pool
 *  has no usable reserve — the caller treats that as "unavailable" and falls
 *  through to the next source rather than enriching with garbage. */
export interface GeckoPoolStats {
  readonly tvlUsd: number | null;
  readonly volume24hUsd: number;
  readonly volume5mUsd?: number | null | undefined;
  readonly fees24hUsd: number;
  readonly basePriceUsd: number | null;
  readonly quotePriceUsd: number | null;
}

// ─── Response parsing (live-verified semantics) ──────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse a numeric STRING or number into a finite number, else null. GeckoTerminal
 *  returns numeric fields as decimal strings ("23551730.42"). */
function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * GeckoTerminal's `pool_fee_percentage` is a PERCENTAGE (e.g. 0.25 = 0.25%), so
 * the decimal fraction is value/100. Null for every concentrated-liquidity pool
 * tested (verified live 2026-07-22) — the binStep-derived baseFeeRate is the
 * operative path; this only ever runs if GeckoTerminal starts populating it.
 */
function parseFeePercentageFraction(value: unknown): number | null {
  const num = readFiniteNumber(value);
  if (num === null || num < 0) return null;
  return num / 100;
}

/**
 * Parse one `GET /networks/robinhood/pools/{address}` response. Returns null when
 * the payload is not a usable pool object or 24h volume cannot be read (the one
 * field every downstream gate needs). `tvlUsd` is null (not a failure) when the
 * reserve is missing — the caller decides whether to treat that as unavailable.
 *
 * `baseFeeRate` is the pool's binStep-derived base-fee fraction used to price
 * real volume into fees when `pool_fee_percentage` is null (always, for DLMM).
 */
export function parseGeckoPoolRaw(raw: unknown): GeckoRawStats | null {
  if (!isObject(raw)) return null;
  const data = raw["data"];
  if (!isObject(data)) return null;
  return parseGeckoAttributes(data["attributes"]);
}

/** Parse one `attributes` object — the shared core of the single-pool (`data`
 *  is one object) and batched (`data` is an array of objects) responses. */
export function parseGeckoAttributes(attrs: unknown): GeckoRawStats | null {
  if (!isObject(attrs)) return null;

  const volumeUsd = attrs["volume_usd"];
  const volume24hUsd = isObject(volumeUsd) ? readFiniteNumber(volumeUsd["h24"]) : null;
  const volume5mUsd = isObject(volumeUsd) ? readFiniteNumber(volumeUsd["m5"]) : null;
  // Volume is the one field every downstream gate (authenticity, fee/IL) needs;
  // non-positive volume is malformed data (a live pool never reports ≤0 24h
  // volume) — reject the stats ENTIRELY rather than marking garbage measured.
  if (volume24hUsd === null || volume24hUsd <= 0) return null;

  // Non-positive reserves are equally malformed; null them so the caller treats
  // the stats as unavailable (getGeckoPoolStats → null → heuristic + unknown
  // flags, the most conservative outcome). A ZERO reserve with positive volume
  // is dead/wash data — enriching with it would substitute the fallback TVL yet
  // still tag the pool "geckoterminal", flipping volumeAuthenticityKnown true on
  // a TVL gecko never measured. Only a strictly positive reserve is usable.
  const reserveUsd = readFiniteNumber(attrs["reserve_in_usd"]);

  return {
    tvlUsd: reserveUsd !== null && reserveUsd <= 0 ? null : reserveUsd,
    volume24hUsd,
    volume5mUsd,
    feeRateFraction: parseFeePercentageFraction(attrs["pool_fee_percentage"]),
    basePriceUsd: readFiniteNumber(attrs["base_token_price_usd"]),
    quotePriceUsd: readFiniteNumber(attrs["quote_token_price_usd"]),
  };
}

/** Apply a pool's base fee rate to raw volume: gecko's `pool_fee_percentage`
 *  takes precedence when populated, otherwise fees are modeled as
 *  `realVolume24h × baseFeeRate`. */
export function deriveGeckoStats(raw: GeckoRawStats, baseFeeRate: number): GeckoPoolStats {
  const effectiveFeeRate = raw.feeRateFraction ?? baseFeeRate;
  return {
    tvlUsd: raw.tvlUsd,
    volume24hUsd: raw.volume24hUsd,
    volume5mUsd: raw.volume5mUsd,
    fees24hUsd: raw.volume24hUsd * effectiveFeeRate,
    basePriceUsd: raw.basePriceUsd,
    quotePriceUsd: raw.quotePriceUsd,
  };
}

export function parseGeckoPoolStats(raw: unknown, baseFeeRate: number): GeckoPoolStats | null {
  const parsed = parseGeckoPoolRaw(raw);
  return parsed === null ? null : deriveGeckoStats(parsed, baseFeeRate);
}

// ─── Pool enrichment (source-aware) ──────────────────────────────────────────

/**
 * Replace heuristic tvl/volume/fees with real GeckoTerminal values. Mirrors
 * `enrichPoolWithDatapi` but tags `statsSource: "geckoterminal"` and leaves the
 * Data-API-exclusive signals (farm, verification, freeze) null — gecko never
 * sources safety data. APR is recomputed into the engine's annualized-percent
 * convention from the real fees/TVL. `stats.tvlUsd` is non-null on this path
 * (`getGeckoPoolStats` returns null when the reserve is missing).
 */
export function enrichPoolFromGecko(pool: PoolState, stats: GeckoPoolStats): PoolState {
  const tvlUsd = stats.tvlUsd;
  const aprAnnualizedPct =
    tvlUsd !== null && tvlUsd > 0 && stats.fees24hUsd > 0
      ? ((stats.fees24hUsd * 365) / tvlUsd) * 100
      : pool.apr;
  return {
    ...pool,
    tvlUsd: tvlUsd !== null && tvlUsd > 0 ? tvlUsd : pool.tvlUsd,
    volume24hUsd: stats.volume24hUsd,
    volume5mUsd: stats.volume5mUsd ?? pool.volume5mUsd,
    fees24hUsd: stats.fees24hUsd,
    apr: aprAnnualizedPct,
    hasFarm: null,
    farmAprPct: null,
    statsSource: "geckoterminal",
  };
}

// ─── Fetcher (fail-through to the next source) ───────────────────────────────

/** Reserve the next request slot (see the pacing constants above). Returns how
 *  long the caller must wait before issuing its request. */
async function reserveRequestSlot(): Promise<void> {
  const now = Date.now();
  const delayMs = Math.max(0, nextGeckoRequestAt - now);
  nextGeckoRequestAt = Math.max(now, nextGeckoRequestAt) + currentRequestIntervalMs();
  if (delayMs > 0) {
    await sleep(delayMs);
  }
}

function resolveBaseUrl(override?: string): string {
  const base = (override ?? process.env.GECKO_TERMINAL_API_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  return base.length > 0 ? base : DEFAULT_BASE_URL;
}

function cacheRaw(poolAddress: string, stats: GeckoRawStats | null): void {
  geckoCache.set(poolAddress.toLowerCase(), { stats, at: Date.now() });
}

function readCache(
  poolAddress: string,
): { readonly hit: true; readonly stats: GeckoRawStats | null } | { readonly hit: false } {
  const cached = geckoCache.get(poolAddress.toLowerCase());
  if (cached === undefined || Date.now() - cached.at >= GECKO_CACHE_TTL_MS) return { hit: false };
  return { hit: true, stats: cached.stats };
}

/** Mark a 429 and stand the module down for the cooldown window. */
function enterRateLimitCooldown(): void {
  rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  logger.warn("GeckoTerminal rate limited — standing down until the keyless budget resets", {
    cooldownMs: RATE_LIMIT_COOLDOWN_MS,
  });
}

/**
 * Fetch real stats for one pool from GeckoTerminal. NEVER throws and NEVER
 * crashes the scan cycle: 404/429/5xx, timeout, fetch failure, parse failure, or
 * a missing reserve all return null so the caller falls through to the heuristic
 * (the safety net for total API outage). Logs ONE warning per failing fetch.
 *
 * `baseFeeRate` is the pool's binStep-derived base-fee fraction (the caller
 * computes `0.0025 + binStep / 1e4`); `baseUrl` overrides the endpoint
 * (env `GECKO_TERMINAL_API_URL` already resolved by the caller, else default).
 *
 * Prefer `prefetchGeckoPools` for a whole scan set: it fills this cache with a
 * single batched request, so the per-pool path here is only the cold miss.
 */
export async function getGeckoPoolStats(
  poolAddress: string,
  options: {
    readonly baseFeeRate: number;
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: FetchLike;
    readonly bypassCache?: boolean;
  },
): Promise<GeckoPoolStats | null> {
  if (!options.bypassCache) {
    const cached = readCache(poolAddress);
    if (cached.hit) {
      return cached.stats === null ? null : deriveGeckoStats(cached.stats, options.baseFeeRate);
    }
  }
  if (isGeckoRateLimited()) return null;

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const url = `${resolveBaseUrl(options.baseUrl)}/networks/${GECKO_NETWORK_SLUG}/pools/${poolAddress}`;

  await reserveRequestSlot();

  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) {
      enterRateLimitCooldown();
      return null;
    }
    if (!res.ok) {
      logger.warn("GeckoTerminal unavailable — falling through to next stats source", {
        pool: poolAddress,
        status: res.status,
      });
      return null;
    }
    const body: unknown = await res.json();
    const parsed = parseGeckoPoolRaw(body);
    if (parsed === null) {
      logger.warn("GeckoTerminal returned an unparseable pool payload", { pool: poolAddress });
      return null;
    }
    // A usable reserve is required to enrich TVL; without it the stats are too
    // partial to trust (volume alone mis-sizes TVL gates) — treat as unavailable.
    if (parsed.tvlUsd === null) {
      logger.warn("GeckoTerminal pool has no reserve — treating stats as unavailable", {
        pool: poolAddress,
      });
      cacheRaw(poolAddress, null);
      return null;
    }
    cacheRaw(poolAddress, parsed);
    return deriveGeckoStats(parsed, options.baseFeeRate);
  } catch (err) {
    logger.warn("GeckoTerminal fetch failed — falling through to next stats source", {
      pool: poolAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    cacheRaw(poolAddress, null);
    return null;
  }
}

/**
 * Fill the stats cache for every address in `addresses` with as few requests as
 * the API allows: `/pools/multi/{a,b,...}` accepts up to 30 addresses, so a
 * 7-pool watchlist costs ONE request per cycle instead of seven (LIVE-VERIFIED
 * 2026-10-20). This is what keeps several agents behind one IP inside the
 * keyless 30 req/min budget — per-process 2.1s pacing alone cannot, because the
 * budget is per IP, not per process.
 *
 * Never throws. Addresses already cached fresh are skipped. A chunk that fails
 * (429/5xx/timeout) leaves its addresses UNCACHED so a later cycle retries, and
 * a 429 stands the module down for `RATE_LIMIT_COOLDOWN_MS` first.
 */
export async function prefetchGeckoPools(
  addresses: ReadonlyArray<string>,
  options: {
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: FetchLike;
    readonly bypassCache?: boolean;
  } = {},
): Promise<{ readonly requested: number; readonly cached: number; readonly requests: number }> {
  const { seen, pending } = partitionUncached(addresses, options.bypassCache === true);
  const requested = addresses.length;
  if (pending.length === 0) return { requested, cached: seen.size, requests: 0 };
  if (isGeckoRateLimited()) {
    return { requested, cached: seen.size - pending.length, requests: 0 };
  }

  const deps: BatchDeps = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    base: resolveBaseUrl(options.baseUrl),
  };
  let requests = 0;
  for (let offset = 0; offset < pending.length; offset += GECKO_MAX_BATCH) {
    if (isGeckoRateLimited()) break;
    const chunk = pending.slice(offset, offset + GECKO_MAX_BATCH);
    requests += 1;
    const outcome = await fetchBatchChunk(chunk, deps);
    if (outcome === "rate_limited") break;
  }

  let cached = 0;
  for (const key of seen) {
    if (readCache(key).hit) cached += 1;
  }
  return { requested, cached, requests };
}

interface BatchDeps {
  readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
  readonly base: string;
}

interface UncachedPartition {
  readonly seen: Set<string>;
  readonly pending: ReadonlyArray<string>;
}

/** Split the scan set into the deduped address universe and the subset that
 *  still needs a request (fresh cache entries are skipped). */
function partitionUncached(
  addresses: ReadonlyArray<string>,
  bypassCache: boolean,
): UncachedPartition {
  const seen = new Set<string>();
  const pending: string[] = [];
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!bypassCache && readCache(key).hit) continue;
    pending.push(key);
  }
  return { seen, pending };
}

/** Index a batched response by pool address. A batched response is
 *  `data: [ { attributes }, ... ]`, one object per pool, keyed by
 *  `attributes.address` (live-verified). */
function indexBatchAttributes(body: unknown): Map<string, unknown> | null {
  const rows = isObject(body) ? body["data"] : null;
  if (!Array.isArray(rows)) return null;
  // SAFETY: Array.isArray proves an array; the elements stay untrusted and are
  // validated by isObject/parseGeckoAttributes before use.
  const elements: ReadonlyArray<unknown> = rows as ReadonlyArray<unknown>;
  const byAddress = new Map<string, unknown>();
  for (const row of elements) {
    if (!isObject(row)) continue;
    const attrs = row["attributes"];
    if (!isObject(attrs)) continue;
    const rowAddress = attrs["address"];
    if (typeof rowAddress === "string") byAddress.set(rowAddress.toLowerCase(), attrs);
  }
  return byAddress;
}

/** Cache one chunk's stats and log the outcome once per chunk (not per pool). */
function cacheBatchChunk(chunk: ReadonlyArray<string>, byAddress: Map<string, unknown>): void {
  let measured = 0;
  let noReserve = 0;
  let unusable = 0;
  for (const address of chunk) {
    const attrs = byAddress.get(address);
    const parsed = attrs === undefined ? null : parseGeckoAttributes(attrs);
    // A pool gecko does not track, or one that reports zero 24h volume, is
    // cached as null: the caller must fall through to the heuristic instead of
    // marking modeled data as measured.
    if (parsed === null || parsed.tvlUsd === null) {
      cacheRaw(address, null);
      if (parsed === null) unusable += 1;
      else noReserve += 1;
      continue;
    }
    cacheRaw(address, parsed);
    measured += 1;
  }
  logger.info("GeckoTerminal batch resolved", {
    pools: chunk.length,
    measured,
    noReserve,
    noVolumeOrUntracked: unusable,
  });
}

/** One batched request. Returns "rate_limited" so the caller stops the loop
 *  (a 429 means the IP budget is spent; further chunks only deepen it). */
async function fetchBatchChunk(
  chunk: ReadonlyArray<string>,
  deps: BatchDeps,
): Promise<"ok" | "failed" | "rate_limited"> {
  const url = `${deps.base}/networks/${GECKO_NETWORK_SLUG}/pools/multi/${chunk.join(",")}`;
  await reserveRequestSlot();
  try {
    const res = await deps.fetchImpl(url, { signal: AbortSignal.timeout(deps.timeoutMs) });
    if (res.status === 429) {
      enterRateLimitCooldown();
      return "rate_limited";
    }
    if (!res.ok) {
      logger.warn("GeckoTerminal batch unavailable — pools fall through to heuristic", {
        pools: chunk.length,
        status: res.status,
      });
      return "failed";
    }
    const byAddress = indexBatchAttributes(await res.json());
    if (byAddress === null) {
      logger.warn("GeckoTerminal batch response malformed", { pools: chunk.length });
      return "failed";
    }
    cacheBatchChunk(chunk, byAddress);
    return "ok";
  } catch (err) {
    logger.warn("GeckoTerminal batch failed — pools fall through to heuristic", {
      pools: chunk.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}

// ─── Effect service wiring ───────────────────────────────────────────────────
// Thin live layer so program.ts consumes gecko through the GeckoTerminalService
// Context.Tag instead of a direct Effect.promise network call. The module
// functions, injectable FetchLike and the ≥2.1s pacing stay exactly as they
// are — pacing is an HTTP-client concern and correctly lives at this layer
// (the rate limit is process-wide by nature).

export const GeckoTerminalLive = Layer.succeed(GeckoTerminalService, {
  getPoolStats: (poolAddress, baseFeeRate) =>
    Effect.promise(() => getGeckoPoolStats(poolAddress, { baseFeeRate })),
  prefetchPools: (addresses) =>
    Effect.promise(() => prefetchGeckoPools(addresses)).pipe(Effect.asVoid),
});
