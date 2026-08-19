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
 */
import { Database } from "bun:sqlite";
import { computeClmmValueUsd, computeHodlValueUsd } from "../engine/pnl.js";

interface Snapshot {
  timestamp: number;
  currentPrice: number;
  fees24hUsd: number;
  tvlUsd: number;
  activeBinId: number;
  drawdown24h: number | null;
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
}

interface PoolResult {
  pool: string;
  trades: number;
  wins: number;
  realizedPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  finalValueUsd: number;
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
}

interface BacktestArgs {
  dbPath: string;
  days: number;
  sweep: boolean;
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
};

function markToMarket(pos: Position, currentPrice: number): number {
  const { entryPriceUsd, lowerBinId, upperBinId, depositedUsd } = pos;
  if (!(entryPriceUsd > 0) || !(currentPrice > 0)) return depositedUsd;
  const Pa = Math.pow(1.0001, lowerBinId);
  const Pb = Math.pow(1.0001, upperBinId);
  const entryInRange = Pa < entryPriceUsd && entryPriceUsd < Pb;
  const clmm = entryInRange
    ? computeClmmValueUsd({
        depositedUsd,
        entryPriceUsd,
        lowerBinId,
        upperBinId,
        currentPriceUsd: currentPrice,
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
  const now = snaps[i]!.timestamp;
  const price = snaps[i]!.currentPrice;
  let peak = price;
  for (let j = i; j >= 0; j--) {
    if (now - snaps[j]!.timestamp > 24 * 3_600_000) break;
    peak = Math.max(peak, snaps[j]!.currentPrice);
  }
  return peak > 0 ? (price - peak) / peak : 0;
}

function trailingAvgYield(
  snaps: readonly Snapshot[],
  i: number,
  windowMs = 7 * 24 * 3_600_000,
): number | null {
  const now = snaps[i]!.timestamp;
  let sum = 0;
  let count = 0;
  for (let j = i; j >= 0; j--) {
    if (now - snaps[j]!.timestamp > windowMs) break;
    const s = snaps[j]!;
    if (s.tvlUsd > 0) {
      sum += (s.fees24hUsd / s.tvlUsd) * 100;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

export function simulatePool(snaps: readonly Snapshot[], cfg: Config): PoolResult {
  let position: Position | null = null;
  let cashUsd = cfg.portfolioUsd;
  let realizedPnlUsd = 0;
  let feesUsd = 0;
  let trades = 0;
  let wins = 0;
  let cooldownUntil = 0;

  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i]!;
    const yieldPct = s.tvlUsd > 0 ? (s.fees24hUsd / s.tvlUsd) * 100 : 0;
    const avgYield = trailingAvgYield(snaps, i);
    const dd = s.drawdown24h ?? drawdown24h(snaps, i);

    if (position === null) {
      // ── ENTER gate ──
      const yieldDecayed =
        cfg.yieldHysteresis &&
        avgYield !== null &&
        avgYield > 0 &&
        yieldPct < avgYield * cfg.yieldDecayFraction;
      const eligible =
        s.tvlUsd >= cfg.minTvlUsd &&
        yieldPct > 0 &&
        dd > -cfg.drawdownExitPct &&
        !yieldDecayed &&
        s.timestamp >= cooldownUntil;
      if (eligible) {
        const tvlCapUsd = s.tvlUsd * (cfg.poolShareCapPct / 100);
        const size = Math.min(cfg.maxPositionUsd, tvlCapUsd, cashUsd);
        if (size > 0) {
          position = {
            entryPriceUsd: s.currentPrice,
            lowerBinId: s.activeBinId - cfg.halfWidthTicks,
            upperBinId: s.activeBinId + cfg.halfWidthTicks,
            depositedUsd: size,
            entryAmountXUsd: size / 2,
            entryAmountYUsd: size / 2,
            entryMs: s.timestamp,
            peakValueUsd: size,
          };
          cashUsd -= size;
        }
      }
      continue;
    }

    // ── In-position: mark, fees, exits ──
    const mark = markToMarket(position, s.currentPrice);
    position.peakValueUsd = Math.max(position.peakValueUsd, mark);

    // Proportional fee share while in-range.
    const inRange = s.activeBinId >= position.lowerBinId && s.activeBinId <= position.upperBinId;
    if (inRange && s.tvlUsd > 0) {
      const intervalMs = i > 0 ? s.timestamp - snaps[i - 1]!.timestamp : 30_000;
      const share = Math.min(position.depositedUsd / s.tvlUsd, 1);
      const fee = s.fees24hUsd * share * (intervalMs / (24 * 3_600_000));
      feesUsd += fee;
      cashUsd += fee;
    }

    let exitReason: string | null = null;
    const yieldDecayed =
      avgYield !== null && avgYield > 0 && yieldPct < avgYield * cfg.yieldDecayFraction;
    if (dd < -cfg.drawdownExitPct) exitReason = `drawdown ${(dd * 100).toFixed(1)}%`;
    else if (yieldDecayed) exitReason = `yield ${yieldPct.toFixed(1)}%/d decayed`;
    else if (cfg.stopLossEnabled) {
      const lossPct = (mark - position.depositedUsd) / position.depositedUsd;
      if (lossPct < -cfg.stopLossPct) exitReason = `stop-loss ${(lossPct * 100).toFixed(1)}%`;
    }
    if (exitReason === null) {
      const drawdown = (position.peakValueUsd - mark) / position.peakValueUsd;
      if (drawdown > cfg.trailingStopPct) exitReason = `trailing ${(drawdown * 100).toFixed(1)}%`;
    }

    if (exitReason !== null) {
      const pnl = mark - position.depositedUsd;
      realizedPnlUsd += pnl;
      cashUsd += mark;
      if (pnl >= 0) wins++;
      trades++;
      position = null;
      cooldownUntil = s.timestamp + cfg.rotationCooldownMs;
    }
  }

  // Close any open position at the final mark.
  if (position !== null) {
    const mark = markToMarket(position, snaps[snaps.length - 1]!.currentPrice);
    realizedPnlUsd += mark - position.depositedUsd;
    cashUsd += mark;
    trades++;
  }

  return {
    pool: "",
    trades,
    wins,
    realizedPnlUsd,
    feesUsd,
    netPnlUsd: realizedPnlUsd + feesUsd,
    finalValueUsd: cashUsd,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): BacktestArgs {
  const out = { dbPath: "./beam.db", days: 7, sweep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--db" && argv[i + 1]) out.dbPath = argv[++i]!;
    else if (a === "--days" && argv[i + 1]) out.days = Number(argv[++i]!);
    else if (a === "--sweep") out.sweep = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const db = new Database(args.dbPath);

const poolRows = db
  .query(`SELECT DISTINCT pool_address AS p FROM positions ORDER BY pool_address`)
  .all();
// SAFETY: the SELECT aliases its sole text column to `p`.
const pools = poolRows as PoolRow[];
const poolAddresses = pools.map((row) => row.p);

const endMs = Date.now();
const startMs = endMs - args.days * 24 * 3_600_000;

const hasDrawdownColumn = (() => {
  try {
    // SAFETY: PRAGMA table_info always returns rows with a text `name` column.
    const cols = db.query("PRAGMA table_info(pool_snapshots)").all() as SchemaRow[];
    return cols.some((row) => row.name === "drawdown24h");
  } catch {
    return false;
  }
})();

function loadSnapshots(pool: string): Snapshot[] {
  const select = hasDrawdownColumn
    ? `SELECT timestamp, current_price, fees_24h_usd, tvl_usd, active_bin_id, drawdown24h
       FROM pool_snapshots WHERE pool_address=? AND timestamp>=? AND timestamp<=?
       ORDER BY timestamp`
    : `SELECT timestamp, current_price, fees_24h_usd, tvl_usd, active_bin_id, NULL AS drawdown24h
       FROM pool_snapshots WHERE pool_address=? AND timestamp>=? AND timestamp<=?
       ORDER BY timestamp`;
  // SAFETY: the SELECT supplies exactly these numeric columns and a nullable drawdown alias.
  return (db.query(select).all(pool, startMs, endMs) as SnapshotRow[]).map((row) => ({
    timestamp: row.timestamp,
    currentPrice: row.current_price,
    fees24hUsd: row.fees_24h_usd,
    tvlUsd: row.tvl_usd,
    activeBinId: row.active_bin_id,
    drawdown24h: row.drawdown24h,
  }));
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

if (args.sweep) {
  const rows: string[] = [];
  for (const dd of [3, 5, 7, 10]) {
    for (const yf of [0.5, 0.7, 1.0]) {
      const cfg: Config = { ...DEFAULT_CONFIG, drawdownExitPct: dd, yieldDecayFraction: yf };
      const results = poolAddresses.map((p) => simulatePool(loadSnapshots(p), { ...cfg }));
      const total = aggregate(results);
      rows.push(
        `dd<${String(dd).padStart(2)}%  yield<${yf.toFixed(1).padStart(3)}x  ` +
          `trades=${String(total.trades).padStart(3)}  fees=$${total.feesUsd.toFixed(0).padStart(6)}  ` +
          `realized=$${total.realizedPnlUsd.toFixed(0).padStart(6)}  net=$${total.netPnlUsd.toFixed(0).padStart(6)}  win=${total.trades ? ((total.wins / total.trades) * 100).toFixed(0) : 0}%`,
      );
    }
  }
  console.log("THRESHOLD SWEEP (net PnL = realized + fees):");
  console.log(rows.join("\n"));
} else if (process.argv.includes("--fix-impact")) {
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
    const cfg: Config =
      label === "ALL fixes" ? { ...DEFAULT_CONFIG } : { ...baseline, ...overrides };
    const results = poolAddresses.map((p) => simulatePool(loadSnapshots(p), cfg));
    const total = aggregate(results);
    rows.push(
      `${label.padEnd(22)}  trades=${String(total.trades).padStart(3)}  fees=$${total.feesUsd.toFixed(0).padStart(5)}  ` +
        `realized=$${total.realizedPnlUsd.toFixed(0).padStart(6)}  net=$${total.netPnlUsd.toFixed(0).padStart(6)}  win=${total.trades ? ((total.wins / total.trades) * 100).toFixed(0) : 0}%`,
    );
  }
  console.log("FIX-IMPACT A/B (net PnL = realized + fees):");
  console.log(rows.join("\n"));
} else {
  const cfg = DEFAULT_CONFIG;
  const results = poolAddresses.map((p) => {
    const r = simulatePool(loadSnapshots(p), cfg);
    r.pool = p;
    return r;
  });
  console.log("POOL       trades  win%   fees   realzd  netPnl");
  for (const r of results) console.log(fmt(r));
  const total = aggregate(results);
  total.pool = "ALL";
  console.log("------------------------------------------------");
  console.log(fmt(total));
  console.log(
    `\nConfig: maxPos=$${cfg.maxPositionUsd}, dd<${cfg.drawdownExitPct}%, yield<${cfg.yieldDecayFraction}x, ` +
      `stopLoss=${cfg.stopLossEnabled ? cfg.stopLossPct : "off"}, hysteresis=${cfg.yieldHysteresis}, cooldown=${cfg.rotationCooldownMs / 60_000}m`,
  );
}
