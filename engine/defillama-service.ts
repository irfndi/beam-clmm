// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- JSON parser predicates are the I/O boundary for this keyless API.
import { createLogger } from "./logger.js";
import type { PoolState } from "./types.js";
import { ACTIVE_CHAIN_ID } from "./chain-registry.js";

/**
 * DefiLlama yields — MEASURED fee income for Uniswap v3 pools, used when
 * Krystal is unreachable.
 *
 * Why this exists: Krystal is the engine's measured-fee source, but
 * `api.krystal.app` is behind a Cloudflare challenge for datacenter IPs
 * (LIVE-VERIFIED 2026-10-20: HTTP 403 `Just a moment...` from both
 * 217.216.35.77 and 68.183.11.232, HTTP 200 only from a residential address).
 * Without a measured source the fee/IL gate is skipped (`feeIlRatioKnown:
 * false`) and fees stay a binStep MODEL on real gecko volume.
 *
 * `https://yields.llama.fi/pools` is keyless, gzip (~2.2 MB, ~11 MB decoded),
 * reachable from both hosts, and publishes per-pool `apyBase` — the fee APY
 * DefiLlama computes from on-chain fee growth — plus `tvlUsd`, `volumeUsd1d`,
 * `underlyingTokens` and `poolMeta` ("0.05%").
 *
 * LIVE-VERIFIED 2026-10-20 against the three Base WETH/USDC v3 pools:
 *   fee tier 0.01% → tvl $454,913, vol1d $5.48M, apyBase 43.99%
 *   fee tier 0.05% → tvl $8,545,369, vol1d $15.7M, apyBase 33.56%
 *   fee tier 0.30% → tvl $148,352,725, vol1d $86.1M, apyBase 63.54%
 * TVL/volume agree with gecko's live readings for the same pools, which is what
 * makes the join below trustworthy.
 *
 * JOIN (the whole risk in this file): DefiLlama publishes a UUID in `pool`, NOT
 * the pool address — there is no address endpoint (`/pool/{address}` → 404).
 * Rows are matched on (chain, project=uniswap-v3, sorted underlyingTokens,
 * fee tier) and are used only when EXACTLY ONE row matches; anything ambiguous
 * returns null so the caller falls through to gecko (modeled) instead of
 * enriching a pool with another pool's fees.
 *
 * There is deliberately NO "does this row's TVL match our own TVL" check: the
 * EVM adapter's `tvlUsd` for v3 is a rough reserve proxy
 * (`liquidity / 1e18 × price0 × 4`, adapter-service.ts) that MEASURED 500–900×
 * too low on the three live Base WETH/USDC pools (2026-10-20: $9.8k vs
 * $8,545,369 at 0.05%), so it cannot gate a real row. Uniqueness of the
 * (chain, pair, tier) key is the guard that matters.
 */

const logger = createLogger("defillama");

const DEFAULT_ENDPOINT = "https://yields.llama.fi/pools";
const UNIVERSE_TTL_MS = 10 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 20_000;

/** DefiLlama chain label for the active chain, or null when uncovered. */
function chainLabel(chainId: number): string | null {
  if (chainId === 8453) return "Base";
  return null;
}

export interface DefiLlamaPoolStats {
  readonly tvlUsd: number;
  readonly volume24hUsd: number;
  /** Measured 24h fee income, derived as `tvlUsd × apyBase / 100 / 365`. */
  readonly fees24hUsd: number;
  readonly apyBasePct: number;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DefiLlamaFetchOptions {
  readonly endpoint?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}

interface UniverseRow {
  readonly tvlUsd: number;
  readonly volume24hUsd: number;
  readonly apyBasePct: number;
}

interface UniverseCache {
  readonly fetchedAt: number;
  /** `${pairKey}|${tierPct}` → rows (usually one; more than one means ambiguous). */
  readonly byKey: ReadonlyMap<string, ReadonlyArray<UniverseRow>>;
}

let universeCache: UniverseCache | null = null;

export function clearDefiLlamaCache(): void {
  universeCache = null;
}

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

/** Order-independent key for a token pair (DefiLlama does not fix the order). */
export function pairKey(tokenA: string, tokenB: string): string {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/** `"0.05%"` → 0.05. Non-percentage labels (`"stable"`, null) → null. */
export function parseFeeTierPct(poolMeta: unknown): number | null {
  if (typeof poolMeta !== "string") return null;
  const match = /^([\d.]+)\s*%$/.exec(poolMeta.trim());
  if (match === null) return null;
  const pct = Number(match[1]);
  return Number.isFinite(pct) && pct > 0 ? pct : null;
}

/** Uniswap v3 fee tier (percent) from a pool's tick spacing. Unknown spacing →
 *  null: a fee tier is never guessed. */
export function tickSpacingToFeeTierPct(tickSpacing: number): number | null {
  switch (tickSpacing) {
    case 1:
      return 0.01;
    case 10:
      return 0.05;
    case 60:
      return 0.3;
    case 200:
      return 1;
    default:
      return null;
  }
}

function indexRow(row: unknown, chain: string): { key: string; row: UniverseRow } | null {
  if (!isObject(row)) return null;
  if (row["chain"] !== chain || row["project"] !== "uniswap-v3") return null;
  const tokens = row["underlyingTokens"];
  if (!Array.isArray(tokens) || tokens.length !== 2) return null;
  const tokenA = tokens[0];
  const tokenB = tokens[1];
  if (typeof tokenA !== "string" || typeof tokenB !== "string") return null;
  const tierPct = parseFeeTierPct(row["poolMeta"]);
  if (tierPct === null) return null;
  const tvlUsd = readFiniteNumber(row["tvlUsd"]);
  const volume24hUsd = readFiniteNumber(row["volumeUsd1d"]);
  const apyBasePct = readFiniteNumber(row["apyBase"]);
  // A row needs all three to be usable as a measured fee source: without apyBase
  // there is no fee income, without volume there is no authenticity signal.
  if (tvlUsd === null || tvlUsd <= 0) return null;
  if (volume24hUsd === null || volume24hUsd <= 0) return null;
  if (apyBasePct === null || apyBasePct <= 0) return null;
  return {
    key: `${pairKey(tokenA, tokenB)}|${tierPct}`,
    row: { tvlUsd, volume24hUsd, apyBasePct },
  };
}

export function buildUniverse(
  payload: unknown,
  chain: string,
): ReadonlyMap<string, ReadonlyArray<UniverseRow>> {
  const rows = isObject(payload) ? payload["data"] : null;
  if (!Array.isArray(rows)) return new Map();
  const byKey = new Map<string, UniverseRow[]>();
  // SAFETY: Array.isArray proves an array; each element is validated by indexRow.
  for (const element of rows as ReadonlyArray<unknown>) {
    const indexed = indexRow(element, chain);
    if (indexed === null) continue;
    const existing = byKey.get(indexed.key);
    if (existing === undefined) byKey.set(indexed.key, [indexed.row]);
    else existing.push(indexed.row);
  }
  return byKey;
}

async function fetchUniverse(
  chain: string,
  options: DefiLlamaFetchOptions,
): Promise<ReadonlyMap<string, ReadonlyArray<UniverseRow>>> {
  const now = Date.now();
  if (universeCache !== null && now - universeCache.fetchedAt < UNIVERSE_TTL_MS) {
    return universeCache.byKey;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = (options.endpoint ?? process.env.DEFILLAMA_ENDPOINT ?? DEFAULT_ENDPOINT).trim();
  try {
    const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      logger.warn("DefiLlama yields fetch rejected", { status: response.status });
      return universeCache?.byKey ?? new Map();
    }
    const byKey = buildUniverse(await response.json(), chain);
    universeCache = { fetchedAt: Date.now(), byKey };
    logger.info("DefiLlama universe refreshed", { pools: byKey.size, chain });
    return byKey;
  } catch (err) {
    logger.warn("DefiLlama yields fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return universeCache?.byKey ?? new Map();
  }
}

/**
 * Measured stats for one Uniswap v3 pool, or null. NEVER throws.
 *
 * Returns null when the pair+tier key is ambiguous, unmapped, or the pool is not
 * a v3 address — a wrong join would feed another pool's fees into the fee/IL
 * gate.
 */
export async function getDefiLlamaPoolStats(
  input: {
    readonly poolAddress: string;
    readonly tokenX: string;
    readonly tokenY: string;
    readonly tickSpacing: number;
  },
  options: DefiLlamaFetchOptions = {},
): Promise<DefiLlamaPoolStats | null> {
  const chain = chainLabel(ACTIVE_CHAIN_ID);
  if (chain === null) return null;
  // DefiLlama's uniswap-v3 coverage is keyed by the 20-byte pool address. A v4
  // pool id is a bytes32 (66 chars) — same pair and tier, DIFFERENT pool — so a
  // v4 id must never be matched against v3 rows.
  if (input.poolAddress.length !== 42) return null;
  const tierPct = tickSpacingToFeeTierPct(input.tickSpacing);
  if (tierPct === null) return null;

  const byKey = await fetchUniverse(chain, options);
  const candidates = byKey.get(`${pairKey(input.tokenX, input.tokenY)}|${tierPct}`);
  // Exactly one candidate or nothing: an ambiguous key would price this pool
  // with someone else's fees, which is worse than falling through to gecko.
  if (candidates === undefined || candidates.length !== 1) return null;
  const row = candidates[0];
  if (row === undefined) return null;
  return {
    tvlUsd: row.tvlUsd,
    volume24hUsd: row.volume24hUsd,
    fees24hUsd: (row.tvlUsd * row.apyBasePct) / 100 / 365,
    apyBasePct: row.apyBasePct,
  };
}

/** Replace modeled tvl/volume/fees with DefiLlama's MEASURED values and tag
 *  `statsSource: "defillama"` so the fee/IL gate treats them as known. */
export function enrichPoolFromDefiLlama(pool: PoolState, stats: DefiLlamaPoolStats): PoolState {
  const aprAnnualizedPct =
    stats.tvlUsd > 0 && stats.fees24hUsd > 0
      ? ((stats.fees24hUsd * 365) / stats.tvlUsd) * 100
      : pool.apr;
  return {
    ...pool,
    tvlUsd: stats.tvlUsd,
    volume24hUsd: stats.volume24hUsd,
    fees24hUsd: stats.fees24hUsd,
    apr: aprAnnualizedPct,
    statsSource: "defillama",
  };
}
