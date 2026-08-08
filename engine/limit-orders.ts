/**
 * Limit-order style requests. On Uniswap v3/v4 a limit order is a one-sided
 * range position placed entirely above (ask) or below (bid) the active tick;
 * the engine encodes the intent with these fields and the adapter maps them
 * to ticks.
 */
export type LimitOrderSide = "ask" | "bid";

export interface LimitOrderRequest {
  readonly side: LimitOrderSide;
  /** Target tick (v3/v4 tick, the CLMM equivalent of a DLMM bin id). */
  readonly targetTick: number;
  readonly amountAtomic: bigint;
  readonly maxActiveTickSlippage?: number;
}

export interface ValidatedLimitOrderRequest extends LimitOrderRequest {
  readonly isAskSide: boolean;
}

export function validateLimitOrderRequest(
  request: LimitOrderRequest,
): ValidatedLimitOrderRequest {
  if (!Number.isSafeInteger(request.targetTick)) {
    throw new Error("Limit-order target tick must be an integer");
  }
  if (request.amountAtomic <= 0n) {
    throw new Error("Limit-order amount must be positive");
  }
  if (
    request.maxActiveTickSlippage !== undefined &&
    (!Number.isSafeInteger(request.maxActiveTickSlippage) || request.maxActiveTickSlippage < 0)
  ) {
    throw new Error("Limit-order active-tick slippage must be a non-negative integer");
  }
  return { ...request, isAskSide: request.side === "ask" };
}
