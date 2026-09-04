import { Layer } from "effect";
import { RiskService, type RiskApi, type RiskContext, type RiskResult } from "./services.js";
import type { AppConfig } from "./config-service.js";
import type {
  ActionType,
  AgentDecision,
  AgentProposal,
  ProposalValidationResult,
  RebalanceParams,
} from "./types.js";
import { shouldHoldForRecovery } from "./strategy-service.js";
import { ENTRY_SIZE_FLOOR_USD } from "./entry-sizing.js";

export interface RiskConfig {
  readonly confidenceThreshold: number;
  readonly maxRebalanceRangeBins: number;
  readonly stopLossPct: number;
  readonly maxPerPoolAllocationPct: number;
  readonly maxPositionsPerPool: number;
  /** Max observed trailing-24h price range (%) for an ENTER pool, measured
   *  from our own snapshots. The STACK/USDG paper loss (−$67.63 in 39 min)
   *  came from a ~48% intraday range the stats source reported as 0.
   *  MAX_OBSERVED_PRICE_RANGE_PCT; default 30. */
  readonly maxObservedPriceRangePct: number;
}

function gateExit(decision: AgentDecision): RiskResult | null {
  if (decision.action === "EXIT") {
    return { approved: true, reason: "EXIT approved: capital protection" };
  }
  return null;
}

function gateConfidence(decision: AgentDecision, riskConfig: RiskConfig): RiskResult | null {
  if (!Number.isFinite(decision.confidence)) {
    return { approved: false, reason: "Decision confidence is not finite — rejecting" };
  }
  if (decision.confidence < riskConfig.confidenceThreshold) {
    return {
      approved: false,
      reason: `Confidence ${decision.confidence.toFixed(2)} below threshold ${riskConfig.confidenceThreshold}`,
    };
  }
  return null;
}

function gatePerPoolCap(
  decision: AgentDecision,
  ctx: RiskContext,
  riskConfig: RiskConfig,
): RiskResult | null {
  if (decision.action !== "ENTER" || !decision.poolAddress) return null;
  const poolPositionCount = ctx.openPositions.filter(
    (p) => p.poolAddress === decision.poolAddress,
  ).length;
  if (poolPositionCount >= riskConfig.maxPositionsPerPool) {
    return {
      approved: false,
      reason:
        `Per-pool position cap reached (${poolPositionCount}/${riskConfig.maxPositionsPerPool}) ` +
        `for pool ${decision.poolAddress}`,
    };
  }
  return null;
}

function gateDrawdown(decision: AgentDecision, ctx: RiskContext): RiskResult | null {
  if (decision.action !== "ENTER") return null;
  if (!Number.isFinite(ctx.portfolioValueUsd) || !Number.isFinite(ctx.recentPnlUsd)) {
    return {
      approved: false,
      reason: "Portfolio drawdown data is not finite — pausing new entries",
    };
  }
  if (ctx.portfolioValueUsd > 0) {
    const drawdownPct = Math.abs(ctx.recentPnlUsd) / ctx.portfolioValueUsd;
    if (ctx.recentPnlUsd < 0 && drawdownPct > 0.1) {
      return {
        approved: false,
        reason: `Portfolio drawdown ${(drawdownPct * 100).toFixed(1)}% exceeds 10% — pausing new entries`,
      };
    }
  }
  return null;
}

function gateObservedVolatility(
  decision: AgentDecision,
  ctx: RiskContext,
  riskConfig: RiskConfig,
): RiskResult | null {
  if (decision.action !== "ENTER" || ctx.observedPriceRangePct === undefined) return null;
  if (ctx.observedPriceRangePct > riskConfig.maxObservedPriceRangePct) {
    return {
      approved: false,
      reason:
        `Observed 24h price range ${ctx.observedPriceRangePct.toFixed(1)}% exceeds ` +
        `${riskConfig.maxObservedPriceRangePct}% cap — too volatile to enter`,
    };
  }
  return null;
}

function gateStopLoss(
  decision: AgentDecision,
  ctx: RiskContext,
  riskConfig: RiskConfig,
): RiskResult | null {
  if (decision.action !== "HOLD" && decision.action !== "REBALANCE") return null;
  const targetId = decision.positionId ?? ctx.positionId;
  const pos =
    targetId !== undefined
      ? ctx.openPositions.find((p) => p.id === targetId)
      : ctx.openPositions.find((p) => p.poolAddress === decision.poolAddress);
  if (!pos || pos.depositedUsd <= 0) return null;
  const lossPct = (pos.currentValueUsd - pos.depositedUsd) / pos.depositedUsd;
  if (lossPct < -riskConfig.stopLossPct) {
    return {
      approved: false,
      reason: `Stop-loss triggered: position loss ${(Math.abs(lossPct) * 100).toFixed(1)}% exceeds ${(riskConfig.stopLossPct * 100).toFixed(0)}%`,
    };
  }
  return null;
}

function gatePositionSize(
  decision: AgentDecision,
  ctx: RiskContext,
  riskConfig: RiskConfig,
  minEntrySizeUsd: number,
): RiskResult | null {
  if (decision.action !== "ENTER" || decision.positionSizeUsd === undefined) return null;
  if (decision.positionSizeUsd < minEntrySizeUsd) {
    return {
      approved: false,
      reason:
        `Entry size $${decision.positionSizeUsd.toFixed(2)} is below the ` +
        `$${minEntrySizeUsd.toFixed(0)} minimum entry size`,
    };
  }
  const capPct = riskConfig.maxPerPoolAllocationPct;
  const existingPoolExposureUsd = ctx.openPositions
    .filter((p) => p.poolAddress === decision.poolAddress)
    .reduce((sum, p) => sum + p.currentValueUsd, 0);
  if (
    !Number.isFinite(decision.positionSizeUsd) ||
    !Number.isFinite(ctx.portfolioValueUsd) ||
    !Number.isFinite(existingPoolExposureUsd)
  ) {
    return {
      approved: false,
      reason: "Position size or portfolio data is not finite — refusing entry",
    };
  }
  const maxSize = Math.max(ctx.portfolioValueUsd * capPct - existingPoolExposureUsd, 0);
  if (decision.positionSizeUsd <= maxSize) return null;
  if (maxSize <= 0) {
    return {
      approved: false,
      reason:
        `Pool exposure $${existingPoolExposureUsd.toFixed(0)} already fills the ` +
        `${(capPct * 100).toFixed(0)}% per-pool allocation cap`,
    };
  }
  const adjustedSizeUsd = maxSize;
  if (adjustedSizeUsd < minEntrySizeUsd) {
    return {
      approved: false,
      reason:
        `Remaining per-pool headroom $${adjustedSizeUsd.toFixed(2)} is below the ` +
        `$${minEntrySizeUsd.toFixed(0)} minimum entry size — skipping dust entry`,
    };
  }
  return {
    approved: true,
    reason: `Size capped to ${(capPct * 100).toFixed(0)}% of portfolio ($${adjustedSizeUsd.toFixed(0)})`,
    adjustedSizeUsd,
  };
}

function gateRebalance(
  decision: AgentDecision,
  ctx: RiskContext,
  riskConfig: RiskConfig,
): RiskResult | null {
  if (decision.action !== "REBALANCE" || !decision.rebalanceParams) return null;
  const { newLowerBinId, newUpperBinId } = decision.rebalanceParams;
  if (newUpperBinId <= newLowerBinId) {
    return { approved: false, reason: "Invalid rebalance range: upperBinId must be > lowerBinId" };
  }
  const rangeWidth = newUpperBinId - newLowerBinId;
  if (rangeWidth > riskConfig.maxRebalanceRangeBins) {
    return {
      approved: false,
      reason: `Rebalance range ${rangeWidth} bins exceeds max ${riskConfig.maxRebalanceRangeBins}`,
    };
  }
  if (
    ctx.activeBinId !== undefined &&
    Number.isFinite(ctx.activeBinId) &&
    (ctx.activeBinId < newLowerBinId || ctx.activeBinId > newUpperBinId)
  ) {
    return {
      approved: false,
      reason:
        `Rebalance range [${newLowerBinId}, ${newUpperBinId}] does not contain ` +
        `active bin ${ctx.activeBinId}`,
    };
  }
  return null;
}

export function evaluateRisk(
  riskConfig: RiskConfig,
  decision: AgentDecision,
  ctx: RiskContext,
): RiskResult {
  const minEntrySizeUsd = ctx.minEntrySizeUsd ?? ENTRY_SIZE_FLOOR_USD;
  return (
    gateExit(decision) ??
    gateConfidence(decision, riskConfig) ??
    gatePerPoolCap(decision, ctx, riskConfig) ??
    gateDrawdown(decision, ctx) ??
    gateObservedVolatility(decision, ctx, riskConfig) ??
    gateStopLoss(decision, ctx, riskConfig) ??
    gatePositionSize(decision, ctx, riskConfig, minEntrySizeUsd) ??
    gateRebalance(decision, ctx, riskConfig) ?? { approved: true, reason: "All risk checks passed" }
  );
}

const VALID_ACTIONS: ReadonlyArray<ActionType> = ["HOLD", "REBALANCE", "EXIT", "ENTER"];

// Slippage is intentionally excluded: the proposal schema does not accept it
// (buildProposal hardcodes 0 while deterministic decisions use 50), and it is
// never read during execution — only the bin range alters execution.
const rebalanceParamsEqual = (a: RebalanceParams, b: RebalanceParams): boolean =>
  a.newLowerBinId === b.newLowerBinId && a.newUpperBinId === b.newUpperBinId;

function proposalGateAction(proposal: AgentProposal): ProposalValidationResult | null {
  if (!VALID_ACTIONS.includes(proposal.action)) {
    return { valid: false, reason: `Invalid action: ${proposal.action}` };
  }
  return null;
}

function proposalGatePool(
  proposal: AgentProposal,
  ctx: RiskContext,
): ProposalValidationResult | null {
  if (proposal.poolAddress !== ctx.poolAddress) {
    return {
      valid: false,
      reason: `Proposal poolAddress ${proposal.poolAddress} does not match evaluated pool ${ctx.poolAddress}`,
    };
  }
  return null;
}

function proposalGateDowngrade(proposal: AgentProposal): ProposalValidationResult | null {
  if (proposal.originalAction === "EXIT" && proposal.action !== "EXIT") {
    return { valid: false, reason: "Cannot downgrade a safety EXIT to a non-EXIT action" };
  }
  return null;
}

function proposalGatePromotion(proposal: AgentProposal): ProposalValidationResult | null {
  if (
    proposal.originalAction !== undefined &&
    proposal.originalAction !== "ENTER" &&
    proposal.action === "ENTER"
  ) {
    return { valid: false, reason: `Cannot promote ${proposal.originalAction} to ENTER` };
  }
  return null;
}

function preservesOriginalDecision(proposal: AgentProposal, ctx: RiskContext): boolean {
  const original = ctx.originalDecision;
  return (
    original !== undefined &&
    proposal.action === original.action &&
    Math.abs(proposal.confidence - original.confidence) < 0.005 &&
    (proposal.positionSizeUsd === undefined ||
      proposal.positionSizeUsd === original.positionSizeUsd) &&
    (proposal.rebalanceParams === undefined ||
      (original.rebalanceParams !== undefined &&
        rebalanceParamsEqual(proposal.rebalanceParams, original.rebalanceParams)))
  );
}

function proposalGateConfidence(
  proposal: AgentProposal,
  config: AppConfig,
  preserves: boolean,
): ProposalValidationResult | null {
  if (
    !preserves &&
    (!Number.isFinite(proposal.confidence) ||
      proposal.confidence < config.agentProposalMinConfidence ||
      proposal.confidence > 1)
  ) {
    return {
      valid: false,
      reason:
        `Confidence ${proposal.confidence} must be finite and between ` +
        `${config.agentProposalMinConfidence} and 1`,
    };
  }
  return null;
}

function proposalGateEnterSize(proposal: AgentProposal): ProposalValidationResult | null {
  if (proposal.action === "ENTER" && proposal.positionSizeUsd === undefined) {
    return { valid: false, reason: "ENTER proposals must include positionSizeUsd" };
  }
  if (proposal.action === "ENTER") {
    if (
      proposal.positionSizeUsd === undefined ||
      !Number.isFinite(proposal.positionSizeUsd) ||
      proposal.positionSizeUsd <= 0
    ) {
      return { valid: false, reason: "positionSizeUsd must be a positive finite number for ENTER" };
    }
  }
  return null;
}

function proposalGateRebalancePosition(
  proposal: AgentProposal,
  ctx: RiskContext,
): ProposalValidationResult | null {
  if (proposal.action !== "REBALANCE") return null;
  if (proposal.rebalanceParams === undefined) {
    return { valid: false, reason: "REBALANCE proposals must include rebalanceParams" };
  }
  const hasPosition = ctx.openPositions.some((p) => p.poolAddress === proposal.poolAddress);
  if (!hasPosition) {
    return {
      valid: false,
      reason: `Cannot REBALANCE pool ${proposal.poolAddress} — no open position`,
    };
  }
  return null;
}

function proposalGateExitPosition(
  proposal: AgentProposal,
  ctx: RiskContext,
): ProposalValidationResult | null {
  if (proposal.action !== "EXIT") return null;
  const hasPosition = ctx.openPositions.some((p) => p.poolAddress === proposal.poolAddress);
  if (!hasPosition && proposal.originalAction !== "EXIT") {
    return {
      valid: false,
      reason: `Cannot EXIT pool ${proposal.poolAddress} — no open position`,
    };
  }
  return null;
}

function proposalGateSizeFinite(proposal: AgentProposal): ProposalValidationResult | null {
  if (proposal.positionSizeUsd === undefined) return null;
  if (!Number.isFinite(proposal.positionSizeUsd) || proposal.positionSizeUsd < 0) {
    return { valid: false, reason: "positionSizeUsd must be a finite non-negative number" };
  }
  return null;
}

function capProposalSize(
  proposal: AgentProposal,
  ctx: RiskContext,
  config: AppConfig,
): { capped: number } | { error: string } | null {
  if (proposal.positionSizeUsd === undefined) return null;
  const agentMaxSizeUsd = ctx.portfolioValueUsd * config.agentProposalMaxPositionSizePct;
  const perPoolCapUsd = ctx.portfolioValueUsd * config.maxPerPoolAllocationPct;
  let cappedSizeUsd = Math.min(proposal.positionSizeUsd, agentMaxSizeUsd, perPoolCapUsd);
  if (proposal.action === "ENTER") {
    const allocationResult = evaluatePerPoolAllocation({
      proposedDepositUsd: cappedSizeUsd,
      portfolioValueUsd: ctx.portfolioValueUsd,
      openPositions: ctx.openPositions,
      maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
      maxOpenPositions: config.maxOpenPositions,
      poolAddress: proposal.poolAddress,
      maxPositionsPerPool: config.maxPositionsPerPool,
    });
    if (!allocationResult.approved) return { error: allocationResult.reason };
    cappedSizeUsd = allocationResult.adjustedDepositUsd;
  }
  if (cappedSizeUsd !== proposal.positionSizeUsd) return { capped: cappedSizeUsd };
  return null;
}

function proposalGateRebalanceParams(
  proposal: AgentProposal,
  ctx: RiskContext,
  config: AppConfig,
): ProposalValidationResult | null {
  if (proposal.rebalanceParams === undefined) return null;
  const { newLowerBinId, newUpperBinId } = proposal.rebalanceParams;
  if (!Number.isInteger(newLowerBinId) || !Number.isInteger(newUpperBinId)) {
    return { valid: false, reason: "Rebalance bin IDs must be integers" };
  }
  if (newUpperBinId <= newLowerBinId) {
    return { valid: false, reason: "Invalid rebalance range: upperBinId must be > lowerBinId" };
  }
  const rangeWidth = newUpperBinId - newLowerBinId;
  if (rangeWidth > config.maxRebalanceRangeBins) {
    return {
      valid: false,
      reason: `Rebalance range ${rangeWidth} bins exceeds max ${config.maxRebalanceRangeBins}`,
    };
  }
  if (
    ctx.activeBinId !== undefined &&
    Number.isFinite(ctx.activeBinId) &&
    (ctx.activeBinId < newLowerBinId || ctx.activeBinId > newUpperBinId)
  ) {
    return {
      valid: false,
      reason:
        `Rebalance range [${newLowerBinId}, ${newUpperBinId}] does not contain ` +
        `active bin ${ctx.activeBinId}`,
    };
  }
  return null;
}

function resolveProposalPositionId(
  proposal: AgentProposal,
  ctx: RiskContext,
): { positionId?: string } | { error: string } {
  let positionId = proposal.positionId ?? ctx.originalDecision?.positionId;
  if (positionId !== undefined) {
    const target = ctx.openPositions.find((p) => p.id === positionId);
    if (target === undefined || target.poolAddress !== proposal.poolAddress) {
      return { error: `Position ${positionId} does not belong to pool ${proposal.poolAddress}` };
    }
    return { positionId };
  }
  if (proposal.action === "EXIT" || proposal.action === "REBALANCE") {
    const poolPositions = ctx.openPositions.filter((p) => p.poolAddress === proposal.poolAddress);
    if (poolPositions.length === 1) {
      const first = poolPositions[0];
      if (first) return { positionId: first.id };
    }
  }
  return {};
}

function validateEarlyProposalGates(
  proposal: AgentProposal,
  ctx: RiskContext,
  config: AppConfig,
  preserves: boolean,
): ProposalValidationResult | null {
  return (
    proposalGateAction(proposal) ??
    proposalGatePool(proposal, ctx) ??
    proposalGateDowngrade(proposal) ??
    proposalGatePromotion(proposal) ??
    proposalGateConfidence(proposal, config, preserves) ??
    proposalGateEnterSize(proposal) ??
    proposalGateRebalancePosition(proposal, ctx) ??
    proposalGateExitPosition(proposal, ctx) ??
    proposalGateSizeFinite(proposal)
  );
}

export function evaluateAgentProposal(
  proposal: AgentProposal,
  ctx: RiskContext,
  config: AppConfig,
): ProposalValidationResult {
  const preserves = preservesOriginalDecision(proposal, ctx);
  const original = ctx.originalDecision;

  const early = validateEarlyProposalGates(proposal, ctx, config, preserves);
  if (early) return early;

  let adjustedPositionSizeUsd = proposal.positionSizeUsd;
  const cap = capProposalSize(proposal, ctx, config);
  if (cap && "error" in cap) return { valid: false, reason: cap.error };
  if (cap && "capped" in cap) adjustedPositionSizeUsd = cap.capped;

  const rebalanceGate = proposalGateRebalanceParams(proposal, ctx, config);
  if (rebalanceGate) return rebalanceGate;

  const posRes = resolveProposalPositionId(proposal, ctx);
  if ("error" in posRes) return { valid: false, reason: posRes.error };

  const adjustedDecision: AgentDecision = {
    action: proposal.action,
    poolAddress: proposal.poolAddress,
    confidence: preserves && original ? original.confidence : proposal.confidence,
    reasoning: proposal.reasoning,
    ...(adjustedPositionSizeUsd !== undefined && { positionSizeUsd: adjustedPositionSizeUsd }),
    ...(proposal.rebalanceParams !== undefined && { rebalanceParams: proposal.rebalanceParams }),
    ...(posRes.positionId !== undefined && { positionId: posRes.positionId }),
  };

  return {
    valid: true,
    reason: "Agent proposal validated",
    adjustedDecision,
  };
}

export const RiskLive = (riskConfig: RiskConfig) =>
  Layer.succeed(
    RiskService,
    RiskService.of({
      evaluate(decision: AgentDecision, ctx: RiskContext): RiskResult {
        return evaluateRisk(riskConfig, decision, ctx);
      },
    } satisfies RiskApi),
  );

// ─── Agent-originated REBALANCE capital-protection gates ─────────────────────

export interface AgentRebalanceCapitalGateInput {
  readonly now: number;
  readonly lastRebalanceAt: number;
  readonly minRebalanceIntervalMs: number;
  /** When true (OOR grace expired), min-interval may be bypassed. */
  readonly oorGraceExpired: boolean;
  readonly rebalanceGasCostNative: number;
  readonly nativePriceUsd: number;
  readonly positionDailyFeesUsd: number;
  readonly minDaysOfFeesPaidAhead: number;
  readonly recoveryProbability: number;
  readonly oorRecoveryHoldThreshold: number;
}

/**
 * Re-apply the deterministic REBALANCE capital-protection gates to an
 * agent-originated REBALANCE so advisors cannot bypass min-interval, gas, or
 * OOR recovery holds that protect the deterministic path.
 */
export interface CapitalGateVerdict {
  readonly approved: boolean;
  readonly reason: string;
}

export function evaluateAgentRebalanceCapitalGates(
  input: AgentRebalanceCapitalGateInput,
): CapitalGateVerdict {
  const timeSinceRebal = input.now - input.lastRebalanceAt;
  if (timeSinceRebal < input.minRebalanceIntervalMs && !input.oorGraceExpired) {
    return {
      approved: false,
      reason:
        `Agent REBALANCE blocked by min-interval: ${timeSinceRebal}ms < ` +
        `${input.minRebalanceIntervalMs}ms`,
    };
  }

  const gasGate = evaluateGasGate({
    rebalanceGasCostNative: input.rebalanceGasCostNative,
    nativePriceUsd: input.nativePriceUsd,
    positionDailyFeesUsd: input.positionDailyFeesUsd,
    minDaysOfFeesPaidAhead: input.minDaysOfFeesPaidAhead,
  });
  if (!gasGate.approved) {
    return {
      approved: false,
      reason: `Agent REBALANCE blocked by gas-gate: ${gasGate.reason}`,
    };
  }

  if (shouldHoldForRecovery(input.recoveryProbability, input.oorRecoveryHoldThreshold)) {
    return {
      approved: false,
      reason:
        `Agent REBALANCE blocked by recovery-gate: probability ` +
        `${input.recoveryProbability.toFixed(2)} >= ${input.oorRecoveryHoldThreshold}`,
    };
  }

  return { approved: true, reason: "Agent REBALANCE capital gates passed" };
}

// ─── F1: Gas-aware rebalancing gate ──────────────────────────────────────────

export interface GasGateInput {
  readonly rebalanceGasCostNative: number;
  readonly nativePriceUsd: number;
  readonly positionDailyFeesUsd: number;
  readonly minDaysOfFeesPaidAhead: number;
}

export interface GasGateResult {
  readonly approved: boolean;
  readonly reason: string;
  readonly gasCostUsd: number;
  readonly feesThresholdUsd: number;
}

/**
 * Gate REBALANCE on a cost-vs-benefit check: only rebalance if the on-chain
 * gas cost is recovered by N days of position fees. Zero-fee pools are always
 * rejected (let downstream risk gates handle those).
 */
export function evaluateGasGate(input: GasGateInput): GasGateResult {
  const gasCostUsd = input.rebalanceGasCostNative * input.nativePriceUsd;
  const feesThresholdUsd = input.positionDailyFeesUsd * input.minDaysOfFeesPaidAhead;

  if (!Number.isFinite(gasCostUsd) || !Number.isFinite(feesThresholdUsd)) {
    return {
      approved: false,
      reason: "Gas-gate inputs are not finite — refusing rebalance",
      gasCostUsd,
      feesThresholdUsd,
    };
  }

  if (gasCostUsd <= 0) {
    return {
      approved: false,
      reason: `Gas cost must be positive (configured ${input.rebalanceGasCostNative} SOL) — refusing rebalance`,
      gasCostUsd,
      feesThresholdUsd,
    };
  }

  if (input.positionDailyFeesUsd <= 0) {
    return {
      approved: false,
      reason: `Position earns no fees ($${input.positionDailyFeesUsd.toFixed(4)}/day) — rebalance gas not justified`,
      gasCostUsd,
      feesThresholdUsd,
    };
  }

  if (gasCostUsd > feesThresholdUsd) {
    return {
      approved: false,
      reason:
        `Gas cost $${gasCostUsd.toFixed(2)} > ${input.minDaysOfFeesPaidAhead}d fees $${feesThresholdUsd.toFixed(2)} ` +
        `— wait for accrued fees before rebalancing`,
      gasCostUsd,
      feesThresholdUsd,
    };
  }

  return {
    approved: true,
    reason: `Gas $${gasCostUsd.toFixed(2)} <= ${input.minDaysOfFeesPaidAhead}d fees $${feesThresholdUsd.toFixed(2)}`,
    gasCostUsd,
    feesThresholdUsd,
  };
}

// ─── F3: Fee compounding gate ────────────────────────────────────────────────

export interface CompoundGateInput {
  readonly netFeesUsd: number;
  readonly minCompoundFeesUsd: number;
  readonly compoundGasBufferUsd: number;
  readonly rebalanceGasCostUsd: number;
}

export interface CompoundGateResult {
  readonly approved: boolean;
  readonly reason: string;
  readonly thresholdUsd: number;
  readonly savingsUsd: number;
}

/**
 * Decide whether the accrued fees are worth claiming + re-depositing into the
 * same position. Reject if fees don't clear the gas cost + buffer + minimum
 * threshold. Threshold = minCompound + buffer + rebalanceGas (compound tx costs
 * roughly a rebalance's worth of gas).
 */
export function evaluateCompoundGate(input: CompoundGateInput): CompoundGateResult {
  const thresholdUsd =
    input.minCompoundFeesUsd + input.compoundGasBufferUsd + input.rebalanceGasCostUsd;
  const savingsUsd = input.netFeesUsd - thresholdUsd;

  if (
    !Number.isFinite(input.netFeesUsd) ||
    !Number.isFinite(input.minCompoundFeesUsd) ||
    !Number.isFinite(input.compoundGasBufferUsd) ||
    !Number.isFinite(input.rebalanceGasCostUsd)
  ) {
    return {
      approved: false,
      reason: "Compound-gate inputs are not finite — nothing to compound",
      thresholdUsd,
      savingsUsd,
    };
  }

  if (input.netFeesUsd <= 0) {
    return {
      approved: false,
      reason: `Net fees $${input.netFeesUsd.toFixed(4)} — nothing to compound`,
      thresholdUsd,
      savingsUsd,
    };
  }

  if (savingsUsd <= 0) {
    return {
      approved: false,
      reason:
        `Net fees $${input.netFeesUsd.toFixed(2)} ≤ compound cost $${thresholdUsd.toFixed(2)} ` +
        `(min $${input.minCompoundFeesUsd.toFixed(2)} + buffer $${input.compoundGasBufferUsd.toFixed(2)} + gas $${input.rebalanceGasCostUsd.toFixed(2)})`,
      thresholdUsd,
      savingsUsd,
    };
  }

  return {
    approved: true,
    reason: `Net fees $${input.netFeesUsd.toFixed(2)} cover compound cost $${thresholdUsd.toFixed(2)} — savings $${savingsUsd.toFixed(2)}`,
    thresholdUsd,
    savingsUsd,
  };
}

// ─── F5: Multi-pool allocation gate ──────────────────────────────────────────

import type { Position } from "./types.js";

export interface PerPoolAllocationInput {
  readonly proposedDepositUsd: number;
  readonly portfolioValueUsd: number;
  readonly openPositions: ReadonlyArray<Position>;
  readonly maxPerPoolAllocationPct: number;
  readonly maxOpenPositions: number;
  /** Pool the ENTER targets — per-pool count and exposure are measured against it. */
  readonly poolAddress: string;
  /** Max simultaneous positions allowed on the target pool. */
  readonly maxPositionsPerPool: number;
  /** Target pool TVL (USD) — caps per-pool exposure at a % of pool TVL. */
  readonly poolTvlUsd?: number;
  /** Challenge pool-share cap (% of pool TVL, e.g. 10). */
  readonly challengePoolShareCapPct?: number;
  /**
   * The strategy's OWN-book counts (engine-opened positions only): adopted
   * external positions (pubkey set, depositedUsd 0) and paper-exited blocker
   * rows must NOT consume the compounding cadence — a wallet that already
   * holds 16 positions would otherwise block every new ENTER (16/4). The
   * exposure list (`openPositions`) still carries them so per-pool allocation
   * % keeps counting their real value. Omitted → legacy behavior (count ALL).
   */
  readonly countedOpenPositions?: number;
  /** Own-book per-pool count; omitted → poolPositions.length (legacy). */
  readonly countedPoolPositions?: number;
}

export interface PerPoolAllocationResult {
  readonly approved: boolean;
  readonly reason: string;
  readonly adjustedDepositUsd: number;
}

/**
 * Decide whether a proposed ENTER fits the per-pool position-count cap, the
 * hard cap on simultaneously open positions, and the per-pool allocation cap.
 * The allocation cap is measured against the pool's AGGREGATE exposure (the
 * sum of all its positions' current values), so a second position on the
 * same pool only gets the headroom its siblings leave. The deposit is
 * capped to the remaining headroom; ENTER is rejected when a count cap is
 * reached or the headroom rounds the deposit to zero.
 */
export function evaluatePerPoolAllocation(input: PerPoolAllocationInput): PerPoolAllocationResult {
  const poolPositions = input.openPositions.filter((p) => p.poolAddress === input.poolAddress);
  const countedPoolPositions = input.countedPoolPositions ?? poolPositions.length;
  const countedOpenPositions = input.countedOpenPositions ?? input.openPositions.length;
  if (countedPoolPositions >= input.maxPositionsPerPool) {
    return {
      approved: false,
      reason:
        `Per-pool position cap reached (${countedPoolPositions}/${input.maxPositionsPerPool}) ` +
        `for pool ${input.poolAddress}`,
      adjustedDepositUsd: 0,
    };
  }

  if (countedOpenPositions >= input.maxOpenPositions) {
    return {
      approved: false,
      reason: `Max open positions reached (${countedOpenPositions}/${input.maxOpenPositions}) — split across ${input.maxOpenPositions} pools max`,
      adjustedDepositUsd: 0,
    };
  }

  const existingPoolExposureUsd = poolPositions.reduce((sum, p) => sum + p.currentValueUsd, 0);
  if (
    !Number.isFinite(input.proposedDepositUsd) ||
    !Number.isFinite(input.portfolioValueUsd) ||
    !Number.isFinite(input.maxPerPoolAllocationPct) ||
    !Number.isFinite(existingPoolExposureUsd)
  ) {
    return {
      approved: false,
      reason: "Per-pool allocation inputs are not finite — refusing entry",
      adjustedDepositUsd: 0,
    };
  }

  const portfolioCapUsd = Math.max(input.portfolioValueUsd * input.maxPerPoolAllocationPct, 0);
  const tvlShareCapUsd =
    input.challengePoolShareCapPct !== undefined && (input.poolTvlUsd ?? 0) > 0
      ? Math.max((input.poolTvlUsd as number) * (input.challengePoolShareCapPct / 100), 0)
      : Infinity;
  const perPoolCapUsd = Math.min(portfolioCapUsd, tvlShareCapUsd);
  const headroomUsd = Math.max(perPoolCapUsd - existingPoolExposureUsd, 0);
  const adjusted = Math.min(input.proposedDepositUsd, headroomUsd);

  if (adjusted <= 0) {
    return {
      approved: false,
      reason:
        `Per-pool cap $${perPoolCapUsd.toFixed(2)} is already filled by the pool's existing ` +
        `$${existingPoolExposureUsd.toFixed(2)} exposure — proposed $${input.proposedDepositUsd.toFixed(2)} deposit rounds to zero`,
      adjustedDepositUsd: 0,
    };
  }

  return {
    approved: true,
    reason:
      adjusted < input.proposedDepositUsd
        ? `Capped to ${(input.maxPerPoolAllocationPct * 100).toFixed(0)}% of portfolio ($${adjusted.toFixed(0)})`
        : "Within per-pool allocation cap",
    adjustedDepositUsd: adjusted,
  };
}

// ─── F6: Paper-trading validation gate ───────────────────────────────────────

export interface PaperValidationInput {
  readonly paperTrading: boolean;
  readonly paperDaysAccumulated: number;
  readonly minDays: number;
  readonly enforce: boolean;
}

export interface PaperValidationResult {
  readonly approved: boolean;
  readonly reason: string;
  readonly warning?: string;
}

/**
 * Block live ENTER until the user has run the agent in paper mode for at
 * least `minDays` accumulated days. Skipped entirely in paper mode. When
 * enforce=false, the gate emits a warning instead of rejecting — useful for
 * opt-in enforcement during initial deployment.
 */
export function evaluatePaperValidation(input: PaperValidationInput): PaperValidationResult {
  if (input.paperTrading) {
    return {
      approved: true,
      reason: "Paper trading — validation does not apply",
    };
  }

  if (input.paperDaysAccumulated >= input.minDays) {
    return {
      approved: true,
      reason: `Paper validation passed (${input.paperDaysAccumulated}/${input.minDays} days)`,
    };
  }

  if (!input.enforce) {
    return {
      approved: true,
      reason: "Paper validation not enforced",
      warning:
        `Live trading with only ${input.paperDaysAccumulated} paper days — ` +
        `consider running paper for ${input.minDays} days before going live`,
    };
  }

  return {
    approved: false,
    reason:
      `Paper validation gate: only ${input.paperDaysAccumulated}/${input.minDays} paper days accumulated. ` +
      `Live ENTER requires at least ${input.minDays} days of paper trading. ` +
      `Set PAPER_VALIDATION_ENFORCE=false to override (not recommended).`,
  };
}

// ─── F3 fix: token-amount → USD conversion helpers ──────────────────────────

/**
 * Standard token decimals for the symbols we recognize. Unknown tokens
 * return the sentinel `-1` so callers can fail closed rather than guessing
 * decimals for an unrecognized asset. Only SOL/WSOL and USDC/USDT are
 * supported today; the agent is intentionally conservative about pricing
 * anything else because mis-pricing fees can bypass the compound gate.
 */
export function getTokenDecimals(symbol: string): number {
  const upper = symbol.toUpperCase();
  if (upper === "SOL" || upper === "WSOL") return 9;
  if (upper === "USDC" || upper === "USDT") return 6;
  return -1;
}

/**
 * Convert a raw token base-unit amount to a USD estimate. SOL uses
 * nativePriceUsd; USDC/USDT use par ($1). Unknown tokens return 0 (fail closed)
 * so the compound gate rejects instead of compounding on a mis-priced fee.
 */
export function tokenAmountToUsd(
  rawAmount: number,
  tokenSymbol: string,
  nativePriceUsd: number,
): number {
  if (rawAmount === 0) return 0;
  const decimals = getTokenDecimals(tokenSymbol);
  if (decimals < 0) return 0;
  const human = rawAmount / Math.pow(10, decimals);
  const upper = tokenSymbol.toUpperCase();
  if (upper === "USDC" || upper === "USDT") return human;
  return human * nativePriceUsd;
}
