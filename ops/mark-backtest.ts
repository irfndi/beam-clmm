/**
 * Mark-to-market challenge-rotation backtest.
 *
 * Replays a pool's real snapshot history through the challenge-mode rotation
 * strategy with REAL CLMM/HODL valuation (engine/pnl.ts), so a backtest P&L
 * equals what the live engine would have earned on the same snapshots.
 *
 * This is the enabling tool for data-driven threshold tuning and for
 * quantifying the impact of the risk fixes (stop-loss, sizing cap, rotation
 * cooldown, yield-decay hysteresis).
 *
 * Run: bun ops/mark-backtest.ts --db ./beam.db [--days 7] [--sweep]
 *
 * Known approximations vs the live engine (documented so results are read
 * honestly):
 *   - drawdown24h is reconstructed from the snapshot price history (24h peak),
 *     not Krystal's token-drawdown metric.
 *   - range width uses a fixed half-width (ticks), not Krystal priceVolatility.
 *   - entry uses a simplified gate (yield>0, drawdown>-pct, yield hysteresis,
 *     min TVL) instead of the full challengePoolScore tier/age/score formula.
 *   - fee accrual is the proportional-share model (position/tvl * 24h fees)
 *     while the active bin is in range.
 *   - verified mode (the default) only replays pools with an explicit stable
 *     leg and converts raw atomic tick ratios into USD; --allow-unverified-price
 *     is diagnostic only and must not be used for profitability decisions.
 */
import { Database } from "bun:sqlite";
import { computeClmmValueUsd, computeHodlValueUsd } from "../engine/pnl.js";
import {
  rawRatioToUsd,
  rawTickToUsd,
  verifiedUsdPairFromMetadata,
  type VerifiedUsdPair,
} from "./verified-usd-price.js";
import {
  computeEntryHodlLegsUsd,
  normalizeStoredDrawdown,
  reconstructedDrawdown24h,
} from "./mark-backtest-math.js";
import {
  runSharedWalkForward,
  type SharedWalkForwardSnapshot,
  type SharedWalkForwardStrategy,
} from "./shared-walk-forward.js";

const DAY_MS = 24 * 3_600_000;
const MAX_FEE_GAP_MS = 30 * 60_000;

interface Snapshot {
  timestamp: number;
  currentPrice: number;
  fees24hUsd: number;
  tvlUsd: number;
  activeBinId: number;
  drawdown24h: number | null;
  statsSource: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXAddress: string | null;
  tokenYAddress: string | null;
  tokenXDecimals: number | null;
  tokenYDecimals: number | null;
  tokenXPriceUsd: number | null;
  tokenYPriceUsd: number | null;
  usdPair: VerifiedUsdPair | null;
  verifiedUsd: boolean;
}

interface Position {
  entryPriceUsd: number;
  lowerBinId: number;
  upperBinId: number;
  depositedUsd: number;
  entryAmountXUsd: number;
  entryAmountYUsd: number;
  entryMs: number;
  peakValueUsd: number;
  usdPair: VerifiedUsdPair;
}

interface Config {
  portfolioUsd: number;
  /** Per-position dollar cap (the sizing fix: 15% of portfolio ≈ $1500). */
  maxPositionUsd: number;
  halfWidthTicks: number;
  /** Rotation exit when 24h drawdown < -pct. */
  drawdownExitPct: number;
  /** Yield-decay exit when yield < fraction * trailing avg. */
  yieldDecayFraction: number;
  /** Entry hysteresis: block entry when yield < fraction * trailing avg. */
  yieldHysteresis: boolean;
  /** Rotation re-entry cooldown. */
  rotationCooldownMs: number;
  /** Hard stop-loss (loss vs deposited). */
  stopLossPct: number;
  stopLossEnabled: boolean;
  trailingStopPct: number;
  minTvlUsd: number;
  /** Cap a position at this % of pool TVL (challengePoolShareCapPct). */
  poolShareCapPct: number;
  entryCostUsd: number;
  exitCostUsd: number;
  slippageBps: number;
  /** Require expected seven-day fees to cover this multiple of round-trip cost. */
  minFeeCostRatio: number;
}

interface PoolResult {
  pool: string;
  trades: number;
  wins: number;
  realizedPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  finalValueUsd: number;
  entryCostsUsd: number;
  exitCostsUsd: number;
  slippageCostsUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  invalidData: number;
  insufficientData: number;
  longFeeGaps: number;
}

interface PoolRow {
  readonly p: string;
}

interface SchemaRow {
  readonly name: string;
}

interface SnapshotRow {
  readonly timestamp: number;
  readonly current_price: number;
  readonly fees_24h_usd: number;
  readonly tvl_usd: number;
  readonly active_bin_id: number;
  readonly drawdown24h: number | null;
  readonly stats_source?: string | null;
  readonly token_x_symbol: string | null;
  readonly token_y_symbol: string | null;
  readonly token_x_address: string | null;
  readonly token_y_address: string | null;
  readonly token_x_decimals: number | null;
  readonly token_y_decimals: number | null;
  readonly token_x_price_usd: number | null;
  readonly token_y_price_usd: number | null;
}

interface BacktestArgs {
  dbPath: string;
  days: number;
  sweep: boolean;
  includeUnmeasured: boolean;
  entryCostUsd: number;
  exitCostUsd: number;
  slippageBps: number;
  walkForward: boolean;
  riskSweep: boolean;
  minFeeCostRatio: number;
  verifiedUsdOnly: boolean;
}

const DEFAULT_CONFIG: Config = {
  portfolioUsd: 10_000,
  maxPositionUsd: 1_500,
  halfWidthTicks: 4_600,
  drawdownExitPct: 5,
  yieldDecayFraction: 0.7,
  yieldHysteresis: true,
  rotationCooldownMs: 15 * 60_000,
  stopLossPct: 0.15,
  stopLossEnabled: true,
  trailingStopPct: 0.1,
  minTvlUsd: 1_000,
  poolShareCapPct: 10,
  entryCostUsd: 0,
  exitCostUsd: 0,
  slippageBps: 0,
  minFeeCostRatio: 0,
};

const MEASURED_SOURCES = new Set(["datapi", "krystal", "geckoterminal"]);

function markToMarket(pos: Position, rawCurrentPrice: number): number {
  const { entryPriceUsd, lowerBinId, upperBinId, depositedUsd } = pos;
  const currentPrice = rawRatioToUsd(rawCurrentPrice, pos.usdPair);
  const PaRaw = rawTickToUsd(lowerBinId, pos.usdPair);
  const PbRaw = rawTickToUsd(upperBinId, pos.usdPair);
  if (!(entryPriceUsd > 0) || !(currentPrice !== null && currentPrice > 0)) return depositedUsd;
  if (!(PaRaw !== null && PbRaw !== null && PaRaw > 0 && PbRaw > 0)) return depositedUsd;
  const Pa = Math.min(PaRaw, PbRaw);
  const Pb = Math.max(PaRaw, PbRaw);
  const entryInRange = Pa < entryPriceUsd && entryPriceUsd < Pb;
  const clmm = entryInRange
    ? computeClmmValueUsd({
        depositedUsd,
        entryPriceUsd,
        lowerBinId,
        upperBinId,
        currentPriceUsd: currentPrice,
        lowerPriceUsd: Pa,
        upperPriceUsd: Pb,
      })
    : null;
  if (clmm !== null && Number.isFinite(clmm) && clmm > 0) return clmm;
  const hodl = computeHodlValueUsd(
    pos.entryAmountXUsd,
    pos.entryAmountYUsd,
    entryPriceUsd,
    currentPrice,
  );
  if (hodl !== null && Number.isFinite(hodl) && hodl > 0) return hodl;
  return depositedUsd;
}

/** 24h drawdown fraction (negative = down) from the snapshot price history. */
function drawdown24h(snaps: readonly Snapshot[], i: number): number {
  return reconstructedDrawdown24h(snaps, i, DAY_MS);
}

/** Stored Krystal drawdown is percentage points; reconstructed drawdown is a fraction. */
function normalizedDrawdown(snapshot: Snapshot, reconstructed: number): number {
  // A stored drawdown may use the raw token orientation. Once USD metadata is
  // verified, reconstruct it in USD so inverse stable pairs cannot flip the
  // risk gate's direction.
  if (snapshot.usdPair !== null) return reconstructed;
  const normalized = normalizeStoredDrawdown(snapshot.drawdown24h);
  return normalized ?? reconstructed;
}

function trailingAvgYield(
  snaps: readonly Snapshot[],
  i: number,
  windowMs = 7 * DAY_MS,
): number | null {
  const now = snaps[i]!.timestamp;
  let sum = 0;
  let count = 0;
  for (let j = i; j >= 0; j--) {
    if (now - snaps[j]!.timestamp > windowMs) break;
    const s = snaps[j]!;
    if (Number.isFinite(s.fees24hUsd) && Number.isFinite(s.tvlUsd) && s.tvlUsd > 0) {
      sum += (s.fees24hUsd / s.tvlUsd) * 100;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

interface MarkSimBook {
  cashUsd: number;
  feesUsd: number;
  realizedPnlUsd: number;
  trades: number;
  wins: number;
  entryCostsUsd: number;
  exitCostsUsd: number;
  slippageCostsUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  longFeeGaps: number;
  invalidData: number;
  cooldownUntil: number;
}

function isValidMarkSnapshot(s: Snapshot): boolean {
  return (
    Number.isFinite(s.timestamp) &&
    Number.isFinite(s.currentPrice) &&
    Number.isFinite(s.fees24hUsd) &&
    Number.isFinite(s.tvlUsd) &&
    Number.isFinite(s.activeBinId) &&
    s.currentPrice > 0 &&
    s.tvlUsd >= 0
  );
}

function failsFeeCostGate(
  s: Snapshot,
  size: number,
  entryCost: number,
  entrySlippage: number,
  cfg: Config,
): boolean {
  if (cfg.minFeeCostRatio <= 0) return false;
  const expectedSevenDayFees = s.fees24hUsd * (size / Math.max(s.tvlUsd, 1)) * 7;
  const roundTripCost = entryCost + cfg.exitCostUsd + entrySlippage;
  return expectedSevenDayFees < roundTripCost * cfg.minFeeCostRatio;
}

function checkStopLoss(mark: number, depositedUsd: number, cfg: Config): string | null {
  if (!cfg.stopLossEnabled) return null;
  const lossPct = (mark - depositedUsd) / depositedUsd;
  if (lossPct < -cfg.stopLossPct) return `stop-loss ${(lossPct * 100).toFixed(1)}%`;
  return null;
}

function tryEnterMarkPosition(
  s: Snapshot,
  cfg: Config,
  avgYield: number | null,
  dd: number,
  book: MarkSimBook,
): Position | null {
  // ── ENTER gate ──
  const yieldDecayed =
    cfg.yieldHysteresis &&
    avgYield !== null &&
    avgYield > 0 &&
    yieldPctOf(s) < avgYield * cfg.yieldDecayFraction;
  const eligible =
    s.tvlUsd >= cfg.minTvlUsd &&
    yieldPctOf(s) > 0 &&
    dd > -(cfg.drawdownExitPct / 100) &&
    !yieldDecayed &&
    s.timestamp >= book.cooldownUntil;
  if (!eligible) return null;
  if (s.usdPair === null) return null;
  const entryPriceUsd = rawRatioToUsd(s.currentPrice, s.usdPair);
  if (entryPriceUsd === null) return null;
  const tvlCapUsd = s.tvlUsd * (cfg.poolShareCapPct / 100);
  const size = Math.min(cfg.maxPositionUsd, tvlCapUsd, book.cashUsd);
  if (size <= 0) return null;
  const entrySlippage = size * (cfg.slippageBps / 10_000);
  const entryCost = cfg.entryCostUsd + entrySlippage;
  if (failsFeeCostGate(s, size, entryCost, entrySlippage, cfg)) return null;
  if (book.cashUsd < size + entryCost) return null;
  const entryLegs = computeEntryHodlLegsUsd({
    depositedUsd: size,
    entryPriceUsd,
    lowerBinId: s.activeBinId - cfg.halfWidthTicks,
    upperBinId: s.activeBinId + cfg.halfWidthTicks,
    usdPair: s.usdPair,
  });
  if (entryLegs === null) return null;
  book.cashUsd -= size + entryCost;
  book.entryCostsUsd += cfg.entryCostUsd;
  book.slippageCostsUsd += entrySlippage;
  return {
    entryPriceUsd,
    lowerBinId: s.activeBinId - cfg.halfWidthTicks,
    upperBinId: s.activeBinId + cfg.halfWidthTicks,
    depositedUsd: size,
    entryAmountXUsd: entryLegs.movingUsd,
    entryAmountYUsd: entryLegs.numeraireUsd,
    entryMs: s.timestamp,
    peakValueUsd: size,
    usdPair: s.usdPair,
  };
}

function yieldPctOf(s: Snapshot): number {
  return s.tvlUsd > 0 ? (s.fees24hUsd / s.tvlUsd) * 100 : 0;
}

function updateMarkPosition(
  s: Snapshot,
  i: number,
  snaps: readonly Snapshot[],
  cfg: Config,
  position: Position,
  avgYield: number | null,
  yieldPct: number,
  dd: number,
  book: MarkSimBook,
): Position | null {
  // ── In-position: mark, fees, exits ──
  const mark = markToMarket(position, s.currentPrice);
  position.peakValueUsd = Math.max(position.peakValueUsd, mark);
  // Proportional fee share while in-range.
  const inRange = s.activeBinId >= position.lowerBinId && s.activeBinId <= position.upperBinId;
  if (inRange && s.tvlUsd > 0) {
    const rawIntervalMs = i > 0 ? s.timestamp - snaps[i - 1]!.timestamp : 30_000;
    if (rawIntervalMs > MAX_FEE_GAP_MS) book.longFeeGaps++;
    const intervalMs = Math.min(Math.max(rawIntervalMs, 0), MAX_FEE_GAP_MS);
    const share = Math.min(position.depositedUsd / s.tvlUsd, 1);
    const fee = s.fees24hUsd * share * (intervalMs / DAY_MS);
    book.feesUsd += fee;
    book.cashUsd += fee;
  }
  let exitReason: string | null = null;
  const yieldDecayed =
    avgYield !== null && avgYield > 0 && yieldPct < avgYield * cfg.yieldDecayFraction;
  if (dd < -(cfg.drawdownExitPct / 100)) exitReason = `drawdown ${(dd * 100).toFixed(1)}%`;
  else if (yieldDecayed) exitReason = `yield ${yieldPct.toFixed(1)}%/d decayed`;
  else exitReason = checkStopLoss(mark, position.depositedUsd, cfg);
  if (exitReason === null) {
    const drawdown = (position.peakValueUsd - mark) / position.peakValueUsd;
    if (drawdown > cfg.trailingStopPct) exitReason = `trailing ${(drawdown * 100).toFixed(1)}%`;
  }
  if (exitReason !== null) {
    const pnl = mark - position.depositedUsd;
    book.realizedPnlUsd += pnl;
    if (pnl >= 0) book.grossProfitUsd += pnl;
    else book.grossLossUsd += -pnl;
    const exitSlippage = mark * (cfg.slippageBps / 10_000);
    const exitCost = cfg.exitCostUsd + exitSlippage;
    book.cashUsd += mark - exitCost;
    book.exitCostsUsd += cfg.exitCostUsd;
    book.slippageCostsUsd += exitSlippage;
    if (pnl >= 0) book.wins++;
    book.trades++;
    book.cooldownUntil = s.timestamp + cfg.rotationCooldownMs;
    return null;
  }
  return position;
}

function closeMarkPosition(
  snaps: readonly Snapshot[],
  cfg: Config,
  book: MarkSimBook,
  position: Position | null,
  peakEquityUsd: number,
): void {
  // Close any open position at the final mark.
  if (position === null) return;
  const mark = markToMarket(position, snaps[snaps.length - 1]!.currentPrice);
  const pnl = mark - position.depositedUsd;
  book.realizedPnlUsd += pnl;
  if (pnl >= 0) book.grossProfitUsd += pnl;
  else book.grossLossUsd += -pnl;
  const exitSlippage = mark * (cfg.slippageBps / 10_000);
  book.cashUsd += mark - cfg.exitCostUsd - exitSlippage;
  book.exitCostsUsd += cfg.exitCostUsd;
  book.slippageCostsUsd += exitSlippage;
  if (pnl >= 0) book.wins++;
  book.trades++;
  const finalEquity = book.cashUsd;
  book.maxDrawdownUsd = Math.max(book.maxDrawdownUsd, peakEquityUsd - finalEquity);
  if (peakEquityUsd > 0) {
    book.maxDrawdownPct = Math.max(book.maxDrawdownPct, (peakEquityUsd - finalEquity) / peakEquityUsd);
  }
}

export function simulatePool(snaps: readonly Snapshot[], cfg: Config): PoolResult {
  let position: Position | null = null;
  let peakEquityUsd = cfg.portfolioUsd;
  const book: MarkSimBook = {
    cashUsd: cfg.portfolioUsd,
    feesUsd: 0,
    realizedPnlUsd: 0,
    trades: 0,
    wins: 0,
    entryCostsUsd: 0,
    exitCostsUsd: 0,
    slippageCostsUsd: 0,
    grossProfitUsd: 0,
    grossLossUsd: 0,
    maxDrawdownUsd: 0,
    maxDrawdownPct: 0,
    longFeeGaps: 0,
    invalidData: 0,
    cooldownUntil: 0,
  };
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i]!;
    if (!isValidMarkSnapshot(s)) {
      book.invalidData++;
      continue;
    }
    const yieldPct = yieldPctOf(s);
    const avgYield = trailingAvgYield(snaps, i);
    const dd = normalizedDrawdown(s, drawdown24h(snaps, i));

    if (position === null) {
      const entered = tryEnterMarkPosition(s, cfg, avgYield, dd, book);
      if (entered !== null) position = entered;
      continue;
    }

    position = updateMarkPosition(s, i, snaps, cfg, position, avgYield, yieldPct, dd, book);
    const equity = book.cashUsd + (position === null ? 0 : markToMarket(position, s.currentPrice));
    peakEquityUsd = Math.max(peakEquityUsd, equity);
    book.maxDrawdownUsd = Math.max(book.maxDrawdownUsd, peakEquityUsd - equity);
    if (peakEquityUsd > 0)
      book.maxDrawdownPct = Math.max(book.maxDrawdownPct, (peakEquityUsd - equity) / peakEquityUsd);
  }

  // Close any open position at the final mark.
  closeMarkPosition(snaps, cfg, book, position, peakEquityUsd);

  return {
    pool: "",
    trades: book.trades,
    wins: book.wins,
    realizedPnlUsd: book.realizedPnlUsd,
    feesUsd: book.feesUsd,
    netPnlUsd: book.realizedPnlUsd + book.feesUsd - book.entryCostsUsd - book.exitCostsUsd - book.slippageCostsUsd,
    finalValueUsd: book.cashUsd,
    entryCostsUsd: book.entryCostsUsd,
    exitCostsUsd: book.exitCostsUsd,
    slippageCostsUsd: book.slippageCostsUsd,
    maxDrawdownUsd: book.maxDrawdownUsd,
    maxDrawdownPct: book.maxDrawdownPct,
    grossProfitUsd: book.grossProfitUsd,
    grossLossUsd: book.grossLossUsd,
    invalidData: book.invalidData,
    insufficientData: snaps.length < 2 ? 1 : 0,
    longFeeGaps: book.longFeeGaps,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): BacktestArgs {
  const out: BacktestArgs = {
    dbPath: "./beam.db",
    days: 7,
    sweep: false,
    includeUnmeasured: false,
    entryCostUsd: 0,
    exitCostUsd: 0,
    slippageBps: 0,
    walkForward: false,
    riskSweep: false,
    minFeeCostRatio: 0,
    verifiedUsdOnly: true,
  };
  const numberArg = (flag: string, value: string | undefined, minimum: number): number => {
    const parsed = Number(value);
    if (value === undefined || !Number.isFinite(parsed) || parsed < minimum) {
      throw new Error(`${flag} must be a finite number >= ${minimum}`);
    }
    return parsed;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--db" && argv[i + 1]) out.dbPath = argv[++i]!;
    else if (a === "--days") out.days = numberArg(a, argv[++i], 1 / 24);
    else if (a === "--sweep") out.sweep = true;
    else if (a === "--include-unmeasured") out.includeUnmeasured = true;
    else if (a === "--entry-cost-usd") out.entryCostUsd = numberArg(a, argv[++i], 0);
    else if (a === "--exit-cost-usd") out.exitCostUsd = numberArg(a, argv[++i], 0);
    else if (a === "--slippage-bps") out.slippageBps = numberArg(a, argv[++i], 0);
    else if (a === "--walk-forward") out.walkForward = true;
    else if (a === "--risk-sweep") out.riskSweep = true;
    else if (a === "--min-fee-cost-ratio") out.minFeeCostRatio = numberArg(a, argv[++i], 0);
    else if (a === "--allow-unverified-price") out.verifiedUsdOnly = false;
  }
  if (out.slippageBps > 10_000) throw new Error("--slippage-bps must be <= 10000");
  return out;
}

let args: BacktestArgs;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const db = new Database(args.dbPath);

const endMs = Date.now();
const startMs = endMs - args.days * DAY_MS;

// Build the universe from observed pool snapshots, not surviving positions, to
// avoid current-position/survivorship selection bias in historical runs.
const poolRows = db
  .query(
    `SELECT DISTINCT pool_address AS p
     FROM pool_snapshots
     WHERE timestamp>=? AND timestamp<=?
     ORDER BY pool_address`,
  )
  .all(startMs, endMs);
// SAFETY: the SELECT aliases its sole text column to `p`.
const pools = poolRows as PoolRow[];
const poolAddresses = pools.map((row) => row.p);

const hasDrawdownColumn = (() => {
  try {
    // SAFETY: PRAGMA table_info always returns rows with a text `name` column.
    const cols = db.query("PRAGMA table_info(pool_snapshots)").all() as SchemaRow[];
    return cols.some((row) => row.name === "drawdown24h");
  } catch {
    return false;
  }
})();

const hasStatsSourceColumn = (() => {
  try {
    const cols = db.query("PRAGMA table_info(pool_snapshots)").all() as SchemaRow[];
    return cols.some((row) => row.name === "stats_source");
  } catch {
    return false;
  }
})();

const hasUsdMetadataColumns = (() => {
  try {
    const cols = db.query("PRAGMA table_info(pool_snapshots)").all() as SchemaRow[];
    const names = new Set(cols.map((row) => row.name));
    return [
      "token_x_address",
      "token_y_address",
      "token_x_decimals",
      "token_y_decimals",
      "token_x_price_usd",
      "token_y_price_usd",
    ].every((name) => names.has(name));
  } catch {
    return false;
  }
})();

function loadSnapshots(pool: string): Snapshot[] {
  const sourceSelect = hasStatsSourceColumn ? "stats_source" : "NULL AS stats_source";
  const metadataSelect = hasUsdMetadataColumns
    ? "token_x_address, token_y_address, token_x_decimals, token_y_decimals, token_x_price_usd, token_y_price_usd"
    : "NULL AS token_x_address, NULL AS token_y_address, NULL AS token_x_decimals, NULL AS token_y_decimals, NULL AS token_x_price_usd, NULL AS token_y_price_usd";
  const select = hasDrawdownColumn
    ? `SELECT timestamp, current_price, fees_24h_usd, tvl_usd, active_bin_id, drawdown24h, token_x_symbol, token_y_symbol, ${metadataSelect}, ${sourceSelect}
       FROM pool_snapshots WHERE pool_address=? AND timestamp>=? AND timestamp<=?
       ORDER BY timestamp`
    : `SELECT timestamp, current_price, fees_24h_usd, tvl_usd, active_bin_id, NULL AS drawdown24h, token_x_symbol, token_y_symbol, ${metadataSelect}, ${sourceSelect}
       FROM pool_snapshots WHERE pool_address=? AND timestamp>=? AND timestamp<=?
       ORDER BY timestamp`;
  // SAFETY: the SELECT supplies exactly these numeric columns and a nullable drawdown alias.
  const snapshots = (db.query(select).all(pool, startMs, endMs) as SnapshotRow[]).map((row) => {
    const tokenXSymbol = row.token_x_symbol ?? "";
    const tokenYSymbol = row.token_y_symbol ?? "";
    const usdPair = verifiedUsdPairFromMetadata({
      tokenXAddress: row.token_x_address,
      tokenYAddress: row.token_y_address,
      tokenXSymbol,
      tokenYSymbol,
      tokenXDecimals: row.token_x_decimals,
      tokenYDecimals: row.token_y_decimals,
      tokenXPriceUsd: row.token_x_price_usd,
      tokenYPriceUsd: row.token_y_price_usd,
    });
    return {
      timestamp: row.timestamp,
      currentPrice: row.current_price,
      fees24hUsd: row.fees_24h_usd,
      tvlUsd: row.tvl_usd,
      activeBinId: row.active_bin_id,
      drawdown24h: row.drawdown24h,
      statsSource: row.stats_source ?? "heuristic",
      tokenXSymbol,
      tokenYSymbol,
      tokenXAddress: row.token_x_address,
      tokenYAddress: row.token_y_address,
      tokenXDecimals: row.token_x_decimals,
      tokenYDecimals: row.token_y_decimals,
      tokenXPriceUsd: row.token_x_price_usd,
      tokenYPriceUsd: row.token_y_price_usd,
      usdPair:
        usdPair ?? (args.verifiedUsdOnly ? null : { scale: 1, invert: false, stablePriceUsd: 1 }),
      verifiedUsd: usdPair !== null,
    };
  });
  return snapshots.filter(
    (snapshot) =>
      (args.includeUnmeasured || MEASURED_SOURCES.has(snapshot.statsSource)) &&
      (!args.verifiedUsdOnly || snapshot.verifiedUsd),
  );
}

function aggregate(results: PoolResult[]): PoolResult {
  return {
    pool: "ALL",
    trades: results.reduce((a, r) => a + r.trades, 0),
    wins: results.reduce((a, r) => a + r.wins, 0),
    realizedPnlUsd: results.reduce((a, r) => a + r.realizedPnlUsd, 0),
    feesUsd: results.reduce((a, r) => a + r.feesUsd, 0),
    netPnlUsd: results.reduce((a, r) => a + r.netPnlUsd, 0),
    finalValueUsd: results.reduce((a, r) => a + r.finalValueUsd, 0),
    entryCostsUsd: results.reduce((a, r) => a + r.entryCostsUsd, 0),
    exitCostsUsd: results.reduce((a, r) => a + r.exitCostsUsd, 0),
    slippageCostsUsd: results.reduce((a, r) => a + r.slippageCostsUsd, 0),
    maxDrawdownUsd: results.reduce((a, r) => a + r.maxDrawdownUsd, 0),
    maxDrawdownPct: results.reduce((a, r) => Math.max(a, r.maxDrawdownPct), 0),
    grossProfitUsd: results.reduce((a, r) => a + r.grossProfitUsd, 0),
    grossLossUsd: results.reduce((a, r) => a + r.grossLossUsd, 0),
    invalidData: results.reduce((a, r) => a + r.invalidData, 0),
    insufficientData: results.reduce((a, r) => a + r.insufficientData, 0),
    longFeeGaps: results.reduce((a, r) => a + r.longFeeGaps, 0),
  };
}

function fmt(r: PoolResult): string {
  const winRate = r.trades > 0 ? `${((r.wins / r.trades) * 100).toFixed(0)}%` : "n/a";
  return [
    r.pool.slice(0, 10).padEnd(10),
    String(r.trades).padStart(4),
    winRate.padStart(5),
    `$${r.feesUsd.toFixed(0)}`.padStart(7),
    `$${r.realizedPnlUsd.toFixed(0)}`.padStart(7),
    `$${r.netPnlUsd.toFixed(0)}`.padStart(7),
  ].join("  ");
}

function cliConfig(config: Config): Config {
  return {
    ...config,
    entryCostUsd: args.entryCostUsd,
    exitCostUsd: args.exitCostUsd,
    slippageBps: args.slippageBps,
    minFeeCostRatio: args.minFeeCostRatio,
  };
}

const snapshotsByPool = new Map<string, Snapshot[]>();
for (const pool of poolAddresses) snapshotsByPool.set(pool, loadSnapshots(pool));

const coverageRows = hasStatsSourceColumn
  ? (db
      .query(
        "SELECT COALESCE(stats_source, 'heuristic') AS source, COUNT(*) AS count FROM pool_snapshots WHERE timestamp>=? AND timestamp<=? GROUP BY source",
      )
      .all(startMs, endMs) as Array<{ readonly source: string; readonly count: number }>)
  : [];
const totalSnapshotCount = hasStatsSourceColumn
  ? coverageRows.reduce((sum, row) => sum + row.count, 0)
  : Number(
      (
        db
          .query("SELECT COUNT(*) AS count FROM pool_snapshots WHERE timestamp>=? AND timestamp<=?")
          .get(startMs, endMs) as { readonly count: number }
      ).count,
    );
const measuredSnapshotCount = coverageRows.reduce(
  (sum, row) => sum + (MEASURED_SOURCES.has(row.source) ? row.count : 0),
  0,
);
const filteredSnapshotCount = args.includeUnmeasured
  ? 0
  : totalSnapshotCount - measuredSnapshotCount;

function reportCoverage(): void {
  const usablePools = [...snapshotsByPool.values()].filter(
    (snapshots) => snapshots.length > 0,
  ).length;
  const timestamps = [...snapshotsByPool.values()]
    .flat()
    .map((snapshot) => snapshot.timestamp)
    .sort((a, b) => a - b);
  const observedStart = timestamps[0];
  const observedEnd = timestamps[timestamps.length - 1];
  const observedMs =
    observedStart === undefined || observedEnd === undefined ? 0 : observedEnd - observedStart;
  console.log(
    `Source coverage: pools=${usablePools}/${poolAddresses.length}, simulatedCapital=$${(usablePools * DEFAULT_CONFIG.portfolioUsd).toFixed(0)}, ` +
      `total=${totalSnapshotCount}, measured=${measuredSnapshotCount}, ` +
      `unmeasured=${totalSnapshotCount - measuredSnapshotCount}, filtered=${filteredSnapshotCount}, ` +
      `mode=${args.includeUnmeasured ? "include-unmeasured" : "measured-only"}, ` +
      `price=${args.verifiedUsdOnly ? "verified-stable-leg" : "UNVERIFIED-RAW-RATIO"}`,
  );
  console.log(
    `Observed timeline: ${(observedMs / DAY_MS).toFixed(2)}d of ${args.days.toFixed(2)}d requested${
      observedMs < args.days * DAY_MS ? " (INCOMPLETE — do not treat as a full-window result)" : ""
    }`,
  );
}

function sweepConfigs(expanded: boolean): Config[] {
  const drawdowns = expanded ? [3, 5, 7] : [3, 5, 7, 10];
  const yields = expanded ? [0.5, 0.7] : [0.5, 0.7, 1.0];
  const caps = expanded ? [500, 1_000, 1_500, 2_500] : [DEFAULT_CONFIG.maxPositionUsd];
  const cooldowns = expanded
    ? [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000]
    : [DEFAULT_CONFIG.rotationCooldownMs];
  const feeCostRatios = expanded ? [0, 1, 2] : [DEFAULT_CONFIG.minFeeCostRatio];
  return drawdowns.flatMap((dd) =>
    yields.flatMap((yf) =>
      caps.flatMap((maxPositionUsd) =>
        cooldowns.flatMap((rotationCooldownMs) =>
          feeCostRatios.map((minFeeCostRatio) =>
            cliConfig({
              ...DEFAULT_CONFIG,
              drawdownExitPct: dd,
              yieldDecayFraction: yf,
              maxPositionUsd,
              rotationCooldownMs,
              minFeeCostRatio,
            }),
          ),
        ),
      ),
    ),
  );
}

function reportRobustMetrics(label: string, result: PoolResult): void {
  const profitFactor =
    result.grossLossUsd > 0 ? (result.grossProfitUsd / result.grossLossUsd).toFixed(2) : "n/a";
  console.log(
    `${label}: net=$${result.netPnlUsd.toFixed(0)}, costs=$${(result.entryCostsUsd + result.exitCostsUsd + result.slippageCostsUsd).toFixed(0)} ` +
      `(entry=$${result.entryCostsUsd.toFixed(0)}, exit=$${result.exitCostsUsd.toFixed(0)}, slippage=$${result.slippageCostsUsd.toFixed(0)}), ` +
      `maxDD=$${result.maxDrawdownUsd.toFixed(0)} (${(result.maxDrawdownPct * 100).toFixed(1)}%), ` +
      `profitFactor=${profitFactor}, invalid=${result.invalidData}, insufficient=${result.insufficientData}, ` +
      `feeGapsCapped=${result.longFeeGaps}`,
  );
}

if (args.walkForward) {
  reportCoverage();
  const timestamps = [...snapshotsByPool.values()]
    .flat()
    .map((snapshot) => snapshot.timestamp)
    .sort((a, b) => a - b);
  const startTimestamp = timestamps[0];
  const endTimestamp = timestamps[timestamps.length - 1];
  const elapsedMs =
    startTimestamp === undefined || endTimestamp === undefined ? 0 : endTimestamp - startTimestamp;
  if (timestamps.length < 9 || elapsedMs < 3 * DAY_MS) {
    console.log("WALK-FORWARD: insufficient data for train/validation/test; no winner selected.");
  } else {
    const trainEnd = startTimestamp! + elapsedMs / 3;
    const validationEnd = startTimestamp! + (2 * elapsedMs) / 3;
    const candidates = sweepConfigs(true);
    const trainCount = timestamps.filter((timestamp) => timestamp <= trainEnd).length;
    const validationCount = timestamps.filter(
      (timestamp) => timestamp > trainEnd && timestamp <= validationEnd,
    ).length;
    const testCount = timestamps.filter((timestamp) => timestamp > validationEnd).length;
    if (trainCount < 3 || validationCount < 3 || testCount < 3) {
      console.log("WALK-FORWARD: insufficient data in one or more splits; no winner selected.");
      process.exit(0);
    }
    const toStrategy = (config: Config): SharedWalkForwardStrategy => ({
      ...config,
      maxConcurrentPositions: 3,
      maxDeployedPct: 100,
    });
    const sharedSnapshots = new Map<string, readonly SharedWalkForwardSnapshot[]>();
    for (const [pool, snapshots] of snapshotsByPool) sharedSnapshots.set(pool, snapshots);
    const shared = runSharedWalkForward({
      snapshotsByPool: sharedSnapshots,
      candidates,
      toStrategy,
      train: { startMs: startTimestamp!, endMs: trainEnd },
      validation: { startMs: trainEnd + 1, endMs: validationEnd },
      test: { startMs: validationEnd + 1, endMs: endTimestamp! },
      requirements: {
        minAcceptedTrades: 2,
        maxDrawdownPct: 0.2,
        minElapsedCoverageMs: DAY_MS,
        minProfitFactor: 1,
      },
    });
    console.log("WALK-FORWARD (shared wallet; train-only selection):");
    console.log(`Candidates considered: ${shared.candidatesConsidered}`);
    if (shared.winner === null || shared.validation === null || shared.test === null) {
      console.log("WALK-FORWARD STATUS: NO ELIGIBLE TRAIN WINNER; keep PAPER_TRADING=true");
    } else {
      const winner = shared.winner;
      const format = (label: string, result: typeof winner): void =>
        console.log(
          `${label}: net=$${result.metrics.netPnlUsd.toFixed(0)}, trades=${result.metrics.completedTrades}, ` +
            `accepted=${result.metrics.acceptedEntries}, maxDD=${(result.metrics.maxDrawdownPct * 100).toFixed(1)}%, ` +
            `profitFactor=${Number.isFinite(result.metrics.profitFactor) ? result.metrics.profitFactor.toFixed(2) : "inf"}, ` +
            `coverage=${(result.metrics.elapsedCoverageMs / DAY_MS).toFixed(2)}d`,
        );
      console.log(
        `Selected cap=$${winner.config.maxPositionUsd}, cooldown=${winner.config.rotationCooldownMs / 60_000}m, ` +
          `dd<${winner.config.drawdownExitPct}%, yield<${winner.config.yieldDecayFraction}x, ` +
          `fee/cost>=${winner.config.minFeeCostRatio}x`,
      );
      format("Train", shared.train!);
      format("Validation", shared.validation);
      format("Test", shared.test);
      const robust =
        shared.validation.metrics.netPnlUsd > 0 &&
        shared.test.metrics.netPnlUsd > 0 &&
        shared.validation.metrics.sufficientCoverage &&
        shared.test.metrics.sufficientCoverage;
      console.log(
        robust
          ? "WALK-FORWARD STATUS: ROBUST WINNER"
          : "WALK-FORWARD STATUS: NO ROBUST WINNER; keep PAPER_TRADING=true",
      );
    }
  }
} else if (args.sweep) {
  reportCoverage();
  const rows: string[] = [];
  for (const cfg of sweepConfigs(args.riskSweep)) {
    const results = poolAddresses.map((p) => simulatePool(snapshotsByPool.get(p) ?? [], cfg));
    const total = aggregate(results);
    rows.push(
      `cap=$${String(cfg.maxPositionUsd).padStart(4)}  cd=${String(cfg.rotationCooldownMs / 60_000).padStart(3)}m  ` +
        `fee/cost>=${cfg.minFeeCostRatio}x  dd<${String(cfg.drawdownExitPct).padStart(2)}%  yield<${cfg.yieldDecayFraction.toFixed(1).padStart(3)}x  ` +
        `trades=${String(total.trades).padStart(3)}  fees=$${total.feesUsd.toFixed(0).padStart(6)}  ` +
        `realized=$${total.realizedPnlUsd.toFixed(0).padStart(6)}  costs=$${(total.entryCostsUsd + total.exitCostsUsd + total.slippageCostsUsd).toFixed(0).padStart(5)}  net=$${total.netPnlUsd.toFixed(0).padStart(6)}  win=${total.trades ? ((total.wins / total.trades) * 100).toFixed(0) : 0}%`,
    );
  }
  console.log("THRESHOLD SWEEP (net PnL = realized + fees - execution costs):");
  console.log(rows.join("\n"));
} else if (process.argv.includes("--fix-impact")) {
  reportCoverage();
  const baseline: Config = {
    ...DEFAULT_CONFIG,
    maxPositionUsd: 4_000, // old 40% concentration
    stopLossEnabled: false,
    rotationCooldownMs: 0,
    yieldHysteresis: false,
  };
  const variants: Array<[string, Partial<Config>]> = [
    ["baseline (no fixes)", {}],
    ["+ stop-loss", { stopLossEnabled: true }],
    ["+ sizing cap 15%", { maxPositionUsd: 1_500 }],
    ["+ rotation cooldown", { rotationCooldownMs: 15 * 60_000 }],
    ["+ yield hysteresis", { yieldHysteresis: true }],
    ["ALL fixes", {}],
  ];
  const rows: string[] = [];
  for (const [label, overrides] of variants) {
    const cfg: Config = cliConfig(
      label === "ALL fixes" ? { ...DEFAULT_CONFIG } : { ...baseline, ...overrides },
    );
    const results = poolAddresses.map((p) => simulatePool(snapshotsByPool.get(p) ?? [], cfg));
    const total = aggregate(results);
    rows.push(
      `${label.padEnd(22)}  trades=${String(total.trades).padStart(3)}  fees=$${total.feesUsd.toFixed(0).padStart(5)}  ` +
        `realized=$${total.realizedPnlUsd.toFixed(0).padStart(6)}  costs=$${(total.entryCostsUsd + total.exitCostsUsd + total.slippageCostsUsd).toFixed(0).padStart(5)}  net=$${total.netPnlUsd.toFixed(0).padStart(6)}  win=${total.trades ? ((total.wins / total.trades) * 100).toFixed(0) : 0}%`,
    );
  }
  console.log("FIX-IMPACT A/B (net PnL = realized + fees - execution costs):");
  console.log(rows.join("\n"));
} else {
  reportCoverage();
  const cfg = cliConfig(DEFAULT_CONFIG);
  const results = poolAddresses.map((p) => {
    const r = simulatePool(snapshotsByPool.get(p) ?? [], cfg);
    r.pool = p;
    return r;
  });
  console.log("POOL       trades  win%   fees   realzd  netPnl");
  for (const r of results) console.log(fmt(r));
  const total = aggregate(results);
  total.pool = "ALL";
  console.log("------------------------------------------------");
  console.log(fmt(total));
  reportRobustMetrics("Metrics", total);
  console.log(
    `\nConfig: maxPos=$${cfg.maxPositionUsd}, dd<${cfg.drawdownExitPct}%, yield<${cfg.yieldDecayFraction}x, ` +
      `stopLoss=${cfg.stopLossEnabled ? cfg.stopLossPct : "off"}, hysteresis=${cfg.yieldHysteresis}, cooldown=${cfg.rotationCooldownMs / 60_000}m, ` +
      `entryCost=$${cfg.entryCostUsd}, exitCost=$${cfg.exitCostUsd}, slippage=${cfg.slippageBps}bps, fee/cost>=${cfg.minFeeCostRatio}x`,
  );
}
