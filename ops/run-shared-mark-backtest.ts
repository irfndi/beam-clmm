/**
 * Run the conservative mark-to-market model over all eligible pool snapshots
 * while enforcing one shared wallet. This file intentionally does not import
 * the executable ops/mark-backtest.ts module.
 */
import { Database } from "bun:sqlite";
import { computeClmmValueUsd, computeHodlValueUsd } from "../engine/pnl.js";
import { simulateSharedPortfolio, type SharedPortfolioEvent } from "./shared-portfolio-backtest.js";
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

const MEASURED_SOURCES = new Set(["datapi", "krystal", "geckoterminal"]);
const DAY_MS = 24 * 3_600_000;
const HALF_WIDTH_TICKS = 4_600;
const MIN_TVL_USD = 1_000;
const POOL_SHARE_CAP_PCT = 10;
const DRAWDOWN_EXIT_FRACTION = 5 / 100;
const YIELD_DECAY_FRACTION = 0.7;
const STOP_LOSS_PCT = 0.15;
const TRAILING_STOP_PCT = 0.1;
const ROTATION_COOLDOWN_MS = 15 * 60_000;
const MAX_FEE_GAP_MS = 30 * 60_000;

interface Snapshot {
  readonly timestamp: number;
  readonly currentPrice: number;
  readonly fees24hUsd: number;
  readonly tvlUsd: number;
  readonly activeBinId: number;
  readonly drawdown24h: number | null;
  readonly statsSource: string;
  readonly tokenXAddress: string | null;
  readonly tokenYAddress: string | null;
  readonly tokenXDecimals: number | null;
  readonly tokenYDecimals: number | null;
  readonly tokenXPriceUsd: number | null;
  readonly tokenYPriceUsd: number | null;
  readonly usdPair: VerifiedUsdPair | null;
  readonly verifiedUsd: boolean;
}

interface SnapshotRow {
  readonly timestamp: number;
  readonly current_price: number;
  readonly fees_24h_usd: number;
  readonly tvl_usd: number;
  readonly active_bin_id: number;
  readonly drawdown24h: number | null;
  readonly stats_source: string | null;
  readonly token_x_symbol: string | null;
  readonly token_y_symbol: string | null;
  readonly token_x_address: string | null;
  readonly token_y_address: string | null;
  readonly token_x_decimals: number | null;
  readonly token_y_decimals: number | null;
  readonly token_x_price_usd: number | null;
  readonly token_y_price_usd: number | null;
}

interface PoolRow {
  readonly pool: string;
}

interface SourceRow {
  readonly source: string;
  readonly count: number;
}

interface Position {
  readonly entryPriceUsd: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly depositedUsd: number;
  readonly entryAmountXUsd: number;
  readonly entryAmountYUsd: number;
  peakValueUsd: number;
  readonly usdPair: VerifiedUsdPair;
}

interface PoolState {
  position: Position | null;
  cooldownUntil: number;
  previousTimestamp: number | null;
}

interface Args {
  readonly dbPath: string;
  readonly days: number;
  readonly includeUnmeasured: boolean;
  readonly capital: number;
  readonly maxConcurrent: number;
  readonly maxDeployedPct: number;
  readonly maxPoolUsd: number;
  readonly entryCostUsd: number;
  readonly exitCostUsd: number;
  readonly slippageBps: number;
  readonly verifiedUsdOnly: boolean;
}

function finite(name: string, value: number, minimum = 0): number {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number >= ${minimum}`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): Args {
  let dbPath = "./beam.db";
  let days = 7;
  let includeUnmeasured = false;
  let capital = 10_000;
  let maxConcurrent = 3;
  let maxDeployedPct = 100;
  let maxPoolUsd = 1_500;
  let entryCostUsd = 0;
  let exitCostUsd = 0;
  let slippageBps = 0;
  let verifiedUsdOnly = true;
  const next = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--db") dbPath = next(arg, i++);
    else if (arg === "--days") days = finite(arg, Number(next(arg, i++)), Number.EPSILON);
    else if (arg === "--include-unmeasured") includeUnmeasured = true;
    else if (arg === "--capital") capital = finite(arg, Number(next(arg, i++)), Number.EPSILON);
    else if (arg === "--max-concurrent") {
      maxConcurrent = finite(arg, Number(next(arg, i++)));
      if (!Number.isInteger(maxConcurrent)) throw new Error(`${arg} must be an integer`);
    } else if (arg === "--max-deployed-pct") maxDeployedPct = finite(arg, Number(next(arg, i++)));
    else if (arg === "--max-pool-usd")
      maxPoolUsd = finite(arg, Number(next(arg, i++)), Number.EPSILON);
    else if (arg === "--entry-cost-usd") entryCostUsd = finite(arg, Number(next(arg, i++)));
    else if (arg === "--exit-cost-usd") exitCostUsd = finite(arg, Number(next(arg, i++)));
    else if (arg === "--slippage-bps") slippageBps = finite(arg, Number(next(arg, i++)));
    else if (arg === "--allow-unverified-price") verifiedUsdOnly = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (maxDeployedPct > 100) throw new Error("--max-deployed-pct must be <= 100");
  if (slippageBps > 10_000) throw new Error("--slippage-bps must be <= 10000");
  return {
    dbPath,
    days,
    includeUnmeasured,
    capital,
    maxConcurrent,
    maxDeployedPct,
    maxPoolUsd,
    entryCostUsd,
    exitCostUsd,
    slippageBps,
    verifiedUsdOnly,
  };
}

function markToMarket(position: Position, rawCurrentPrice: number): number {
  const { entryPriceUsd, lowerBinId, upperBinId, depositedUsd } = position;
  const currentPrice = rawRatioToUsd(rawCurrentPrice, position.usdPair);
  const lowerPriceRaw = rawTickToUsd(lowerBinId, position.usdPair);
  const upperPriceRaw = rawTickToUsd(upperBinId, position.usdPair);
  if (currentPrice === null || lowerPriceRaw === null || upperPriceRaw === null) {
    return depositedUsd;
  }
  const lowerPrice = Math.min(lowerPriceRaw, upperPriceRaw);
  const upperPrice = Math.max(lowerPriceRaw, upperPriceRaw);
  const clmm =
    lowerPrice < entryPriceUsd && entryPriceUsd < upperPrice
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
    position.entryAmountXUsd,
    position.entryAmountYUsd,
    entryPriceUsd,
    currentPrice,
  );
  return hodl !== null && Number.isFinite(hodl) && hodl > 0 ? hodl : depositedUsd;
}

function drawdown24h(snaps: readonly Snapshot[], index: number): number {
  return reconstructedDrawdown24h(snaps, index, DAY_MS);
}

/** Stored Krystal drawdown is percentage points; reconstructed drawdown is a fraction. */
function normalizedDrawdown(snapshot: Snapshot, snaps: readonly Snapshot[], index: number): number {
  const reconstructed = drawdown24h(snaps, index);
  // Prefer a USD-direction reconstruction whenever metadata is verified. A
  // stored raw-ratio drawdown can be inverted for stable/token pools.
  if (snapshot.usdPair !== null) return reconstructed;
  return normalizeStoredDrawdown(snapshot.drawdown24h) ?? reconstructed;
}

function trailingAvgYield(snaps: readonly Snapshot[], index: number): number | null {
  const now = snaps[index]!.timestamp;
  let sum = 0;
  let count = 0;
  for (let i = index; i >= 0; i--) {
    const snapshot = snaps[i]!;
    if (now - snapshot.timestamp > 7 * DAY_MS) break;
    if (snapshot.tvlUsd > 0) {
      sum += (snapshot.fees24hUsd / snapshot.tvlUsd) * 100;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

function validateSnapshot(snapshot: Snapshot, pool: string): void {
  if (
    !Number.isFinite(snapshot.timestamp) ||
    !Number.isFinite(snapshot.currentPrice) ||
    !Number.isFinite(snapshot.fees24hUsd) ||
    !Number.isFinite(snapshot.tvlUsd) ||
    !Number.isFinite(snapshot.activeBinId) ||
    snapshot.currentPrice <= 0 ||
    snapshot.tvlUsd < 0 ||
    (snapshot.drawdown24h !== null && !Number.isFinite(snapshot.drawdown24h))
  ) {
    throw new Error(`invalid snapshot data for ${pool} at ${snapshot.timestamp}`);
  }
}

function addFee(
  events: SharedPortfolioEvent[],
  timestamp: number,
  pool: string,
  amountUsd: number,
): void {
  if (amountUsd !== 0) events.push({ type: "fee", timestamp, pool, amountUsd });
}

function buildEvents(
  snapshotsByPool: ReadonlyMap<string, readonly Snapshot[]>,
  args: Args,
): {
  readonly events: SharedPortfolioEvent[];
  readonly entryRequests: number;
  readonly acceptedEntries: number;
  readonly feeGapCount: number;
} {
  const states = new Map<string, PoolState>();
  const timeline = [...snapshotsByPool.entries()]
    .flatMap(([pool, snapshots]) => snapshots.map((snapshot, index) => ({ pool, snapshot, index })))
    .sort((a, b) => {
      const timestampOrder = a.snapshot.timestamp - b.snapshot.timestamp;
      if (timestampOrder !== 0) return timestampOrder;
      const aYield = a.snapshot.tvlUsd > 0 ? a.snapshot.fees24hUsd / a.snapshot.tvlUsd : -Infinity;
      const bYield = b.snapshot.tvlUsd > 0 ? b.snapshot.fees24hUsd / b.snapshot.tvlUsd : -Infinity;
      return bYield - aYield || a.pool.localeCompare(b.pool);
    });
  const events: SharedPortfolioEvent[] = [];
  const maxDeployedUsd = args.capital * (args.maxDeployedPct / 100);
  // These values are acceptance shadows only. Costs are represented exactly
  // once in the emitted fee events consumed by simulateSharedPortfolio.
  let shadowCashUsd = args.capital;
  let shadowDeployedUsd = 0;
  let acceptedEntries = 0;
  let activePositions = 0;
  let entryRequests = 0;
  let feeGapCount = 0;

  for (const item of timeline) {
    const { pool, snapshot, index } = item;
    const state = states.get(pool) ?? { position: null, cooldownUntil: 0, previousTimestamp: null };
    validateSnapshot(snapshot, pool);
    const previousTimestamp = state.previousTimestamp;
    if (previousTimestamp !== null && snapshot.timestamp < previousTimestamp) {
      throw new Error(`snapshots are not chronological for ${pool}`);
    }
    const yieldPct = snapshot.tvlUsd > 0 ? (snapshot.fees24hUsd / snapshot.tvlUsd) * 100 : 0;
    const avgYield = trailingAvgYield(snapshotsByPool.get(pool)!, index);
    const dd = normalizedDrawdown(snapshot, snapshotsByPool.get(pool)!, index);

    if (state.position !== null) {
      const position = state.position;
      const mark = markToMarket(position, snapshot.currentPrice);
      position.peakValueUsd = Math.max(position.peakValueUsd, mark);
      events.push({ type: "mark", timestamp: snapshot.timestamp, pool, valueUsd: mark });
      const inRange =
        snapshot.activeBinId >= position.lowerBinId && snapshot.activeBinId <= position.upperBinId;
      if (inRange && snapshot.tvlUsd > 0) {
        const intervalMs =
          previousTimestamp === null ? 30_000 : snapshot.timestamp - previousTimestamp;
        if (intervalMs > MAX_FEE_GAP_MS) {
          feeGapCount++;
        } else {
          const fee =
            snapshot.fees24hUsd *
            Math.min(position.depositedUsd / snapshot.tvlUsd, 1) *
            (intervalMs / DAY_MS);
          addFee(events, snapshot.timestamp, pool, fee);
          shadowCashUsd += fee;
        }
      }
      const yieldDecayed =
        avgYield !== null && avgYield > 0 && yieldPct < avgYield * YIELD_DECAY_FRACTION;
      const lossPct = (mark - position.depositedUsd) / position.depositedUsd;
      const trailing = (position.peakValueUsd - mark) / position.peakValueUsd;
      const shouldExit =
        dd < -DRAWDOWN_EXIT_FRACTION ||
        yieldDecayed ||
        lossPct < -STOP_LOSS_PCT ||
        trailing > TRAILING_STOP_PCT;
      if (shouldExit) {
        const exitSlippage = mark * (args.slippageBps / 10_000);
        events.push({ type: "exit", timestamp: snapshot.timestamp, pool, valueUsd: mark });
        addFee(events, snapshot.timestamp, pool, -(args.exitCostUsd + exitSlippage));
        shadowCashUsd += mark - args.exitCostUsd - exitSlippage;
        shadowDeployedUsd -= position.depositedUsd;
        activePositions--;
        state.position = null;
        state.cooldownUntil = snapshot.timestamp + ROTATION_COOLDOWN_MS;
      }
    }

    if (state.position === null && snapshot.timestamp >= state.cooldownUntil) {
      const yieldDecayed =
        avgYield !== null && avgYield > 0 && yieldPct < avgYield * YIELD_DECAY_FRACTION;
      const eligible =
        snapshot.tvlUsd >= MIN_TVL_USD &&
        yieldPct > 0 &&
        dd > -DRAWDOWN_EXIT_FRACTION &&
        !yieldDecayed;
      if (eligible) {
        if (snapshot.usdPair === null) continue;
        const entryPriceUsd = rawRatioToUsd(snapshot.currentPrice, snapshot.usdPair);
        if (entryPriceUsd === null) continue;
        const size = Math.min(
          args.maxPoolUsd,
          snapshot.tvlUsd * (POOL_SHARE_CAP_PCT / 100),
          shadowCashUsd,
        );
        const entrySlippage = size * (args.slippageBps / 10_000);
        const entryCost = args.entryCostUsd + entrySlippage;
        entryRequests++;
        if (
          size > 0 &&
          shadowCashUsd >= size + entryCost &&
          shadowDeployedUsd + size <= maxDeployedUsd &&
          activePositions < args.maxConcurrent
        ) {
          const entryLegs = computeEntryHodlLegsUsd({
            depositedUsd: size,
            entryPriceUsd,
            lowerBinId: snapshot.activeBinId - HALF_WIDTH_TICKS,
            upperBinId: snapshot.activeBinId + HALF_WIDTH_TICKS,
            usdPair: snapshot.usdPair,
          });
          // Do not mutate the shadow wallet or emit an entry if the
          // concentrated-range HODL legs cannot be derived.
          if (entryLegs !== null) {
            events.push({
              type: "entry-request",
              timestamp: snapshot.timestamp,
              pool,
              amountUsd: size,
            });
            addFee(events, snapshot.timestamp, pool, -entryCost);
            shadowCashUsd -= size + entryCost;
            shadowDeployedUsd += size;
            acceptedEntries++;
            activePositions++;
            state.position = {
              entryPriceUsd,
              lowerBinId: snapshot.activeBinId - HALF_WIDTH_TICKS,
              upperBinId: snapshot.activeBinId + HALF_WIDTH_TICKS,
              depositedUsd: size,
              entryAmountXUsd: entryLegs.movingUsd,
              entryAmountYUsd: entryLegs.numeraireUsd,
              peakValueUsd: size,
              usdPair: snapshot.usdPair,
            };
          }
        }
      }
    }
    state.previousTimestamp = snapshot.timestamp;
    states.set(pool, state);
  }
  // Close positions at their last observed mark so final equity is realized.
  for (const [pool, state] of states) {
    const snapshots = snapshotsByPool.get(pool)!;
    const snapshot = snapshots[snapshots.length - 1];
    if (state.position !== null && snapshot !== undefined) {
      // Settle at this pool's last observed mark. Using one global synthetic
      // timestamp would keep stale positions open past their own data boundary
      // and distort shared-wallet ordering when pools have different coverage.
      const timestamp = snapshot.timestamp + 1;
      const mark = markToMarket(state.position, snapshot.currentPrice);
      events.push({ type: "mark", timestamp, pool, valueUsd: mark });
      events.push({ type: "exit", timestamp, pool, valueUsd: mark });
      addFee(events, timestamp, pool, -(args.exitCostUsd + mark * (args.slippageBps / 10_000)));
    }
  }
  const phase = (event: SharedPortfolioEvent): number =>
    event.type === "entry-request" ? 2 : event.type === "exit" ? 1 : 0;
  events.sort((a, b) => a.timestamp - b.timestamp || phase(a) - phase(b));
  return { events, entryRequests, acceptedEntries, feeGapCount };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(args.dbPath, { readonly: true });
  try {
    const columns = db.query("PRAGMA table_info(pool_snapshots)").all() as Array<{
      readonly name: string;
    }>;
    const required = [
      "pool_address",
      "timestamp",
      "current_price",
      "fees_24h_usd",
      "tvl_usd",
      "active_bin_id",
    ];
    if (
      columns.length === 0 ||
      required.some((name) => !columns.some((column) => column.name === name))
    ) {
      throw new Error("pool_snapshots schema is missing required columns");
    }
    const hasDrawdown = columns.some((column) => column.name === "drawdown24h");
    const hasSource = columns.some((column) => column.name === "stats_source");
    const hasTokenSymbols =
      columns.some((column) => column.name === "token_x_symbol") &&
      columns.some((column) => column.name === "token_y_symbol");
    const hasUsdMetadata = [
      "token_x_address",
      "token_y_address",
      "token_x_decimals",
      "token_y_decimals",
      "token_x_price_usd",
      "token_y_price_usd",
    ].every((name) => columns.some((column) => column.name === name));
    const endMs = Date.now();
    const startMs = endMs - args.days * DAY_MS;
    const sourceExpression = hasSource ? "stats_source" : "NULL";
    const sourceSelect = `${sourceExpression} AS stats_source`;
    const drawdownSelect = hasDrawdown ? "drawdown24h" : "NULL AS drawdown24h";
    const tokenXSelect = hasTokenSymbols ? "token_x_symbol" : "NULL AS token_x_symbol";
    const tokenYSelect = hasTokenSymbols ? "token_y_symbol" : "NULL AS token_y_symbol";
    const metadataSelect = hasUsdMetadata
      ? "token_x_address, token_y_address, token_x_decimals, token_y_decimals, token_x_price_usd, token_y_price_usd"
      : "NULL AS token_x_address, NULL AS token_y_address, NULL AS token_x_decimals, NULL AS token_y_decimals, NULL AS token_x_price_usd, NULL AS token_y_price_usd";
    const sourceRows = db
      .query(
        `SELECT COALESCE(${sourceExpression}, 'heuristic') AS source, COUNT(*) AS count FROM pool_snapshots WHERE timestamp>=? AND timestamp<=? GROUP BY source`,
      )
      .all(startMs, endMs) as SourceRow[];
    const totalRows = sourceRows.reduce((sum, row) => sum + row.count, 0);
    const measuredRows = sourceRows.reduce(
      (sum, row) => sum + (MEASURED_SOURCES.has(row.source) ? row.count : 0),
      0,
    );
    const pools = (
      db
        .query(
          "SELECT DISTINCT pool_address AS pool FROM pool_snapshots WHERE timestamp>=? AND timestamp<=? ORDER BY pool_address",
        )
        .all(startMs, endMs) as PoolRow[]
    ).map((row) => row.pool);
    const snapshotsByPool = new Map<string, Snapshot[]>();
    for (const pool of pools) {
      const rows = db
        .query(
          `SELECT timestamp, current_price, fees_24h_usd, tvl_usd, active_bin_id, ${drawdownSelect}, ${tokenXSelect}, ${tokenYSelect}, ${metadataSelect}, ${sourceSelect} FROM pool_snapshots WHERE pool_address=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp`,
        )
        .all(pool, startMs, endMs) as SnapshotRow[];
      const snapshots = rows
        .map((row) => {
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
            tokenXAddress: row.token_x_address,
            tokenYAddress: row.token_y_address,
            tokenXDecimals: row.token_x_decimals,
            tokenYDecimals: row.token_y_decimals,
            tokenXPriceUsd: row.token_x_price_usd,
            tokenYPriceUsd: row.token_y_price_usd,
            usdPair:
              usdPair ??
              (args.verifiedUsdOnly ? null : { scale: 1, invert: false, stablePriceUsd: 1 }),
            verifiedUsd: usdPair !== null,
          };
        })
        .filter(
          (snapshot) =>
            (args.includeUnmeasured || MEASURED_SOURCES.has(snapshot.statsSource)) &&
            (!args.verifiedUsdOnly || snapshot.verifiedUsd),
        );
      for (const snapshot of snapshots) validateSnapshot(snapshot, pool);
      if (snapshots.length > 0) snapshotsByPool.set(pool, snapshots);
    }
    const built = buildEvents(snapshotsByPool, args);
    const simulatedTimestamps = [...snapshotsByPool.values()]
      .flat()
      .map((snapshot) => snapshot.timestamp)
      .sort((a, b) => a - b);
    const observedStart = simulatedTimestamps[0];
    const observedEnd = simulatedTimestamps[simulatedTimestamps.length - 1];
    const observedMs =
      observedStart === undefined || observedEnd === undefined ? 0 : observedEnd - observedStart;
    const result = simulateSharedPortfolio(built.events, {
      initialCapitalUsd: args.capital,
      maxConcurrentPositions: args.maxConcurrent,
      maxTotalDeployedUsd: args.capital * (args.maxDeployedPct / 100),
      maxAllocationPerPoolUsd: args.maxPoolUsd,
    });
    console.log(
      `Shared mark backtest: ${args.dbPath}, ${args.days}d, mode=${args.includeUnmeasured ? "include-unmeasured" : "measured-only"}, ` +
        `price=${args.verifiedUsdOnly ? "verified-stable-leg" : "UNVERIFIED-RAW-RATIO"}`,
    );
    console.log(
      `Source coverage: pools=${snapshotsByPool.size}/${pools.length}, snapshots=${totalRows}, measured=${measuredRows}, unmeasured=${totalRows - measuredRows}, simulated=${[...snapshotsByPool.values()].reduce((sum, rows) => sum + rows.length, 0)}`,
    );
    console.log(
      `Observed timeline: ${(observedMs / DAY_MS).toFixed(2)}d of ${args.days.toFixed(2)}d requested${
        observedMs < args.days * DAY_MS
          ? " (INCOMPLETE — do not treat as a full-window result)"
          : ""
      }`,
    );
    console.log(
      `Entries: accepted=${built.acceptedEntries}, rejected=${built.entryRequests - built.acceptedEntries}, requests=${built.entryRequests}`,
    );
    console.log(`Fee accrual gaps skipped (>30m): ${built.feeGapCount}`);
    console.log(
      `Results: final equity=$${result.finalEquityUsd.toFixed(2)}, net PnL=$${result.netPnlUsd.toFixed(2)}, max drawdown=$${result.maxDrawdownUsd.toFixed(2)} (${(result.maxDrawdownPct * 100).toFixed(2)}%)`,
    );
    console.log("Concentration:");
    for (const [pool, exposure] of Object.entries(result.perPoolExposureConcentration))
      console.log(
        `  ${pool}: peak=$${exposure.peakDeployedUsd.toFixed(2)}, peak share=${(exposure.peakShareOfDeployed * 100).toFixed(2)}%`,
      );
    console.log(
      "Economics: builder shadow cash is used only for acceptance; entry/exit costs are emitted once as simulator fee events.",
    );
    console.log(
      "Model limitations: fixed ±4,600-bin ranges; proportional 24h-fee accrual while in range; reconstructed 24h drawdown when absent; stored drawdown normalized from percentage points to fractions; same-timestamp events use marks/all fee cash flows, then exits, then entries, with pool-address tie-breaking; simplified yield/drawdown/stop/trailing exit gates; no gas, latency, adverse selection, or live execution.",
    );
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
