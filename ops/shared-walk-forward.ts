import { computeClmmValueUsd, computeHodlValueUsd } from "../engine/pnl.js";
import { simulateSharedPortfolio, type SharedPortfolioEvent } from "./shared-portfolio-backtest.js";
import {
  computeEntryHodlLegsUsd,
  normalizeStoredDrawdown,
  reconstructedDrawdown24h,
} from "./mark-backtest-math.js";
import { rawRatioToUsd, rawTickToUsd, type VerifiedUsdPair } from "./verified-usd-price.js";

const DAY_MS = 24 * 3_600_000;
const MAX_FEE_GAP_MS = 30 * 60_000;

export interface SharedWalkForwardSnapshot {
  readonly timestamp: number;
  readonly currentPrice: number;
  readonly fees24hUsd: number;
  readonly tvlUsd: number;
  readonly activeBinId: number;
  readonly drawdown24h: number | null;
  readonly usdPair: VerifiedUsdPair | null;
}

export interface SharedWalkForwardStrategy {
  readonly portfolioUsd: number;
  readonly maxConcurrentPositions: number;
  readonly maxDeployedPct: number;
  readonly maxPositionUsd: number;
  readonly halfWidthTicks: number;
  readonly drawdownExitPct: number;
  readonly yieldDecayFraction: number;
  readonly yieldHysteresis: boolean;
  readonly rotationCooldownMs: number;
  readonly stopLossPct: number;
  readonly stopLossEnabled: boolean;
  readonly trailingStopPct: number;
  readonly minTvlUsd: number;
  readonly poolShareCapPct: number;
  readonly entryCostUsd: number;
  readonly exitCostUsd: number;
  readonly slippageBps: number;
  readonly minFeeCostRatio: number;
}

export interface SharedWalkForwardSplit {
  readonly startMs: number;
  readonly endMs: number;
}

export interface SharedWalkForwardRequirements {
  readonly minAcceptedTrades: number;
  readonly maxDrawdownPct: number;
  readonly minElapsedCoverageMs: number;
  readonly minProfitFactor: number;
}

export interface SharedWalkForwardMetrics {
  readonly finalEquityUsd: number;
  readonly netPnlUsd: number;
  readonly maxDrawdownPct: number;
  readonly acceptedEntries: number;
  readonly completedTrades: number;
  readonly grossProfitUsd: number;
  readonly grossLossUsd: number;
  readonly profitFactor: number;
  readonly elapsedCoverageMs: number;
  readonly sufficientCoverage: boolean;
}

export interface SharedWalkForwardCandidate<C> {
  readonly config: C;
  readonly metrics: SharedWalkForwardMetrics;
}

export interface SharedWalkForwardResult<C> {
  readonly winner: SharedWalkForwardCandidate<C> | null;
  readonly train: SharedWalkForwardCandidate<C> | null;
  readonly validation: SharedWalkForwardCandidate<C> | null;
  readonly test: SharedWalkForwardCandidate<C> | null;
  readonly candidatesConsidered: number;
}

interface Position {
  readonly entryPriceUsd: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly depositedUsd: number;
  readonly entryAmountXUsd: number;
  readonly entryAmountYUsd: number;
  readonly usdPair: VerifiedUsdPair;
  peakValueUsd: number;
}

interface PoolState {
  position: Position | null;
  cooldownUntil: number;
  previousTimestamp: number | null;
}

function drawdown(
  snapshot: SharedWalkForwardSnapshot,
  snapshots: readonly SharedWalkForwardSnapshot[],
  i: number,
): number {
  const reconstructed = reconstructedDrawdown24h(snapshots, i, DAY_MS);
  return snapshot.usdPair === null
    ? (normalizeStoredDrawdown(snapshot.drawdown24h) ?? reconstructed)
    : reconstructed;
}

function trailingYield(snapshots: readonly SharedWalkForwardSnapshot[], i: number): number | null {
  const now = snapshots[i]!.timestamp;
  let total = 0;
  let count = 0;
  for (let j = i; j >= 0 && now - snapshots[j]!.timestamp <= 7 * DAY_MS; j--) {
    const snapshot = snapshots[j]!;
    if (snapshot.tvlUsd > 0) {
      total += (snapshot.fees24hUsd / snapshot.tvlUsd) * 100;
      count++;
    }
  }
  return count > 0 ? total / count : null;
}

function markToMarket(position: Position, rawPrice: number): number {
  const currentPrice = rawRatioToUsd(rawPrice, position.usdPair);
  const lower = rawTickToUsd(position.lowerBinId, position.usdPair);
  const upper = rawTickToUsd(position.upperBinId, position.usdPair);
  if (currentPrice === null || lower === null || upper === null) return position.depositedUsd;
  const low = Math.min(lower, upper);
  const high = Math.max(lower, upper);
  const clmm =
    low < position.entryPriceUsd && position.entryPriceUsd < high
      ? computeClmmValueUsd({
          depositedUsd: position.depositedUsd,
          entryPriceUsd: position.entryPriceUsd,
          lowerBinId: position.lowerBinId,
          upperBinId: position.upperBinId,
          currentPriceUsd: currentPrice,
        })
      : null;
  if (clmm !== null && Number.isFinite(clmm) && clmm > 0) return clmm;
  const hodl = computeHodlValueUsd(
    position.entryAmountXUsd,
    position.entryAmountYUsd,
    position.entryPriceUsd,
    currentPrice,
  );
  return hodl !== null && Number.isFinite(hodl) && hodl > 0 ? hodl : position.depositedUsd;
}

function orderedEvents(events: SharedPortfolioEvent[]): void {
  const phase = (event: SharedPortfolioEvent): number =>
    event.type === "entry-request" ? 2 : event.type === "exit" ? 1 : 0;
  events.sort(
    (a, b) => a.timestamp - b.timestamp || phase(a) - phase(b) || a.pool.localeCompare(b.pool),
  );
}

function buildEvents(
  snapshotsByPool: ReadonlyMap<string, readonly SharedWalkForwardSnapshot[]>,
  strategy: SharedWalkForwardStrategy,
  split: SharedWalkForwardSplit,
): {
  readonly events: readonly SharedPortfolioEvent[];
  readonly acceptedEntries: number;
  readonly coverageMs: number;
} {
  const states = new Map<string, PoolState>();
  const events: SharedPortfolioEvent[] = [];
  let acceptedEntries = 0;
  let shadowCashUsd = strategy.portfolioUsd;
  let shadowDeployedUsd = 0;
  let activePositions = 0;
  const timeline = [...snapshotsByPool.entries()]
    .flatMap(([pool, snapshots]) => snapshots.map((snapshot, index) => ({ pool, snapshot, index })))
    .filter(
      ({ snapshot }) => snapshot.timestamp >= split.startMs && snapshot.timestamp <= split.endMs,
    )
    .sort((a, b) => a.snapshot.timestamp - b.snapshot.timestamp || a.pool.localeCompare(b.pool));

  for (const { pool, snapshot, index } of timeline) {
    const snapshots = snapshotsByPool.get(pool)!;
    const state = states.get(pool) ?? { position: null, cooldownUntil: 0, previousTimestamp: null };
    const previous = state.previousTimestamp;
    const yieldPct = snapshot.tvlUsd > 0 ? (snapshot.fees24hUsd / snapshot.tvlUsd) * 100 : 0;
    const average = trailingYield(snapshots, index);
    const dd = drawdown(snapshot, snapshots, index);

    if (state.position !== null) {
      const position = state.position;
      const mark = markToMarket(position, snapshot.currentPrice);
      position.peakValueUsd = Math.max(position.peakValueUsd, mark);
      events.push({ type: "mark", timestamp: snapshot.timestamp, pool, valueUsd: mark });
      if (
        snapshot.activeBinId >= position.lowerBinId &&
        snapshot.activeBinId <= position.upperBinId &&
        snapshot.tvlUsd > 0 &&
        previous !== null &&
        snapshot.timestamp - previous <= MAX_FEE_GAP_MS
      ) {
        events.push({
          type: "fee",
          timestamp: snapshot.timestamp,
          pool,
          amountUsd:
            snapshot.fees24hUsd *
            Math.min(position.depositedUsd / snapshot.tvlUsd, 1) *
            ((snapshot.timestamp - previous) / DAY_MS),
        });
      }
      const decayed =
        average !== null && average > 0 && yieldPct < average * strategy.yieldDecayFraction;
      const loss = (mark - position.depositedUsd) / position.depositedUsd;
      const trailing = (position.peakValueUsd - mark) / position.peakValueUsd;
      if (
        dd < -(strategy.drawdownExitPct / 100) ||
        decayed ||
        (strategy.stopLossEnabled && loss < -strategy.stopLossPct) ||
        trailing > strategy.trailingStopPct
      ) {
        const cost = strategy.exitCostUsd + mark * (strategy.slippageBps / 10_000);
        events.push({ type: "exit", timestamp: snapshot.timestamp, pool, valueUsd: mark });
        if (cost !== 0)
          events.push({ type: "fee", timestamp: snapshot.timestamp, pool, amountUsd: -cost });
        shadowCashUsd += mark - cost;
        shadowDeployedUsd -= position.depositedUsd;
        activePositions--;
        state.position = null;
        state.cooldownUntil = snapshot.timestamp + strategy.rotationCooldownMs;
      }
    }

    if (state.position === null && snapshot.timestamp >= state.cooldownUntil) {
      const decayed =
        average !== null && average > 0 && yieldPct < average * strategy.yieldDecayFraction;
      if (
        snapshot.tvlUsd >= strategy.minTvlUsd &&
        yieldPct > 0 &&
        dd > -(strategy.drawdownExitPct / 100) &&
        !(strategy.yieldHysteresis && decayed) &&
        snapshot.usdPair !== null
      ) {
        const entryPriceUsd = rawRatioToUsd(snapshot.currentPrice, snapshot.usdPair);
        if (entryPriceUsd !== null) {
          const size = Math.min(
            strategy.maxPositionUsd,
            snapshot.tvlUsd * (strategy.poolShareCapPct / 100),
          );
          const entrySlippage = size * (strategy.slippageBps / 10_000);
          const entryCost = strategy.entryCostUsd + entrySlippage;
          const expectedFees = snapshot.fees24hUsd * (size / Math.max(snapshot.tvlUsd, 1)) * 7;
          const roundTrip = entryCost + strategy.exitCostUsd + entrySlippage;
          const legs = computeEntryHodlLegsUsd({
            depositedUsd: size,
            entryPriceUsd,
            lowerBinId: snapshot.activeBinId - strategy.halfWidthTicks,
            upperBinId: snapshot.activeBinId + strategy.halfWidthTicks,
            usdPair: snapshot.usdPair,
          });
          const canEnter =
            size > 0 &&
            legs !== null &&
            shadowCashUsd >= size + entryCost &&
            shadowDeployedUsd + size <= strategy.portfolioUsd * (strategy.maxDeployedPct / 100) &&
            activePositions < strategy.maxConcurrentPositions &&
            (strategy.minFeeCostRatio <= 0 || expectedFees >= roundTrip * strategy.minFeeCostRatio);
          if (canEnter) {
            events.push({
              type: "entry-request",
              timestamp: snapshot.timestamp,
              pool,
              amountUsd: size,
            });
            if (entryCost !== 0)
              events.push({
                type: "fee",
                timestamp: snapshot.timestamp,
                pool,
                amountUsd: -entryCost,
              });
            shadowCashUsd -= size + entryCost;
            shadowDeployedUsd += size;
            activePositions++;
            state.position = {
              entryPriceUsd,
              lowerBinId: snapshot.activeBinId - strategy.halfWidthTicks,
              upperBinId: snapshot.activeBinId + strategy.halfWidthTicks,
              depositedUsd: size,
              entryAmountXUsd: legs.movingUsd,
              entryAmountYUsd: legs.numeraireUsd,
              usdPair: snapshot.usdPair,
              peakValueUsd: size,
            };
            acceptedEntries++;
          }
        }
      }
    }
    state.previousTimestamp = snapshot.timestamp;
    states.set(pool, state);
  }

  for (const [pool, state] of states) {
    if (state.position === null) continue;
    const snapshots = snapshotsByPool.get(pool)!;
    const final = [...snapshots].reverse().find((snapshot) => snapshot.timestamp <= split.endMs);
    if (final === undefined) continue;
    const timestamp = final.timestamp + 1;
    const mark = markToMarket(state.position, final.currentPrice);
    events.push({ type: "mark", timestamp, pool, valueUsd: mark });
    events.push({ type: "exit", timestamp, pool, valueUsd: mark });
    const cost = strategy.exitCostUsd + mark * (strategy.slippageBps / 10_000);
    if (cost !== 0) events.push({ type: "fee", timestamp, pool, amountUsd: -cost });
  }
  orderedEvents(events);
  return { events, acceptedEntries, coverageMs: Math.max(0, split.endMs - split.startMs) };
}

function metrics(
  events: readonly SharedPortfolioEvent[],
  acceptedEntries: number,
  coverageMs: number,
  strategy: SharedWalkForwardStrategy,
  minElapsedCoverageMs: number,
): SharedWalkForwardMetrics {
  const entries = new Map<string, number>();
  let grossProfitUsd = 0;
  let grossLossUsd = 0;
  let completedTrades = 0;
  for (const event of events) {
    if (event.type === "entry-request") entries.set(event.pool, event.amountUsd);
    else if (event.type === "exit") {
      const deposited = entries.get(event.pool);
      if (deposited !== undefined) {
        const pnl = event.valueUsd - deposited;
        if (pnl >= 0) grossProfitUsd += pnl;
        else grossLossUsd += -pnl;
        completedTrades++;
        entries.delete(event.pool);
      }
    }
  }
  const simulated = simulateSharedPortfolio(events, {
    initialCapitalUsd: strategy.portfolioUsd,
    maxConcurrentPositions: strategy.maxConcurrentPositions,
    maxTotalDeployedUsd: strategy.portfolioUsd * (strategy.maxDeployedPct / 100),
    maxAllocationPerPoolUsd: strategy.maxPositionUsd,
  });
  const profitFactor =
    grossLossUsd > 0
      ? grossProfitUsd / grossLossUsd
      : grossProfitUsd > 0
        ? Number.POSITIVE_INFINITY
        : 0;
  return {
    finalEquityUsd: simulated.finalEquityUsd,
    netPnlUsd: simulated.netPnlUsd,
    maxDrawdownPct: simulated.maxDrawdownPct,
    acceptedEntries,
    completedTrades,
    grossProfitUsd,
    grossLossUsd,
    profitFactor,
    elapsedCoverageMs: coverageMs,
    sufficientCoverage: coverageMs >= minElapsedCoverageMs,
  };
}

function eligible<C>(
  candidate: SharedWalkForwardCandidate<C>,
  requirements: SharedWalkForwardRequirements,
): boolean {
  return (
    candidate.metrics.sufficientCoverage &&
    candidate.metrics.acceptedEntries >= requirements.minAcceptedTrades &&
    candidate.metrics.maxDrawdownPct <= requirements.maxDrawdownPct &&
    candidate.metrics.profitFactor >= requirements.minProfitFactor
  );
}

function rank<C>(
  a: SharedWalkForwardCandidate<C>,
  b: SharedWalkForwardCandidate<C>,
): SharedWalkForwardCandidate<C> {
  return a.metrics.netPnlUsd >= b.metrics.netPnlUsd ? a : b;
}

export function runSharedWalkForward<C>(input: {
  readonly snapshotsByPool: ReadonlyMap<string, readonly SharedWalkForwardSnapshot[]>;
  readonly candidates: readonly C[];
  readonly toStrategy: (config: C) => SharedWalkForwardStrategy;
  readonly train: SharedWalkForwardSplit;
  readonly validation: SharedWalkForwardSplit;
  readonly test: SharedWalkForwardSplit;
  readonly requirements: SharedWalkForwardRequirements;
}): SharedWalkForwardResult<C> {
  const evaluate = (config: C, split: SharedWalkForwardSplit): SharedWalkForwardCandidate<C> => {
    const strategy = input.toStrategy(config);
    const built = buildEvents(input.snapshotsByPool, strategy, split);
    return {
      config,
      metrics: metrics(
        built.events,
        built.acceptedEntries,
        built.coverageMs,
        strategy,
        input.requirements.minElapsedCoverageMs,
      ),
    };
  };
  const trainCandidates = input.candidates.map((config) => evaluate(config, input.train));
  const validTrain = trainCandidates.filter((candidate) => eligible(candidate, input.requirements));
  const winner = validTrain.reduce<SharedWalkForwardCandidate<C> | null>(
    (best, candidate) => (best === null ? candidate : rank(best, candidate)),
    null,
  );
  if (winner === null)
    return {
      winner: null,
      train: null,
      validation: null,
      test: null,
      candidatesConsidered: trainCandidates.length,
    };
  const validation = evaluate(winner.config, input.validation);
  const test = evaluate(winner.config, input.test);
  return {
    winner,
    train: winner,
    validation,
    test,
    candidatesConsidered: trainCandidates.length,
  };
}
