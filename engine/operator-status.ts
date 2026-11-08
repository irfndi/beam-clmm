/**
 * Canonical operator status read model.
 *
 * Every surface that reports agent state — the loopback HTTP server, the CLI
 * (`beam status --json`), and the Cloudflare report API — builds the same
 * `OperatorStatus` object here. Surfaces may add presentation fields, but the
 * sections below are the single contract: engine, portfolio, positions,
 * decisions, autonomous runtime, agent policy, config.
 *
 * Timestamps are epoch milliseconds (engine-native). A surface that has always
 * exposed ISO strings may add them alongside these fields; it must not fork
 * the model.
 */
import { computePositionAnalytics } from "./pnl.js";
import type { PositionRecord } from "./db-service.js";
import type { DecisionRecord } from "./services.js";
import type {
  AgentPolicySnapshot,
  ExecutionOperationRecord,
  SafetyPauseRecord,
  SettlementJobRecord,
  TokenCandidateRecord,
} from "./types.js";

export const OPERATOR_STATUS_SCHEMA_VERSION = 1 as const;

export type OperatorStatusSource = "http" | "cli" | "cloud";

export interface OperatorStatusPortfolio {
  /** Current mark of open positions (positions only, no cash). */
  readonly totalValueUsd: number;
  /** Cost basis of open positions; null when the surface cannot compute it. */
  readonly totalDepositedUsd: number | null;
  readonly totalUnrealizedPnlUsd: number;
  readonly totalUnrealizedPnlPct: number | null;
  readonly totalFeesClaimedUsd: number | null;
  readonly totalRewardsClaimedUsd: number | null;
  readonly walletBalanceUsd: number | null;
  readonly walletKnown: boolean;
  readonly totalEquityUsd: number | null;
  readonly realizedPnlUsd: number | null;
  readonly positionCount: number;
}

export interface OperatorStatusPosition {
  readonly positionId: string;
  readonly poolAddress: string;
  readonly poolName: string;
  readonly depositedUsd: number;
  readonly currentValueUsd: number;
  readonly unrealizedPnlUsd: number;
  readonly unrealizedPnlPct: number;
  readonly feesClaimedUsd: number;
  readonly rewardsClaimedUsd: number;
  readonly entryPriceUsd: number | null;
  readonly activeBinId: number;
  readonly lowerBinId: number;
  readonly upperBinId: number;
  readonly openedAt: number;
  readonly outOfRangeSince: number | null;
  readonly ageMs: number;
  readonly hodlValueUsd: number | null;
  readonly ilVsHodlUsd: number | null;
  readonly timeInRangePct: number | null;
  /** Present only for snapshots taken from the live loop's in-memory state. */
  readonly lastAction?: "ENTER" | "EXIT" | "REBALANCE" | "HOLD" | undefined;
  readonly lastActionAt?: number | undefined;
}

export interface OperatorStatusDecision {
  readonly timestamp: number;
  readonly cycleId: string;
  readonly poolAddress: string;
  readonly action: string;
  readonly confidence: number;
  readonly reasoning: string;
  readonly executed: boolean;
  readonly paperTrading: boolean;
  readonly error: string | null;
}

export interface OperatorStatusAgentRuntime {
  readonly enabled: boolean;
  readonly runtime: string;
  readonly acpCommand: string;
  readonly gatewayUrl: string;
  readonly checkinIntervalMs: number;
  readonly checkinOnEvents: boolean;
}

export interface OperatorStatusCandidate {
  readonly id: string;
  readonly state: string;
  readonly poolAddress: string;
  readonly tokenMint: string;
  readonly healthyScanCount: number;
  readonly updatedAt: number;
}

export interface OperatorStatusOperation {
  readonly id: string;
  readonly candidateId: string | null;
  readonly positionId: string | null;
  readonly type: string;
  readonly status: string;
  readonly poolAddress: string;
  readonly tokenMint: string;
  readonly txSignature: string | null;
  readonly error: string | null;
  readonly updatedAt: number;
}

export interface OperatorStatusSettlement {
  readonly id: string;
  readonly positionId: string;
  readonly status: string;
  readonly poolAddress: string;
  readonly tokenMint: string;
  readonly amountAtomic: string;
  readonly confirmedOutputAtomic: string | null;
  readonly attempts: number;
  readonly nextRetryAt: number | null;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly txSignature: string | null;
  readonly error: string | null;
}

export interface OperatorStatusSafetyPause {
  readonly active: boolean;
  readonly reason: string;
  readonly triggeredAt: number;
  readonly resolvedAt: number | null;
}

export interface OperatorStatusAutonomous {
  readonly mode: "off" | "shadow" | "canary" | "live";
  readonly walletAddress: string | null;
  readonly agentInstanceId: string;
  readonly candidates: ReadonlyArray<OperatorStatusCandidate>;
  readonly operations: ReadonlyArray<OperatorStatusOperation>;
  readonly settlements: ReadonlyArray<OperatorStatusSettlement>;
  readonly safetyPause: OperatorStatusSafetyPause | null;
}

/** Sanitized, non-secret config section exposed by the local HTTP surface. */
export interface OperatorStatusConfig {
  readonly paperTrading: boolean;
  readonly scanIntervalMs: number;
  readonly minPoolTvlUsd: number;
  readonly minFeeIlRatio: number;
  readonly tvlDropExitPct: number;
  readonly volumeAuthThreshold: number;
  readonly confidenceThreshold: number;
  readonly paperPortfolioUsd: number;
  readonly minBinUtilization: number;
  readonly maxRebalanceRangeBins: number;
  readonly maxOpenPositions: number;
  readonly stopLossPct: number;
  readonly trailingStopPct: number;
  readonly agentiveMode: boolean;
  readonly agentRuntime: string;
  readonly agentHttpPort: number;
  readonly agentMcpEnabled: boolean;
}

export interface OperatorStatus {
  readonly schemaVersion: typeof OPERATOR_STATUS_SCHEMA_VERSION;
  readonly source: OperatorStatusSource;
  readonly generatedAt: number;
  readonly running: boolean;
  readonly version: string;
  readonly dbPath: string | null;
  readonly uptimeMs: number | null;
  readonly scanCount: number | null;
  readonly lastCycleAt: number | null;
  readonly agentRuntime: OperatorStatusAgentRuntime | null;
  readonly portfolio: OperatorStatusPortfolio;
  readonly positions: ReadonlyArray<OperatorStatusPosition>;
  readonly decisions: ReadonlyArray<OperatorStatusDecision>;
  readonly autonomous: OperatorStatusAutonomous | null;
  readonly agentPolicy: AgentPolicySnapshot | null;
  readonly config: OperatorStatusConfig | null;
}

export interface BuildOperatorStatusInput {
  readonly source: OperatorStatusSource;
  readonly generatedAt?: number;
  readonly running: boolean;
  readonly version: string;
  readonly dbPath?: string | null;
  readonly uptimeMs?: number | null;
  readonly scanCount?: number | null;
  readonly lastCycleAt?: number | null;
  readonly agentRuntime?: OperatorStatusAgentRuntime | null;
  readonly portfolio: OperatorStatusPortfolio;
  readonly positions?: ReadonlyArray<OperatorStatusPosition>;
  readonly decisions?: ReadonlyArray<OperatorStatusDecision>;
  readonly autonomous?: OperatorStatusAutonomous | null;
  readonly agentPolicy?: AgentPolicySnapshot | null;
  readonly config?: OperatorStatusConfig | null;
}

export function buildOperatorStatus(input: BuildOperatorStatusInput): OperatorStatus {
  return {
    schemaVersion: OPERATOR_STATUS_SCHEMA_VERSION,
    source: input.source,
    generatedAt: input.generatedAt ?? Date.now(),
    running: input.running,
    version: input.version,
    dbPath: input.dbPath ?? null,
    uptimeMs: input.uptimeMs ?? null,
    scanCount: input.scanCount ?? null,
    lastCycleAt: input.lastCycleAt ?? null,
    agentRuntime: input.agentRuntime ?? null,
    portfolio: input.portfolio,
    positions: input.positions ?? [],
    decisions: input.decisions ?? [],
    autonomous: input.autonomous ?? null,
    agentPolicy: input.agentPolicy ?? null,
    config: input.config ?? null,
  };
}

/** Structurally compatible with `PortfolioSummary` without importing the CLI. */
export interface PortfolioSummaryLike {
  readonly totalCurrentValueUsd: number;
  readonly totalDepositedUsd: number;
  readonly totalUnrealizedPnlUsd: number;
  readonly totalUnrealizedPnlPct: number;
  readonly totalFeesClaimedUsd: number;
  readonly totalRewardsClaimedUsd: number;
  readonly positionCount: number;
  readonly walletBalanceUsd: number | null;
  readonly totalEquityUsd: number;
  readonly walletKnown: boolean;
}

export function portfolioStatusFromSummary(
  summary: PortfolioSummaryLike,
  realizedPnlUsd: number | null = null,
): OperatorStatusPortfolio {
  return {
    totalValueUsd: summary.totalCurrentValueUsd,
    totalDepositedUsd: summary.totalDepositedUsd,
    totalUnrealizedPnlUsd: summary.totalUnrealizedPnlUsd,
    totalUnrealizedPnlPct: summary.totalUnrealizedPnlPct,
    totalFeesClaimedUsd: summary.totalFeesClaimedUsd,
    totalRewardsClaimedUsd: summary.totalRewardsClaimedUsd,
    walletBalanceUsd: summary.walletBalanceUsd,
    walletKnown: summary.walletKnown,
    totalEquityUsd: summary.totalEquityUsd,
    realizedPnlUsd,
    positionCount: summary.positionCount,
  };
}

type PortfolioPositionInput = Pick<
  PositionRecord,
  | "depositedUsd"
  | "currentValueUsd"
  | "cumulativeFeesClaimedUsd"
  | "cumulativeRewardsClaimedUsd"
  | "realizedPnlUsd"
>;

/** Aggregate a position book into the canonical portfolio section. */
export function portfolioStatusFromPositions(
  positions: ReadonlyArray<PortfolioPositionInput>,
  walletBalanceUsd: number | null,
): OperatorStatusPortfolio {
  let totalValueUsd = 0;
  let totalDepositedUsd = 0;
  let totalFeesClaimedUsd = 0;
  let totalRewardsClaimedUsd = 0;
  let realizedPnlUsd = 0;
  for (const position of positions) {
    totalValueUsd += position.currentValueUsd;
    totalDepositedUsd += position.depositedUsd;
    totalFeesClaimedUsd += position.cumulativeFeesClaimedUsd;
    totalRewardsClaimedUsd += position.cumulativeRewardsClaimedUsd;
    realizedPnlUsd += position.realizedPnlUsd ?? 0;
  }
  const walletKnown = walletBalanceUsd !== null && Number.isFinite(walletBalanceUsd);
  return {
    totalValueUsd,
    totalDepositedUsd,
    totalUnrealizedPnlUsd:
      totalValueUsd + totalFeesClaimedUsd + totalRewardsClaimedUsd - totalDepositedUsd,
    totalUnrealizedPnlPct:
      totalDepositedUsd > 0
        ? ((totalValueUsd + totalFeesClaimedUsd + totalRewardsClaimedUsd - totalDepositedUsd) /
            totalDepositedUsd) *
          100
        : null,
    totalFeesClaimedUsd,
    totalRewardsClaimedUsd,
    walletBalanceUsd: walletKnown ? walletBalanceUsd : null,
    walletKnown,
    totalEquityUsd: totalValueUsd + (walletKnown ? walletBalanceUsd : 0),
    realizedPnlUsd,
    positionCount: positions.length,
  };
}

export function positionStatusFromRecord(
  position: PositionRecord,
  currentPriceUsd: number | null,
  nowMs: number = Date.now(),
): OperatorStatusPosition {
  const analytics = computePositionAnalytics(
    {
      depositedUsd: position.depositedUsd,
      currentValueUsd: position.currentValueUsd,
      cumulativeFeesClaimedUsd: position.cumulativeFeesClaimedUsd,
      cumulativeRewardsClaimedUsd: position.cumulativeRewardsClaimedUsd,
      entryPriceUsd: position.entryPriceUsd,
      entryAmountXUsd: position.entryAmountXUsd,
      entryAmountYUsd: position.entryAmountYUsd,
      openedAtMs: position.timestamp,
      outOfRangeSinceMs: position.outOfRangeSince,
    },
    currentPriceUsd,
    nowMs,
  );
  return {
    positionId: position.positionId,
    poolAddress: position.poolAddress,
    poolName: `${position.tokenXSymbol}/${position.tokenYSymbol}`,
    depositedUsd: position.depositedUsd,
    currentValueUsd: position.currentValueUsd,
    unrealizedPnlUsd: analytics.unrealizedPnlUsd,
    unrealizedPnlPct: analytics.unrealizedPnlPct,
    feesClaimedUsd: analytics.feesClaimedUsd,
    rewardsClaimedUsd: analytics.rewardsClaimedUsd,
    entryPriceUsd: position.entryPriceUsd,
    activeBinId: position.activeBinId,
    lowerBinId: position.lowerBinId,
    upperBinId: position.upperBinId,
    openedAt: position.timestamp,
    outOfRangeSince: position.outOfRangeSince,
    ageMs: analytics.ageMs,
    hodlValueUsd: analytics.hodlValueUsd,
    ilVsHodlUsd: analytics.ilVsHodlUsd,
    timeInRangePct: analytics.timeInRangePct,
  };
}

export function positionStatusesFromRecords(
  positions: ReadonlyArray<PositionRecord>,
  prices: ReadonlyMap<string, number>,
  nowMs: number = Date.now(),
): OperatorStatusPosition[] {
  return positions.map((position) =>
    positionStatusFromRecord(position, prices.get(position.poolAddress) ?? null, nowMs),
  );
}

/**
 * Convert the loop's in-memory `PositionSnapshot` (which has no entry legs or
 * cumulative fee accounting) into the canonical row. Fees/rewards are reported
 * as 0 rather than fabricated; the live loop's snapshot already embeds them in
 * `currentValueUsd` only when the source did.
 */
export function positionStatusFromSnapshot(
  snapshot: {
    readonly positionId: string;
    readonly poolAddress: string;
    readonly tokenXSymbol: string;
    readonly tokenYSymbol: string;
    readonly depositedUsd: number;
    readonly currentValueUsd: number;
    readonly activeBinId: number;
    readonly lowerBinId: number;
    readonly upperBinId: number;
    readonly lastAction: "ENTER" | "EXIT" | "REBALANCE" | "HOLD";
    readonly lastActionAt: number;
    readonly hoursHeld: number;
  },
  nowMs: number = Date.now(),
): OperatorStatusPosition {
  const unrealizedPnlUsd = snapshot.currentValueUsd - snapshot.depositedUsd;
  return {
    positionId: snapshot.positionId,
    poolAddress: snapshot.poolAddress,
    poolName: `${snapshot.tokenXSymbol}/${snapshot.tokenYSymbol}`,
    depositedUsd: snapshot.depositedUsd,
    currentValueUsd: snapshot.currentValueUsd,
    unrealizedPnlUsd,
    unrealizedPnlPct:
      snapshot.depositedUsd > 0 ? (unrealizedPnlUsd / snapshot.depositedUsd) * 100 : 0,
    feesClaimedUsd: 0,
    rewardsClaimedUsd: 0,
    entryPriceUsd: null,
    activeBinId: snapshot.activeBinId,
    lowerBinId: snapshot.lowerBinId,
    upperBinId: snapshot.upperBinId,
    openedAt: nowMs - snapshot.hoursHeld * 3_600_000,
    outOfRangeSince: null,
    ageMs: snapshot.hoursHeld * 3_600_000,
    hodlValueUsd: null,
    ilVsHodlUsd: null,
    timeInRangePct: null,
    lastAction: snapshot.lastAction,
    lastActionAt: snapshot.lastActionAt,
  };
}

export function decisionStatusFromRecord(record: DecisionRecord): OperatorStatusDecision {
  return {
    timestamp: record.timestamp,
    cycleId: record.cycleId,
    poolAddress: record.poolAddress,
    action: record.action,
    confidence: record.confidence,
    reasoning: record.reasoning,
    executed: record.executed,
    paperTrading: record.paperTrading,
    error: record.error ?? null,
  };
}

export function autonomousStatus(input: {
  readonly mode: "off" | "shadow" | "canary" | "live";
  readonly walletAddress: string | null;
  readonly agentInstanceId: string;
  readonly candidates: ReadonlyArray<TokenCandidateRecord>;
  readonly operations: ReadonlyArray<ExecutionOperationRecord>;
  readonly settlements: ReadonlyArray<SettlementJobRecord>;
  readonly safetyPause: SafetyPauseRecord | null;
}): OperatorStatusAutonomous {
  return {
    mode: input.mode,
    walletAddress: input.walletAddress,
    agentInstanceId: input.agentInstanceId,
    candidates: input.candidates.map((candidate) => ({
      id: candidate.id,
      state: candidate.state,
      poolAddress: candidate.poolAddress,
      tokenMint: candidate.tokenMint,
      healthyScanCount: candidate.healthyScanCount,
      updatedAt: candidate.updatedAt,
    })),
    operations: input.operations.map((operation) => ({
      id: operation.id,
      candidateId: operation.candidateId,
      positionId: operation.positionId,
      type: operation.operationType,
      status: operation.status,
      poolAddress: operation.poolAddress,
      tokenMint: operation.tokenMint,
      txSignature: operation.txSignature,
      error: operation.error,
      updatedAt: operation.updatedAt,
    })),
    settlements: input.settlements.map((settlement) => ({
      id: settlement.id,
      positionId: settlement.positionId,
      status: settlement.status,
      poolAddress: settlement.poolAddress,
      tokenMint: settlement.tokenMint,
      amountAtomic: settlement.amountAtomic,
      confirmedOutputAtomic: settlement.confirmedOutputAtomic,
      attempts: settlement.attempts,
      nextRetryAt: settlement.nextRetryAt,
      expiresAt: settlement.expiresAt,
      createdAt: settlement.createdAt,
      txSignature: settlement.txSignature,
      error: settlement.error,
    })),
    safetyPause:
      input.safetyPause === null
        ? null
        : {
            active: input.safetyPause.resolvedAt === null,
            reason: input.safetyPause.reason,
            triggeredAt: input.safetyPause.triggeredAt,
            resolvedAt: input.safetyPause.resolvedAt,
          },
  };
}
