/**
 * cost-model.ts — one place that answers "what does this action cost, in USD?".
 *
 * Why this exists: the engine used to price chain actions in three unrelated
 * places with three unrelated numbers — `PAPER_GAS_COST_USD=0.5` × 2 per paper
 * round trip, `REBALANCE_GAS_COST_NATIVE × NATIVE_PRICE_USD` ($18.85 per
 * rebalance, which blocked every rebalance on Base), and `ENTER_ROUND_TRIP_GAS_USD`
 * ($0.15). A $0.02 Base mint and an $18.85 phantom cannot both be right, and a
 * capital-allocation rule can only be as good as its cost term.
 *
 * Everything here is PURE. Gas price and native price are inputs so the same
 * model works in paper, replay and live, and so a decision is reproducible
 * from its recorded facts.
 *
 * Defaults are Base L2 (8453): ~0.02 gwei execution gas, a small L1 data fee
 * per transaction, 0.05% swap tier and a couple of bps of slippage on majors.
 * They are deliberately conservative on the cost side — over-estimating cost
 * refuses a marginal trade, under-estimating it prints losses.
 */

/** Chain action whose cost we price. */
export type CostOperation = "enter" | "exit" | "rebalance" | "claim" | "swap";

/** Gas units (not wei) one action burns, by operation. */
export interface GasUnitsByOperation {
  readonly enter: number;
  readonly exit: number;
  readonly rebalance: number;
  readonly claim: number;
  readonly swap: number;
}

/**
 * Measured-on-Base gas units. A v3 mint is ~350k, a burn ~250k, an atomic
 * rebalance (collect + burn + mint) ~600k, a collect ~150k and a Universal
 * Router swap ~180k. Numbers are padded ~20% so a cold storage slot or a
 * first-time approval cannot make the estimate optimistic.
 */
export const BASE_GAS_UNITS: GasUnitsByOperation = {
  enter: 480_000,
  exit: 320_000,
  rebalance: 640_000,
  claim: 180_000,
  swap: 200_000,
};

export interface CostModelConfig {
  /** Execution gas price in gwei (Base is usually 0.005–0.05). */
  readonly gasPriceGwei: number;
  /** USD price of 1 native ETH. */
  readonly nativePriceUsd: number;
  /** Per-transaction L1 data fee (OP-stack calldata cost), USD. */
  readonly l1DataFeeUsd: number;
  /** LP swap fee in basis points (5 = 0.05%). */
  readonly swapFeeBps: number;
  /** Expected slippage/price impact in basis points per swap. */
  readonly slippageBps: number;
  /** Gas units per operation. */
  readonly gasUnits: GasUnitsByOperation;
}

/**
 * Base L2 defaults. `swapFeeBps`/`slippageBps` describe one swap leg; a round
 * trip pays two of them (one on entry, one on exit).
 */
export const DEFAULT_COST_MODEL: CostModelConfig = {
  gasPriceGwei: 0.02,
  nativePriceUsd: 3_000,
  l1DataFeeUsd: 0.005,
  swapFeeBps: 5,
  slippageBps: 4,
  gasUnits: BASE_GAS_UNITS,
};

/** Cost expressed in USD plus the components, so a decision can explain itself. */
export interface OperationCost {
  readonly operation: CostOperation;
  readonly gasUsd: number;
  readonly l1DataFeeUsd: number;
  readonly swapUsd: number;
  readonly slippageUsd: number;
  readonly totalUsd: number;
}

const WEI_PER_GWEI = 1_000_000_000;
const BPS_DENOMINATOR = 10_000;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolve a model from engine config, filling any unset field with the default. */
export function costModelFromConfig(config: {
  readonly gasPriceGwei?: number | undefined;
  readonly nativePriceUsd?: number | undefined;
  readonly l1DataFeeUsd?: number | undefined;
  readonly swapFeeBps?: number | undefined;
  readonly slippageBps?: number | undefined;
}): CostModelConfig {
  return {
    gasPriceGwei: positiveOr(config.gasPriceGwei ?? NaN, DEFAULT_COST_MODEL.gasPriceGwei),
    nativePriceUsd: positiveOr(config.nativePriceUsd ?? NaN, DEFAULT_COST_MODEL.nativePriceUsd),
    l1DataFeeUsd:
      config.l1DataFeeUsd !== undefined && Number.isFinite(config.l1DataFeeUsd)
        ? Math.max(0, config.l1DataFeeUsd)
        : DEFAULT_COST_MODEL.l1DataFeeUsd,
    swapFeeBps:
      config.swapFeeBps !== undefined && Number.isFinite(config.swapFeeBps)
        ? Math.max(0, config.swapFeeBps)
        : DEFAULT_COST_MODEL.swapFeeBps,
    slippageBps:
      config.slippageBps !== undefined && Number.isFinite(config.slippageBps)
        ? Math.max(0, config.slippageBps)
        : DEFAULT_COST_MODEL.slippageBps,
    gasUnits: BASE_GAS_UNITS,
  };
}

export interface GasCost {
  readonly gasUsd: number;
  readonly l1DataFeeUsd: number;
}

/** Gas + L1 data fee for one transaction. */
export function estimateGasCostUsd(operation: CostOperation, model: CostModelConfig): GasCost {
  const units = model.gasUnits[operation];
  const gasPriceWei = Math.max(0, model.gasPriceGwei) * WEI_PER_GWEI;
  const gasUsd = (units * gasPriceWei * Math.max(0, model.nativePriceUsd)) / 1e18;
  return {
    gasUsd: Number.isFinite(gasUsd) ? gasUsd : 0,
    l1DataFeeUsd: Math.max(0, model.l1DataFeeUsd),
  };
}

export interface SwapCost {
  readonly swapUsd: number;
  readonly slippageUsd: number;
}

/** Swap fee + slippage for moving `sizeUsd` through one pool swap. */
export function estimateSwapCostUsd(sizeUsd: number, model: CostModelConfig): SwapCost {
  const size = Math.max(0, finiteOr(sizeUsd, 0));
  const swapUsd = (size * Math.max(0, model.swapFeeBps)) / BPS_DENOMINATOR;
  const slippageUsd = (size * Math.max(0, model.slippageBps)) / BPS_DENOMINATOR;
  return { swapUsd, slippageUsd };
}

/**
 * Total USD cost of one operation at a given position size.
 *
 * `swaps` is the number of pool swaps the operation performs: a native-paired
 * entry costs one swap, an exit that unwinds only one leg costs one swap, and
 * a rebalance that converts the collected side costs one. The default is
 * derived per operation so callers do not have to think about it, and can be
 * overridden when the route is known.
 */
export function estimateOperationCostUsd(
  operation: CostOperation,
  sizeUsd: number,
  model: CostModelConfig = DEFAULT_COST_MODEL,
  swaps?: number,
): OperationCost {
  const gas = estimateGasCostUsd(operation, model);
  const swapLegs = swaps ?? (operation === "claim" ? 0 : 1);
  const swap = estimateSwapCostUsd(sizeUsd, model);
  const swapUsd = swap.swapUsd * Math.max(0, swapLegs);
  const slippageUsd = swap.slippageUsd * Math.max(0, swapLegs);
  const totalUsd = gas.gasUsd + gas.l1DataFeeUsd + swapUsd + slippageUsd;
  return {
    operation,
    gasUsd: gas.gasUsd,
    l1DataFeeUsd: gas.l1DataFeeUsd,
    swapUsd,
    slippageUsd,
    totalUsd: Number.isFinite(totalUsd) ? totalUsd : Number.POSITIVE_INFINITY,
  };
}

/** Cost of opening a position (mint + one swap leg). */
export function estimateEnterCostUsd(
  sizeUsd: number,
  model: CostModelConfig = DEFAULT_COST_MODEL,
): OperationCost {
  return estimateOperationCostUsd("enter", sizeUsd, model, 1);
}

/** Cost of closing a position (burn + one swap leg to settle). */
export function estimateExitCostUsd(
  sizeUsd: number,
  model: CostModelConfig = DEFAULT_COST_MODEL,
): OperationCost {
  return estimateOperationCostUsd("exit", sizeUsd, model, 1);
}

/**
 * Cost of one full position cycle: enter + exit. This is the number an entry
 * decision must recover before it can be profitable.
 */
export function estimateRoundTripCostUsd(
  sizeUsd: number,
  model: CostModelConfig = DEFAULT_COST_MODEL,
): OperationCost {
  const enter = estimateEnterCostUsd(sizeUsd, model);
  const exit = estimateExitCostUsd(sizeUsd, model);
  return {
    operation: "enter",
    gasUsd: enter.gasUsd + exit.gasUsd,
    l1DataFeeUsd: enter.l1DataFeeUsd + exit.l1DataFeeUsd,
    swapUsd: enter.swapUsd + exit.swapUsd,
    slippageUsd: enter.slippageUsd + exit.slippageUsd,
    totalUsd: enter.totalUsd + exit.totalUsd,
  };
}

/** Cost of a rebalance (collect + burn + mint + one conversion swap). */
export function estimateRebalanceCostUsd(
  sizeUsd: number,
  model: CostModelConfig = DEFAULT_COST_MODEL,
): OperationCost {
  return estimateOperationCostUsd("rebalance", sizeUsd, model, 1);
}

/** Cost of collecting fees (no swap). */
export function estimateClaimCostUsd(model: CostModelConfig = DEFAULT_COST_MODEL): OperationCost {
  return estimateOperationCostUsd("claim", 0, model, 0);
}
