/**
 * Limit-order style requests. On Uniswap v3/v4 a limit order is a one-sided
 * range position placed entirely above (ask) or below (bid) the active tick;
 * the engine encodes the intent with these fields and the adapter maps them
 * to ticks.
 */
export type LimitOrderSide = "ask" | "bid";

export interface LimitOrderRequest {
  readonly side: LimitOrderSide;
  /** Target tick (v3/v4 tick, the CLMM equivalent of a tick id). */
  readonly targetTick: number;
  readonly amountAtomic: bigint;
  readonly maxActiveTickSlippage?: number;
}
