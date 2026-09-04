/* eslint-disable anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof */
import { Effect, Layer } from "effect";
import { ConfigService } from "./config-service.js";
import { PythPriceService, type PythPriceApi } from "./services.js";
import { createLogger } from "./logger.js";

/**
 * Pyth Hermes price-feed poller. A parallel, lower-latency USD oracle next to
 * the primary price chain; coexistence is intentional.
 *
 * SERVICE-ONLY by design: `PythPriceLive` is merged into `buildLayer` so the
 * service is AVAILABLE, but NO decision/risk/pricing code consumes it yet.
 * Consumer wiring (trailing-stop marks, HODL benchmark, hedge PnL marks) is a
 * deliberate follow-up for the operator to choose.
 *
 * Module-function core with an injectable `fetchImpl` (mirrors
 * gecko-terminal-service.ts), plus a thin `PythPriceLive` Effect layer at the
 * bottom. Consumers go through the `PythPriceService` Context.Tag.
 *
 * DOCS-VERIFIED contract (Pyth, 2026-07-28; URLs cited on the tag + in
 * AGENTS.md):
 *   - `GET /v2/updates/price/latest?ids[]=<feedId>&parsed=true` returns
 *     `{ parsed: [{ id, price: { price: "<int-string>", conf, expo: <neg-int>,
 *     publish_time: <unix-sec> }, ema_price, metadata }] }`. There is NO
 *     `price.feed_id` field — the feed identifier is the element-level `id`.
 *     USD price = Number(price) × 10^expo.
 *   - API-key auth is a HEADER: `Authorization: Bearer <PYTH_API_KEY>` (never a
 *     query param). Public keyless access on hermes.pyth.network ends right
 *     after 2026-07-31 (docs.pyth.network also cites 2026-08-18) — set
 *     PYTH_API_KEY to keep working; a key comes from the Pyth Terminal.
 *   - Feed IDs below were verified against the official feed list via the live
 *     Hermes `/v2/price_feeds?query=<sym>&asset_type=crypto` endpoint (Pyth
 *     Data Association): base/quote/symbol attributes match each pair exactly.
 */

const logger = createLogger("pyth-price");

const DEFAULT_BASE_URL = "https://hermes.pyth.network";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STALENESS_MS = 60_000;
const DEFAULT_CACHE_TTL_MS = 30_000;

// ─── Verified mainnet price-feed IDs ─────────────────────────────────────────
// Source: https://docs.pyth.network/price-feeds/core/price-feeds/price-feed-ids
// resolved live via `https://hermes.pyth.network/v2/price_feeds?query=<sym>
// &asset_type=crypto` (2026-07-28): attributes.symbol === "Crypto.<SYM>/USD".
export const PYTH_FEED_IDS = {
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  USDC: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  USDT: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
} as const;

const SYMBOL_FEED_IDS: Readonly<Record<string, string>> = PYTH_FEED_IDS;

/** Resolve a symbol (SOL, USDC, USDT — case-insensitive) to its verified
 *  mainnet feed ID, or null when the symbol is not in the built-in map. */
export function resolveFeedId(symbol: string): string | null {
  return SYMBOL_FEED_IDS[symbol.trim().toUpperCase()] ?? null;
}

/**
 * The `fetch` call surface the module needs. A bare call signature rather than
 * the runtime's full `typeof fetch`, so the global `fetch` and a plain injected
 * fake are both assignable without casts (same shape as gecko-terminal's).
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A decoded, non-stale Hermes price. */
export interface PythPricePoint {
  readonly priceUsd: number;
  readonly publishTimeMs: number;
  readonly feedId: string;
}

/** Discriminated parse outcome so the fetcher logs stale-differently-from-bad. */
export type PythParseResult =
  | { readonly kind: "ok"; readonly point: PythPricePoint }
  | { readonly kind: "malformed" }
  | { readonly kind: "stale"; readonly publishTimeMs: number };

// ─── Response parsing (docs-verified shape) ──────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse a Hermes number field (numeric in practice; a numeric string is
 *  tolerated) into a finite number, else null. */
function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Decode one `/v2/updates/price/latest` body into a scaled USD price. `price`
 * is an integer string (e.g. "1234567") and `expo` a non-positive integer
 * (e.g. -6), so USD = Number(price) × 10^expo (1234567 × 10^-6 → 1.234567).
 * Returns `stale` when `publish_time` (unix seconds) is older than
 * `maxStalenessMs`, `malformed` for any structural/numeric problem. `nowMs` is
 * injectable so staleness is unit-testable without fake timers.
 */
function extractPythPriceFields(
  raw: unknown,
): {
  readonly entry: Record<string, unknown>;
  readonly price: Record<string, unknown>;
  readonly rawPrice: string;
} | null {
  if (!isObject(raw)) return null;
  const parsed = raw["parsed"];
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return null;
  const entry: unknown = parsed[0];
  if (!isObject(entry)) return null;
  const price = entry["price"];
  if (!isObject(price)) return null;
  const rawPrice = price["price"];
  if (typeof rawPrice !== "string") return null;
  return { entry, price, rawPrice };
}

// expo is mathematically a base-10 exponent: USD = intPrice × 10^expo. Pyth
// crypto feeds use -8; any non-integer or positive value is a schema break.
function parsePythExpo(price: Record<string, unknown>): number | null {
  const expo: unknown = price["expo"];
  if (typeof expo !== "number") return null;
  if (!Number.isInteger(expo)) return null;
  if (expo > 0) return null;
  return expo;
}

function parsePythScaledPrice(rawPrice: string, expo: number): number | null {
  const priceNum = Number(rawPrice);
  const scaled = priceNum * 10 ** expo;
  if (!Number.isFinite(scaled)) return null;
  if (scaled <= 0) return null;
  return scaled;
}

function parsePythPublishTimeMs(price: Record<string, unknown>): number | null {
  const publishTimeSec = readFiniteNumber(price["publish_time"]);
  if (publishTimeSec === null) return null;
  if (publishTimeSec <= 0) return null;
  return publishTimeSec * 1000;
}

function parsePythFeedId(entry: Record<string, unknown>): string | null {
  const id: unknown = entry["id"];
  if (typeof id !== "string") return null;
  if (id.length === 0) return null;
  return id;
}

export function parsePythPriceUpdate(
  raw: unknown,
  maxStalenessMs: number,
  nowMs: number = Date.now(),
): PythParseResult {
  const fields = extractPythPriceFields(raw);
  if (fields === null) return { kind: "malformed" };
  const { entry, price, rawPrice } = fields;
  const expo = parsePythExpo(price);
  if (expo === null) return { kind: "malformed" };
  const scaled = parsePythScaledPrice(rawPrice, expo);
  if (scaled === null) return { kind: "malformed" };
  const publishTimeMs = parsePythPublishTimeMs(price);
  if (publishTimeMs === null) return { kind: "malformed" };
  if (nowMs - publishTimeMs > maxStalenessMs) return { kind: "stale", publishTimeMs };
  const feedId = parsePythFeedId(entry);
  if (feedId === null) return { kind: "malformed" };
  return { kind: "ok", point: { priceUsd: scaled, publishTimeMs, feedId } };
}

// ─── TTL cache (~30s; one Hermes request per feed per window) ────────────────
// The public Hermes tier is rate-limited (10 req / 10s / IP); a scan cycle that
// asks several consumers for SOL/USD must share one network round trip. Only
// SUCCESSFUL decodes are cached (a null stays fail-open on the next call).

interface CachedPrice {
  readonly priceUsd: number;
  readonly fetchedAtMs: number;
}

const priceCache = new Map<string, CachedPrice>();
let cacheTtlMs = DEFAULT_CACHE_TTL_MS;

/** TEST-ONLY: override the response cache TTL. Restore to DEFAULT afterwards;
 *  production never calls this and keeps the 30s TTL. */
export function setPythCacheTtlMsForTest(ms: number): void {
  cacheTtlMs = ms;
}

/** TEST-ONLY: drop every cached price. */
export function clearPythCacheForTest(): void {
  priceCache.clear();
}

// ─── Fetcher (fail-open: never throws, null = unknown price) ─────────────────

/**
 * Fetch one feed's USD price from Hermes. NEVER throws and never crashes a
 * scan cycle: HTTP error, timeout, fetch failure, an unparseable payload, or a
 * publish_time older than `maxStalenessMs` all return null (unknown price) and
 * log ONE warning. An `apiKey`, when non-empty, is sent as the
 * `Authorization: Bearer <key>` header (the documented mechanism); absent when
 * empty (public access, valid until ~2026-07-31). `baseUrl` overrides the
 * endpoint (env `PYTH_BASE_URL` is already resolved by the caller, else the
 * default). Successful decodes are cached per-feed for `cacheTtlMs`.
 */
function resolvePythBaseUrl(baseUrl: string | undefined): string {
  const base = (baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  if (base.length > 0) return base;
  return DEFAULT_BASE_URL;
}

function getCachedPythPrice(cacheKey: string, ttlMs: number, now: number): number | null {
  const cached = priceCache.get(cacheKey);
  if (cached === undefined) return null;
  if (now - cached.fetchedAtMs >= ttlMs) return null;
  return cached.priceUsd;
}

function buildPythUrl(effectiveBase: string, feedId: string): string {
  return `${effectiveBase}/v2/updates/price/latest?ids[]=${encodeURIComponent(feedId)}&parsed=true`;
}

function buildPythHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey === undefined) return headers;
  if (apiKey.length === 0) return headers;
  headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

export async function fetchPythPriceUsd(
  feedId: string,
  options: {
    readonly baseUrl?: string | undefined;
    readonly apiKey?: string | undefined;
    readonly maxStalenessMs?: number | undefined;
    readonly timeoutMs?: number | undefined;
    readonly cacheTtlMs?: number | undefined;
    readonly fetchImpl?: FetchLike | undefined;
  } = {},
): Promise<number | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxStalenessMs = options.maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS;
  const ttlMs = options.cacheTtlMs ?? cacheTtlMs;
  const effectiveBase = resolvePythBaseUrl(options.baseUrl);
  const cacheKey = feedId.trim().toLowerCase();
  const now = Date.now();
  const cachedPrice = getCachedPythPrice(cacheKey, ttlMs, now);
  if (cachedPrice !== null) return cachedPrice;
  const url = buildPythUrl(effectiveBase, feedId);
  const headers = buildPythHeaders(options.apiKey?.trim());

  try {
    const res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn("Pyth Hermes unavailable — price treated as unknown", {
        feedId,
        status: res.status,
      });
      return null;
    }
    const body: unknown = await res.json();
    const result = parsePythPriceUpdate(body, maxStalenessMs);
    if (result.kind === "malformed") {
      logger.warn("Pyth Hermes returned an unparseable price payload", { feedId });
      return null;
    }
    if (result.kind === "stale") {
      logger.warn("Pyth Hermes price is stale — treating as unknown", {
        feedId,
        ageMs: Date.now() - result.publishTimeMs,
        maxStalenessMs,
      });
      return null;
    }
    priceCache.set(cacheKey, { priceUsd: result.point.priceUsd, fetchedAtMs: Date.now() });
    return result.point.priceUsd;
  } catch (err) {
    logger.warn("Pyth Hermes fetch failed — price treated as unknown", {
      feedId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Effect service wiring ───────────────────────────────────────────────────
// Thin live layer so consumers take Pyth through the PythPriceService
// Context.Tag instead of a direct module call. When PYTH_ENABLED=false the
// methods short-circuit to null (service off, never a network call); the cache
// and fail-open semantics stay at the module layer.

export const PythPriceLive = Layer.effect(
  PythPriceService,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const baseUrl = config.pythBaseUrl;
    const apiKey = config.pythApiKey;
    const maxStalenessMs = config.pythMaxStalenessMs;
    const enabled = config.pythEnabled !== false;

    const getPythPriceUsd = (feedId: string): Effect.Effect<number | null, never> =>
      enabled
        ? Effect.promise(() => fetchPythPriceUsd(feedId, { baseUrl, apiKey, maxStalenessMs }))
        : Effect.succeed(null);

    const getPriceBySymbol = (symbol: string): Effect.Effect<number | null, never> => {
      const feedId = resolveFeedId(symbol);
      return feedId === null ? Effect.succeed(null) : getPythPriceUsd(feedId);
    };

    const api: PythPriceApi = {
      getPythPriceUsd,
      getPriceBySymbol,
      getSolPriceUsd: () => getPythPriceUsd(PYTH_FEED_IDS.SOL),
    };
    return api;
  }),
);
