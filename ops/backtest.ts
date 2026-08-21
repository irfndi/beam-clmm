/**
 * Backtest — replays historical pool data through the DLMM strategy
 * to evaluate decision quality without spending real capital.
 *
 * Two sources:
 *   - synthetic: deterministic mock generator (regression baseline)
 *   - replay:    snapshots stored in SQLite by a live paper run
 *                (set ENABLE_SNAPSHOT_CAPTURE=true on the agent)
 *
 * Usage:
 *   bun run backtest                                          # default: synthetic, 7d
 *   bun run ops/backtest.ts --days 30 --pools <addr1,addr2>
 *   bun run ops/backtest.ts --source replay --db ./beam.db
 */
import { Effect } from "effect";
import { createLogger } from "../engine/logger.js";
import { DLMMStrategy } from "../engine/strategy-service.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import type { BacktestResult, BinArray, PoolSnapshot, PoolState } from "../engine/types.js";
import { evaluateReplayPool } from "../engine/cycle/evaluate-pool.js";

const log = createLogger("Backtest");

// ─── CLI parsing ─────────────────────────────────────────────────────────────

interface CliArgs {
  days: number;
  pools: ReadonlyArray<string>;
  source: "synthetic" | "replay";
  dbPath: string;
  minPoolTvlUsd: number;
  minPoolTvlExplicit: boolean;
  challengeMode: boolean;
  challengeMinScore: number;
  roundTripGasUsd: number;
  min7dFeeOverGas: number;
}

export function replayUsesMeasuredVolume(source: PoolState["statsSource"]): boolean {
  return source === "datapi" || source === "krystal";
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const out: CliArgs = {
    days: 7,
    pools: ["5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"],
    source: "synthetic",
    dbPath: "./beam.db",
    minPoolTvlUsd: 50_000,
    minPoolTvlExplicit: false,
    challengeMode: false,
    challengeMinScore: 4,
    roundTripGasUsd: 0,
    min7dFeeOverGas: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--days" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 3650) {
        throw new Error(
          `Invalid --days value: ${next}. Must be a finite number between 1 and 3650.`,
        );
      }
      out.days = parsed;
      i++;
    } else if (a === "--min-tvl" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --min-tvl value: ${next}. Must be a non-negative number.`);
      }
      out.minPoolTvlUsd = parsed;
      out.minPoolTvlExplicit = true;
      i++;
    } else if (a === "--challenge") {
      out.challengeMode = true;
      if (!out.minPoolTvlExplicit) out.minPoolTvlUsd = 1_000;
    } else if (a === "--challenge-min-score" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(
          `Invalid --challenge-min-score value: ${next}. Must be a non-negative number.`,
        );
      }
      out.challengeMinScore = parsed;
      i++;
    } else if (a === "--gas-usd" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --gas-usd value: ${next}. Must be a non-negative number.`);
      }
      out.roundTripGasUsd = parsed;
      i++;
    } else if (a === "--min-7d-fee-over-gas" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(
          `Invalid --min-7d-fee-over-gas value: ${next}. Must be a non-negative number.`,
        );
      }
      out.min7dFeeOverGas = parsed;
      i++;
    } else if (a === "--pools" && next) {
      out.pools = next
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i++;
    } else if (a === "--source" && (next === "synthetic" || next === "replay")) {
      out.source = next;
      i++;
    } else if (a === "--db" && next) {
      out.dbPath = next;
      i++;
    }
  }
  return out;
}

// ─── Synthetic data (regression baseline) ────────────────────────────────────

interface HistoryTick {
  pool: PoolState;
  binArray: BinArray;
}

function generateMockHistory(poolAddress: string, days: number, startTvl: number): HistoryTick[] {
  const history: HistoryTick[] = [];
  const intervalMs = 10 * 60 * 1000; // 10 min
  const ticks = (days * 24 * 60 * 60 * 1000) / intervalMs;
  let seed = 0x811c9dc5;
  for (const char of poolAddress) seed = Math.imul(seed ^ char.charCodeAt(0), 0x01000193);
  const random = (): number => {
    seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
    seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
    return ((seed ^ (seed >>> 16)) >>> 0) / 0x1_0000_0000;
  };

  let tvl = startTvl;
  let price = 100;
  let activeBin = 5000;
  let trend = 0;
  let volatility = 0.015;

  for (let i = 0; i < ticks; i++) {
    const timestamp = Date.now() - (ticks - i) * intervalMs;

    if (i % 720 === 0) {
      volatility = 0.005 + random() * 0.025;
      trend = (random() - 0.5) * 0.004;
    }

    if (random() < 0.02) {
      const jump = (random() - 0.5) * 0.08;
      price *= 1 + jump;
      activeBin += Math.floor(jump * 200);
    }

    const shock = (random() - 0.5) * volatility * 2;
    tvl *= 1 + (random() - 0.49) * 0.02;
    price *= 1 + trend + shock;
    activeBin += Math.floor(trend * 200 + shock * 100 + (random() - 0.5) * 10);

    const pool: PoolState = {
      address: poolAddress,
      tokenX: "So11111111111111111111111111111111111111112",
      tokenY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      tokenXSymbol: "ETH",
      tokenYSymbol: "USDC",
      tvlUsd: Math.max(tvl, 1000),
      volume24hUsd: tvl * (0.3 + Math.random() * 0.5),
      fees24hUsd: tvl * 0.003 * (0.5 + Math.random() * 0.5),
      apr: 40 + Math.random() * 80,
      activeBinId: activeBin,
      binStep: 10,
      currentPrice: price,
      timestamp,
      // Synthetic ticks FABRICATE volume/fees, so they are explicitly classified
      // as the fabricated source — NOT datapi. This keeps the measured-fee-rate
      // authenticity check DISABLED here, exactly as the trust model intends for
      // a source-less pool (unknown != datapi).
      statsSource: "heuristic",
    };

    const bins = Array.from({ length: 40 }, (_, j) => ({
      binId: activeBin - 20 + j,
      price: price * (1 + (j - 20) * 0.001),
      reserveX: BigInt(Math.floor(random() * 1e9)),
      reserveY: BigInt(Math.floor(random() * 1e9)),
      liquiditySupply: BigInt(Math.floor(random() * 1e12)),
    }));

    const binArray: BinArray = {
      lowerBinId: activeBin - 20,
      upperBinId: activeBin + 20,
      bins,
      activeBinId: activeBin,
    };

    history.push({ pool, binArray });
  }

  return history;
}

// ─── Snapshot loading (replay source) ─────────────────────────────────────────

async function loadSnapshots(
  dbPath: string,
  pool: string,
  endMs: number,
  days: number,
): Promise<ReadonlyArray<PoolSnapshot>> {
  const layer = DbLive(dbPath);
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const effect = Effect.gen(function* () {
    const db = yield* DbService;
    return yield* db.getSnapshots(pool, startMs, endMs);
  });
  try {
    const snapshots = await Effect.runPromise(Effect.provide(effect, layer));
    const usable = snapshots.filter((snapshot) => snapshot.binArray.bins.length > 0);
    if (usable.length !== snapshots.length) {
      log.warn("Replay skipped snapshots without bin liquidity data", {
        pool,
        skipped: snapshots.length - usable.length,
        usable: usable.length,
      });
    }
    return usable;
  } catch (err) {
    log.error("Failed to load snapshots", { pool, dbPath, err });
    return [];
  }
}

// ─── Strategy params + run loop (shared by both sources) ─────────────────────

interface BacktestConfig {
  halfWidth: number;
  driftThreshold: number;
  minHoldTicks: number;
  minNetBenefitUsd: number;
  maxRebalances: number;
  maxPositionsPerPool: number;
  minPoolTvlUsd?: number;
  challengeMode?: boolean;
  challengeMinScore?: number;
  challengeMinPoolAgeMs?: number;
  roundTripGasUsd?: number;
  min7dFeeOverGas?: number;
}

export function runBacktestFromTicks(
  ticks: ReadonlyArray<HistoryTick>,
  cfg: BacktestConfig,
): BacktestResult {
  const strategy = DLMMStrategy;
  const initialValue = 10_000;
  let cashUsd = initialValue;
  let rebalances = 0;
  let wins = 0;
  let totalFees = 0;
  let totalIl = 0;

  if (ticks.length === 0) {
    throw new Error("Empty history");
  }

  let previousTvl = ticks[0]!.pool.tvlUsd;
  let currentLowerBinId = ticks[0]!.pool.activeBinId - cfg.halfWidth;
  let currentUpperBinId = ticks[0]!.pool.activeBinId + cfg.halfWidth;
  let hasPosition = false;
  let positionSizeUsd = 0;
  let positionValueUsd = 0;
  let positionPeakUsd = 0;
  let lastRebalanceTick = -cfg.minHoldTicks;
  // Live-chain parity state (engine/program.ts evaluatePool): the #153
  // trailing-stop confirm-cycles debounce and the challenge hard-floor /
  // loss-cooldown gates carry state across cycles.
  let trailingStopBreaches = 0;
  let stopLossBreaches = 0;
  let challengePeakEquityUsd = initialValue;

  const strategyReturns: Array<{ value: number; intervalMs: number }> = [];
  let previousEquityUsd = initialValue;

  // fees24hUsd is a rolling 24-hour aggregate. Accrue it over the actual
  // elapsed interval between snapshots; using one inferred interval silently
  // misprices databases with gaps or duplicate timestamps.
  function feesForInterval(tick: HistoryTick, intervalMs: number): number {
    const tvl = tick.pool.tvlUsd;
    if (!(tvl > 0) || !(positionSizeUsd > 0) || !(intervalMs > 0)) return 0;
    const positionShare = Math.min(positionSizeUsd / tvl, 1);
    return Math.max(0, tick.pool.fees24hUsd) * (intervalMs / (24 * 3_600_000)) * positionShare;
  }

  function estimatedFeesForDuration(tick: HistoryTick, durationMs: number): number {
    return feesForInterval(tick, durationMs);
  }

  function equityUsd(): number {
    return cashUsd + (hasPosition ? positionValueUsd : 0);
  }

  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!;
    const intervalMs = i > 0 ? Math.max(0, tick.pool.timestamp - ticks[i - 1]!.pool.timestamp) : 0;
    const metrics = strategy.computeMetrics(tick.pool, tick.binArray, previousTvl);
    // Match computeMetrics' wiring so this standalone auth score stays consistent
    // with metrics.volumeAuthenticity: fees are measured only under the Data API.
    const auth = strategy.checkVolumeAuthenticity(
      tick.pool,
      replayUsesMeasuredVolume(tick.pool.statsSource),
    );
    const inRange =
      tick.pool.activeBinId >= currentLowerBinId && tick.pool.activeBinId <= currentUpperBinId;
    positionValueUsd = hasPosition ? (inRange ? positionSizeUsd : positionSizeUsd * 0.8) : 0;
    const feesThisTick = hasPosition && inRange ? feesForInterval(tick, intervalMs) : 0;
    totalFees += feesThisTick;
    cashUsd += feesThisTick;
    if (hasPosition) positionPeakUsd = Math.max(positionPeakUsd, positionValueUsd);

    const preFilterPassed = strategy.passesPreFilter(
      tick.pool,
      auth.score,
      metrics.binUtilization,
      cfg.minPoolTvlUsd ?? 50_000,
      0.7,
      0.3,
    );
    // A pre-filter may prevent a new entry, but it must not suppress exits for
    // an existing position. Capital-protection decisions remain evaluable.
    if (!preFilterPassed && !hasPosition) {
      previousTvl = tick.pool.tvlUsd;
      const equity = equityUsd();
      if (intervalMs > 0 && previousEquityUsd > 0) {
        strategyReturns.push({
          value: (equity - previousEquityUsd) / previousEquityUsd,
          intervalMs,
        });
      }
      previousEquityUsd = equity;
      continue;
    }

    const portfolioValue = equityUsd();

    const replayPosition = hasPosition
      ? {
          poolAddress: tick.pool.address,
          positionPubKey: `replay-${tick.pool.address}`,
          lowerBinId: currentLowerBinId,
          upperBinId: currentUpperBinId,
          depositedUsd: positionSizeUsd,
          currentValueUsd: inRange ? positionSizeUsd : positionSizeUsd * 0.8,
          highestValueUsd: positionPeakUsd,
        }
      : undefined;
    challengePeakEquityUsd = Math.max(challengePeakEquityUsd, portfolioValue);
    const replay = evaluateReplayPool({
      poolAddress: tick.pool.address,
      activeBinId: tick.pool.activeBinId,
      metrics,
      position: replayPosition,
      openPositions: replayPosition ? [replayPosition] : [],
      portfolioValueUsd: portfolioValue,
      recentPnlUsd: portfolioValue - initialValue,
      memoryWarningCount: 0,
      confidenceThreshold: 0.65,
      trailingStopPct: 0.1,
      risk: {
        confidenceThreshold: 0.65,
        maxRebalanceRangeBins: cfg.halfWidth * 2,
        stopLossPct: 0.15,
        maxPerPoolAllocationPct: 0.4,
        maxPositionsPerPool: cfg.maxPositionsPerPool,
      },
      proposedSizeUsd: Math.min(portfolioValue * 0.2, 2_000),
      // Live config values (engine/config-service.ts defaults) so the replay
      // gates mirror the live engine's evaluatePool decision chain.
      poolTvlUsd: tick.pool.tvlUsd,
      trailingStopConfirmCycles: 2,
      minFeeIlRatio: 1.2,
      volumeAuthThreshold: 0.7,
      minBinUtilization: 0.3,
      minPoolTvlUsd: cfg.minPoolTvlUsd ?? 50_000,
      weightedEntryScoreThreshold: 0.6,
      ilProtectionEnabled: true,
      dustExitUsd: 5,
      tvlDropExitPct: 0.3,
      maxOpenPositions: 3,
      challengeMode: cfg.challengeMode === true,
      challengeMinScore: cfg.challengeMinScore ?? 4,
      challengeMinPoolAgeMs: cfg.challengeMinPoolAgeMs ?? 6 * 3_600_000,
      poolAgeMs: tick.pool.timestamp - ticks[0]!.pool.timestamp,
      nowMs: tick.pool.timestamp,
      enterRoundTripGasUsd: cfg.roundTripGasUsd ?? 0,
      enterMin7dFeeOverGas: cfg.min7dFeeOverGas ?? 1,
      trailingStopBreaches,
      stopLossBreaches,
    });
    // Advance the #153 breach counter BEFORE the risk gate: live counts
    // breaches in evaluatePool, so a risk-rejected HOLD tick must still
    // accumulate toward the confirm-cycles EXIT.
    trailingStopBreaches = replay.trailingStopBreachCount;
    stopLossBreaches = replay.stopLossBreachCount;
    if (!replay.riskApproved) {
      previousTvl = tick.pool.tvlUsd;
      const equity = equityUsd();
      if (intervalMs > 0 && previousEquityUsd > 0) {
        strategyReturns.push({
          value: (equity - previousEquityUsd) / previousEquityUsd,
          intervalMs,
        });
      }
      previousEquityUsd = equity;
      continue;
    }
    if (replay.decision.action === "ENTER") {
      if (!hasPosition) {
        const size = Math.min(replay.adjustedSizeUsd, cashUsd);
        if (size > 0) {
          hasPosition = true;
          positionSizeUsd = size;
          positionValueUsd = size;
          positionPeakUsd = size;
          cashUsd -= size;
          currentLowerBinId = tick.pool.activeBinId - cfg.halfWidth;
          currentUpperBinId = tick.pool.activeBinId + cfg.halfWidth;
          lastRebalanceTick = i;
          trailingStopBreaches = 0;
          stopLossBreaches = 0;
        }
      }
    } else if (replay.decision.action === "EXIT") {
      if (hasPosition) cashUsd += positionValueUsd;
      hasPosition = false;
      positionSizeUsd = 0;
      positionValueUsd = 0;
      positionPeakUsd = 0;
      trailingStopBreaches = 0;
      stopLossBreaches = 0;
    } else if (hasPosition) {
      positionPeakUsd = Math.max(positionPeakUsd, positionValueUsd);
    }

    const positionCenter = (currentLowerBinId + currentUpperBinId) / 2;
    const positionHalfWidth = (currentUpperBinId - currentLowerBinId) / 2 || 1;
    const binDrift = hasPosition
      ? Math.abs(tick.pool.activeBinId - positionCenter) / positionHalfWidth
      : 0;

    const ticksSinceRebalance = i - lastRebalanceTick;
    const canRebalance =
      hasPosition && rebalances < cfg.maxRebalances && ticksSinceRebalance >= cfg.minHoldTicks;

    if (canRebalance && binDrift > cfg.driftThreshold) {
      const ilCost = portfolioValue * 0.001 * binDrift;
      const swapCost = portfolioValue * 0.0005;
      const totalCost = ilCost + swapCost;
      const expectedIntervalMs = intervalMs > 0 ? intervalMs : 10 * 60 * 1000;
      const expectedFeesAhead =
        estimatedFeesForDuration(tick, expectedIntervalMs * cfg.minHoldTicks) * 0.7;
      const netBenefit = expectedFeesAhead - totalCost;

      if (netBenefit > cfg.minNetBenefitUsd) {
        rebalances++;
        totalIl += totalCost;
        cashUsd = Math.max(0, cashUsd - totalCost);
        currentLowerBinId = tick.pool.activeBinId - cfg.halfWidth;
        currentUpperBinId = tick.pool.activeBinId + cfg.halfWidth;
        lastRebalanceTick = i;
        let feesInNextWindow = 0;
        for (let j = i + 1; j < Math.min(i + cfg.minHoldTicks, ticks.length); j++) {
          const nextTick = ticks[j]!;
          const nextInRange =
            nextTick.pool.activeBinId >= currentLowerBinId &&
            nextTick.pool.activeBinId <= currentUpperBinId;
          const priorTick = j > 0 ? ticks[j - 1]! : tick;
          const nextIntervalMs = nextTick.pool.timestamp - priorTick.pool.timestamp;
          if (nextInRange) feesInNextWindow += estimatedFeesForDuration(nextTick, nextIntervalMs);
        }
        if (feesInNextWindow > totalCost) wins++;
      }
    }

    previousTvl = tick.pool.tvlUsd;
    const equity = equityUsd();
    if (intervalMs > 0 && previousEquityUsd > 0) {
      strategyReturns.push({ value: (equity - previousEquityUsd) / previousEquityUsd, intervalMs });
    }
    previousEquityUsd = equity;
  }

  if (hasPosition) cashUsd += positionValueUsd;
  const finalValueUsd = cashUsd;
  const mean =
    strategyReturns.length > 0
      ? strategyReturns.reduce((sum, sample) => sum + sample.value, 0) / strategyReturns.length
      : 0;
  const variance =
    strategyReturns.length > 0
      ? strategyReturns.reduce((sum, sample) => sum + Math.pow(sample.value - mean, 2), 0) /
        strategyReturns.length
      : 0;
  const averageIntervalMs =
    strategyReturns.length > 0
      ? strategyReturns.reduce((sum, sample) => sum + sample.intervalMs, 0) / strategyReturns.length
      : 10 * 60 * 1000;
  const ticksPerYear = (365 * 24 * 60 * 60 * 1000) / Math.max(averageIntervalMs, 1);
  const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(ticksPerYear) : 0;

  return {
    poolAddress: ticks[0]!.pool.address,
    startDate: ticks[0]!.pool.timestamp,
    endDate: ticks[ticks.length - 1]!.pool.timestamp,
    initialValueUsd: initialValue,
    finalValueUsd,
    totalFeesUsd: totalFees,
    totalIlUsd: totalIl,
    netPnlUsd: finalValueUsd - initialValue,
    totalRebalances: rebalances,
    winRate: rebalances > 0 ? wins / rebalances : 0,
    sharpeRatio: sharpe,
  };
}

function snapshotsToTicks(snaps: ReadonlyArray<PoolSnapshot>): HistoryTick[] {
  return snaps.map((s) => {
    const pool: PoolState = {
      address: s.poolAddress,
      tokenX: "",
      tokenY: "",
      tokenXSymbol: s.tokenXSymbol,
      tokenYSymbol: s.tokenYSymbol,
      tvlUsd: s.tvlUsd,
      volume24hUsd: s.volume24hUsd,
      fees24hUsd: s.fees24hUsd,
      apr: s.apr,
      activeBinId: s.activeBinId,
      binStep: s.binStep,
      currentPrice: s.currentPrice,
      timestamp: s.timestamp,
      // Restore the persisted provenance so replay keeps the live trust model: a
      // datapi snapshot replays gate-on, a source-less legacy row replays as the
      // conservative "heuristic" (gate off). Never leave the tick undefined.
      statsSource: s.statsSource ?? "heuristic",
    };
    return { pool, binArray: s.binArray };
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runBacktest(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv);

  log.warn("═══════════════════════════════════════════════════════════════");
  log.warn("  BACKTEST LIMITATIONS — read before interpreting results");
  log.warn("═══════════════════════════════════════════════════════════════");
  log.warn("  • Replay uses the TVL/fee values persisted in each historical snapshot.");
  log.warn("    It does not reconstruct pool-level liquidity changes between snapshots.");
  log.warn("  • Replay mirrors the LIVE decision chain (program.ts evaluatePool):");
  log.warn("    the EXIT chain (challenge drawdown, dust, TVL drop, volume auth,");
  log.warn("    Fee/IL, trailing stop with the #153 confirm debounce) and the ENTER");
  log.warn("    mega-gate (fee/IL floor, candidate conditions, weighted score,");
  log.warn("    allocation cap) with live confidence formulas + the shared risk kernel.");
  log.warn("    Live-only effects remain unavailable: memory retrieval/persistence,");
  log.warn("    agent proposals, recovery gates, pool cooldowns, token-risk");
  log.warn("    consults, IL-dominance/W15/fallen-angel exits, and on-chain execution.");
  log.warn(`  • Each selected pool runs independently with $10K. Total PnL is the`);
  log.warn(`    sum of ${args.pools.length} independent portfolios, not one shared $10K wallet.`);
  log.warn("  • Synthetic bins (all liquiditySupply=1n) make binUtil=1.0");
  log.warn("    always, so the binUtil pre-filter is a no-op.");
  log.warn("  • Position valuation is still an approximation: in-range is full value");
  log.warn("    and out-of-range is marked at 80%; token-leg depreciation, gas,");
  log.warn("    slippage, failed execution, and shared-wallet concentration are absent.");
  log.warn("    Treat this as decision-path evidence, not a live-money PnL forecast.");
  log.warn("═══════════════════════════════════════════════════════════════");

  const configs: ReadonlyArray<{ name: string; cfg: BacktestConfig }> = [
    {
      name: "C1-conservative",
      cfg: {
        halfWidth: 25,
        driftThreshold: 0.75,
        minHoldTicks: 144,
        minNetBenefitUsd: 15,
        maxRebalances: 20,
        maxPositionsPerPool: 2,
      },
    },
    {
      name: "C2-balanced",
      cfg: {
        halfWidth: 20,
        driftThreshold: 0.65,
        minHoldTicks: 72,
        minNetBenefitUsd: 10,
        maxRebalances: 30,
        maxPositionsPerPool: 2,
      },
    },
    {
      name: "C3-aggressive",
      cfg: {
        halfWidth: 15,
        driftThreshold: 0.55,
        minHoldTicks: 36,
        minNetBenefitUsd: 5,
        maxRebalances: 50,
        maxPositionsPerPool: 2,
      },
    },
    {
      name: "C4-wide-patient",
      cfg: {
        halfWidth: 35,
        driftThreshold: 0.8,
        minHoldTicks: 288,
        minNetBenefitUsd: 25,
        maxRebalances: 10,
        maxPositionsPerPool: 2,
      },
    },
  ];

  for (const pool of args.pools) {
    log.info(`\n=== Pool: ${pool} (source=${args.source}, days=${args.days}) ===\n`);

    let ticks: HistoryTick[];
    if (args.source === "synthetic") {
      ticks = generateMockHistory(pool, args.days, 100_000);
    } else {
      const endMs = Date.now();
      const snaps = await loadSnapshots(args.dbPath, pool, endMs, args.days);
      if (snaps.length === 0) {
        log.info(
          `  no snapshots for ${pool} in last ${args.days}d (db=${args.dbPath}). ` +
            `Did you run the agent with ENABLE_SNAPSHOT_CAPTURE=true?`,
        );
        continue;
      }
      ticks = snapshotsToTicks(snaps);
      log.info(`  loaded ${snaps.length} snapshots from ${args.dbPath}`);
    }

    const results = configs.map(({ name, cfg }) => ({
      name,
      result: runBacktestFromTicks(ticks, {
        ...cfg,
        minPoolTvlUsd: args.minPoolTvlUsd,
        challengeMode: args.challengeMode,
        challengeMinScore: args.challengeMinScore,
        roundTripGasUsd: args.roundTripGasUsd,
        min7dFeeOverGas: args.min7dFeeOverGas,
      }),
    }));

    const table = results.map(({ name, result: r }) => ({
      Config: name,
      "Net PnL": `$${r.netPnlUsd.toFixed(0)}`,
      Fees: `$${r.totalFeesUsd.toFixed(0)}`,
      IL: `$${r.totalIlUsd.toFixed(0)}`,
      Rebal: r.totalRebalances,
      "Win %": `${(r.winRate * 100).toFixed(0)}%`,
      Sharpe: r.sharpeRatio.toFixed(2),
    }));
    log.info(`Results table: ${JSON.stringify(table)}`);

    const best = results.reduce((best, curr) => {
      if (curr.result.winRate > best.result.winRate) return curr;
      if (
        curr.result.winRate === best.result.winRate &&
        curr.result.netPnlUsd > best.result.netPnlUsd
      ) {
        return curr;
      }
      return best;
    });

    log.info("Best config", {
      pool,
      config: best.name,
      netPnlUsd: best.result.netPnlUsd.toFixed(2),
      winRate: (best.result.winRate * 100).toFixed(1) + "%",
      rebalances: best.result.totalRebalances,
    });
    log.info(`  Best: ${best.name} (net=$${best.result.netPnlUsd.toFixed(0)})`);
  }
}

export { runBacktest };

const isDirectBacktestExecution =
  Boolean(globalThis.Bun) &&
  (globalThis.Bun?.main?.endsWith("ops/backtest.ts") ||
    globalThis.Bun?.main?.endsWith("ops/backtest.js"));
if (isDirectBacktestExecution) {
  if (process.env.BEAM_ALLOW_DIRECT !== "true") {
    console.error("Error: Direct backtest execution is not allowed.");
    console.error('Use "beam backtest" instead.');
    process.exit(1);
  }
  runBacktest(process.argv.slice(2)).catch((err) => {
    log.error("Backtest failed", { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  });
}
