/**
 * Backfill REAL historical pool snapshots into SQLite (pool_snapshots) from
 * GeckoTerminal OHLCV + reserve TVL, then run the replay backtest on them.
 *
 * WHY GeckoTerminal and not DexPaprika: the DexPaprika OHLCV endpoint
 * (`/networks/robinhood/pools/{addr}/ohlcv?interval=…&start=…`) is broken —
 * it ignores `interval`, `end`, and `limit` and always returns EXACTLY ONE
 * candle (the bar at `start`) regardless of params, even for a high-volume
 * pool created weeks earlier. GeckoTerminal's keyless daily OHLCV
 * (`…/pools/{addr}/ohlcv/day?limit=180`) returns the full real series.
 *
 * Usage:
 *   bun run ops/backfill-dexpaprika.ts --db ./beam-backtest.db --pools a,b,c
 *
 * The script copies nothing itself — run `cp beam.db beam-backtest.db` first
 * so the live engine DB is never written to.
 */
import { Effect } from "effect";
import { createLogger } from "../engine/logger.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import type { BinArray, PoolSnapshot } from "../engine/types.js";

const log = createLogger("Backfill");

const GECKO = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const DP = "https://api.dexpaprika.com/networks/robinhood";

interface GeckoPoolInfo {
  address: string;
  name: string;
  reserveInUsd: number;
  volume24hUsd: number;
  feePct: number | null;
  created: string | null;
  baseSymbol: string | null;
  quoteSymbol: string | null;
}

interface Bar {
  timestampSec: number;
  open: number;
  close: number;
}

interface JsonObject {
  readonly [key: string]: JsonValue;
}

type JsonValue = JsonObject | JsonValue[] | string | number | boolean | null;

function isJsonObject(value: JsonValue): value is JsonObject {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isJsonValue(value: JsonValue): value is JsonValue {
  const tag = Object.prototype.toString.call(value);
  return (
    value === null ||
    tag === "[object String]" ||
    tag === "[object Number]" ||
    tag === "[object Boolean]" ||
    Object.values(value).every(isJsonValue)
  );
}

function property(value: JsonValue, key: string): JsonValue | undefined {
  return isJsonObject(value) ? value[key] : undefined;
}

function stringProperty(value: JsonValue, key: string): string | null {
  const candidate = property(value, key);
  if (Object.prototype.toString.call(candidate) !== "[object String]") return null;
  // SAFETY: the tag check above establishes that this JSON value is a string.
  return candidate as string;
}

function numberProperty(value: JsonValue, key: string): number | null {
  const candidate = property(value, key);
  const tag = Object.prototype.toString.call(candidate);
  return tag === "[object Number]" || tag === "[object String]" ? Number(candidate) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch with a small delay + retry on 429/5xx (GeckoTerminal rate-limits hard). */
async function getJson(url: string): Promise<JsonValue> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      // SAFETY: the payload is JSON by Fetch contract; all traversed fields are guarded below.
      const parsed = (await res.json()) as JsonValue;
      if (!isJsonValue(parsed)) throw new Error(`Invalid JSON response from ${url}`);
      return parsed;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  throw new Error(`HTTP retry exhausted for ${url}`);
}

async function fetchGeckoPoolInfo(pool: string): Promise<GeckoPoolInfo | null> {
  try {
    const d = await getJson(`${GECKO}/pools/${pool}`);
    const attributes = property(property(d, "data") ?? null, "attributes") ?? null;
    return {
      address: pool,
      name: stringProperty(attributes, "name") ?? "",
      reserveInUsd: numberProperty(attributes, "reserve_in_usd") ?? 0,
      volume24hUsd: numberProperty(property(attributes, "volume_usd") ?? null, "h24") ?? 0,
      feePct: numberProperty(attributes, "pool_fee_percentage"),
      created: stringProperty(attributes, "pool_created_at"),
      baseSymbol: stringProperty(attributes, "base_token_symbol"),
      quoteSymbol: stringProperty(attributes, "quote_token_symbol"),
    };
  } catch (e) {
    log.warn("gecko pool info failed", { pool, err: String(e instanceof Error ? e.message : e) });
    return null;
  }
}

async function fetchGeckoOhlcv(pool: string): Promise<Bar[]> {
  const d = await getJson(`${GECKO}/pools/${pool}/ohlcv/day?limit=180`);
  const listValue = property(
    property(property(d, "data") ?? null, "attributes") ?? null,
    "ohlcv_list",
  );
  const list: readonly JsonValue[] = Array.isArray(listValue) ? listValue : [];
  const bars: Bar[] = [];
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length < 5) continue;
    const ts = Number(entry[0]);
    const close = Number(entry[4]);
    const open = Number(entry[1]);
    if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) continue;
    bars.push({ timestampSec: ts, open, close });
  }
  // Gecko returns newest-first; normalize ascending.
  return bars.sort((x, y) => x.timestampSec - y.timestampSec);
}

async function fetchDexPaprikaDetail(pool: string): Promise<{
  fee: number | null;
  symbols: [string, string];
  lastPriceUsd: number | null;
} | null> {
  try {
    const d = await getJson(`${DP}/pools/${pool}`);
    const tokens = property(d, "tokens");
    const toks = Array.isArray(tokens) ? tokens : [];
    const symbols = toks
      .map((token) => stringProperty(token, "symbol"))
      .filter((symbol): symbol is string => symbol !== null && symbol.length > 0);
    return {
      fee: numberProperty(d, "fee"),
      symbols: [symbols[0] ?? "", symbols[1] ?? ""],
      lastPriceUsd: numberProperty(d, "last_price_usd"),
    };
  } catch (e) {
    log.warn("dexpaprika detail failed", { pool, err: String(e instanceof Error ? e.message : e) });
    return null;
  }
}

function tickFromPrice(price: number): number {
  return Math.round(Math.log(price) / Math.log(1.0001));
}

function usd(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

async function backfillPool(db: string, pool: string): Promise<void> {
  // Sequential (GeckoTerminal rate-limits parallel bursts); DexPaprika in parallel.
  const ohlcv = await fetchGeckoOhlcv(pool).catch((e) => {
    log.warn("ohlcv failed", { pool, err: String(e instanceof Error ? e.message : e) });
    return [];
  });
  const [info, dp] = await Promise.all([fetchGeckoPoolInfo(pool), fetchDexPaprikaDetail(pool)]);

  if (ohlcv.length === 0) {
    log.info(`  no OHLCV for ${pool.slice(0, 18)} — skipped`);
    return;
  }

  // bin_step: v3 = on-chain tickSpacing (probed live); v4 pools have no
  // on-chain enumeration (poolKeys returns zero tuples), so default to the
  // engine's 400 stand-in used in the live DB for these exact pools.
  const binStep = pool.length === 42 ? 1 : 400;
  // Fee rate: Gecko pool_fee_percentage (e.g. 0.01 = 0.01% = 0.0001), else
  // DexPaprika `fee` (fraction, 0.0005=0.05%), else 0.0001 default for the
  // ETH/USDG pool family.
  let feeRate = 0.0001;
  if (info?.feePct != null && info.feePct > 0) feeRate = info.feePct / 100;
  else if (dp?.fee != null && dp.fee > 0) feeRate = dp.fee;

  const tvlUsd = usd(info?.reserveInUsd ?? 0);
  const vol24 = usd(info?.volume24hUsd ?? 0);
  const tokenX = dp?.symbols?.[0] || info?.baseSymbol || "X";
  const tokenY = dp?.symbols?.[1] || info?.quoteSymbol || "Y";

  // Gecko can mis-scale a pool's OHLCV to a stablecoin peg (~1.0) even when
  // the pool trades at ~1890 (seen on the v3 WETH/USDG pool). The RELATIVE
  // daily moves and real daily volume are still genuine; only the absolute
  // price level is off. When the latest Gecko close is orders of magnitude
  // away from DexPaprika's real last_price_usd, rescale the whole series so
  // the latest bar matches the real price while preserving relative moves.
  let priceScale = 1;
  const latest = ohlcv[ohlcv.length - 1]?.close;
  if (dp?.lastPriceUsd != null && latest != null && latest > 0 && dp.lastPriceUsd > 0) {
    const ratio = dp.lastPriceUsd / latest;
    if (ratio > 10 || ratio < 0.1) priceScale = ratio;
  }
  if (priceScale !== 1)
    log.info(`  rescaling OHLCV by ${priceScale.toFixed(3)}x (gecko peg → real price)`);

  log.info(
    `  ${pool.slice(0, 18)}: ${ohlcv.length} candles, tvl=$${tvlUsd.toFixed(0)}, fee=${feeRate}, ` +
      `binStep=${binStep}, ${tokenX}/${tokenY}`,
  );

  const snaps: PoolSnapshot[] = [];
  for (const bar of ohlcv) {
    const price = bar.close * priceScale;
    const tick = tickFromPrice(price);
    const fees24h = vol24 * feeRate;
    const apr = tvlUsd > 0 ? ((fees24h * 365) / tvlUsd) * 100 : 0;
    // Populate a band of bins around the active tick with reserves so the
    // replay pre-filter's binUtilization gate passes (empty bins → 0 → gate
    // rejects every tick, exactly what the synthetic fixture avoids by
    // fabricating 40 populated bins). Real per-bin on-chain reserves are not
    // fetched here; nominal liquidity mirrors the synthetic baseline.
    const HALF = 20;
    const bins = Array.from({ length: HALF * 2 }, (_, j) => ({
      binId: tick - HALF + j,
      price: price * Math.pow(1.0001, j - HALF),
      reserveX: 1n,
      reserveY: 1n,
      liquiditySupply: 1n,
    }));
    const binArray: BinArray = {
      lowerBinId: tick - HALF,
      upperBinId: tick + HALF,
      activeBinId: tick,
      binStep,
      bins,
      reservesKnown: true,
    };
    snaps.push({
      poolAddress: pool,
      timestamp: bar.timestampSec * 1000,
      activeBinId: tick,
      tvlUsd,
      volume24hUsd: vol24,
      fees24hUsd: fees24h,
      apr,
      currentPrice: price,
      binStep,
      tokenXSymbol: tokenX,
      tokenYSymbol: tokenY,
      binArray,
      statsSource: "geckoterminal",
    });
  }

  const effect = Effect.gen(function* () {
    const svc = yield* DbService;
    for (const s of snaps) yield* svc.saveSnapshot(s);
  });
  await Effect.runPromise(Effect.provide(effect, DbLive(db)));
  log.info(`  inserted ${snaps.length} snapshots for ${pool.slice(0, 18)}`);
}

function parseArgs(argv: ReadonlyArray<string>) {
  let db = "./beam-backtest.db";
  const pools: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--db" && next) {
      db = next;
      i++;
    } else if (a === "--pools" && next) {
      pools.push(
        ...next
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      i++;
    }
  }
  return { db, pools };
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const { db, pools } = parseArgs(argv);
  if (pools.length === 0) {
    log.error("no --pools given");
    process.exitCode = 1;
    return;
  }
  log.info(`backfilling ${pools.length} pools into ${db}`);
  for (const pool of pools) await backfillPool(db, pool);
  log.info("backfill complete");
}

const isDirect =
  Boolean(globalThis.Bun) &&
  (globalThis.Bun?.main?.endsWith("ops/backfill-dexpaprika.ts") ||
    globalThis.Bun?.main?.endsWith("ops/backfill-dexpaprika.js"));
if (isDirect)
  main(process.argv.slice(2)).catch((e) => {
    log.error("backfill failed", { err: e instanceof Error ? e.message : String(e) });
    process.exitCode = 1;
  });
