/**
 * Pure entry-size math, extracted verbatim from the ENTER slot in
 * engine/program.ts so both the normal entry path and the opt-in
 * idle-capital redeploy pass share one source of truth.
 */

/** Fraction of the wallet balance the conservative entry size may use. */
export const ENTRY_SIZE_WALLET_FRACTION = 0.5;
/** Fraction of pool TVL the conservative entry size may use. */
export const ENTRY_SIZE_TVL_FRACTION = 0.005;
/** Hard dollar ceiling on a normal (conservative) entry. */
export const ENTRY_SIZE_CAP_USD = 500;
/** Minimum entry size worth submitting, normal and redeploy paths alike. */
export const ENTRY_SIZE_FLOOR_USD = 10;

export interface EntrySizeInput {
  /**
   * Fraction of PORTFOLIO EQUITY each entry targets (wallet + open positions,
   * not just leftover cash). Sizing off the idle wallet alone decays
   * geometrically: every deploy halves the next base, so an engaged book ends
   * up sizing positions off dust — the observed $151.88×2-at-cap pattern on a
   * $10k paper anchor. Equity-share sizing keeps position scale invariant
   * across the deployment cycle. Default 10%. Env: ENTRY_SIZE_EQUITY_FRACTION.
   */
  readonly equityFractionUsd?: number | undefined;
  /** Total portfolio equity (wallet + open positions). When absent, the
   *  legacy wallet-based behavior is preserved exactly. */
  readonly portfolioValueUsd?: number | undefined;
  readonly walletBalanceUsd: number;
  readonly tvlUsd: number;
  /** Hard dollar ceiling on the entry; defaults to ENTRY_SIZE_CAP_USD. */
  readonly maxSizeUsd?: number;
  /** Fraction of pool TVL the entry may use; defaults to ENTRY_SIZE_TVL_FRACTION
   *  (0.005). Config override: ENTRY_SIZE_TVL_FRACTION (env), CHALLENGE_MODE
   *  raises the fallback to 0.05. */
  readonly tvlFractionUsd?: number | undefined;
  /** Minimum entry size worth submitting; defaults to ENTRY_SIZE_FLOOR_USD
   *  ($10). Config override: ENTRY_SIZE_FLOOR_USD (env) — the $10 hard floor
   *  blocks every entry on a small canary wallet (half of $18.6 = $9.30 < $10),
   *  so small wallets need a lower admissible floor. */
  readonly floorUsd?: number | undefined;
}

/**
 * Conservative base entry size.
 *
 * Legacy mode (no portfolioValueUsd): the tightest of half the wallet
 * balance, TVL fraction, and the ceiling, with a floor — byte-identical to
 * the historical inline formula
 * (`max(min(walletBalanceUsd * 0.5, tvlUsd * 0.005, 500), 10)`).
 *
 * Equity-share mode (portfolioValueUsd + equityFractionUsd set): the base is
 * EQUITY × fraction instead of half-the-wallet. Sizing off leftover cash
 * decays geometrically as capital deploys and starves an engaged book; an
 * equity share keeps position scale invariant across the deployment cycle
 * while every downstream cap (per-pool allocation %, positions-per-pool,
 * book size) still bounds aggregate exposure. The wallet term becomes a hard
 * affordability ceiling rather than the sizing basis — in paper the seed IS
 * the portfolio so it never binds; live, it still prevents overspending the
 * actual balance.
 */
export function computeEntrySizeUsd(input: EntrySizeInput): number {
  const tvlTerm = input.tvlUsd * (input.tvlFractionUsd ?? ENTRY_SIZE_TVL_FRACTION);
  const capTerm = input.maxSizeUsd ?? ENTRY_SIZE_CAP_USD;
  if (
    input.portfolioValueUsd !== undefined &&
    input.equityFractionUsd !== undefined &&
    input.portfolioValueUsd > 0 &&
    input.equityFractionUsd > 0
  ) {
    const equityTerm = input.portfolioValueUsd * input.equityFractionUsd;
    return Math.max(
      Math.min(equityTerm, tvlTerm, capTerm, input.walletBalanceUsd * ENTRY_SIZE_WALLET_FRACTION),
      input.floorUsd ?? ENTRY_SIZE_FLOOR_USD,
    );
  }
  const maxPositionSize = Math.min(
    input.walletBalanceUsd * ENTRY_SIZE_WALLET_FRACTION,
    tvlTerm,
    capTerm,
  );
  return Math.max(maxPositionSize, input.floorUsd ?? ENTRY_SIZE_FLOOR_USD);
}

export interface IdleRedeploySizeInput {
  /** Idle capital detected this cycle (USDC wallet balance live; undeployed paper seed). */
  readonly idleCapitalUsd: number;
  /** Portfolio value = wallet + open positions, as sized by the risk gates. */
  readonly portfolioValueUsd: number;
  /** MAX_PER_POOL_ALLOCATION_PCT — the redeploy size never exceeds this share. */
  readonly maxPerPoolAllocationPct: number;
  /** IDLE_REDEPLOY_MAX_SIZE_USD — the configured hard ceiling on one redeploy. */
  readonly maxSizeUsd: number;
}

/**
 * Wider idle-capital deployment size proposed by the redeploy pass: half the
 * idle capital, bounded by the per-pool allocation share of the portfolio and
 * the configured idle-redeploy ceiling, floored at 0 (the pass applies the
 * shared $10 floor before dispatching). This is the "larger than the
 * conservative default" size; evaluatePerPoolAllocation and risk gate 6
 * re-cap it to the pool's real remaining headroom before execution, so it
 * widens the CEILING without ever breaching a cap.
 */
export function computeIdleRedeploySizeUsd(input: IdleRedeploySizeInput): number {
  return Math.max(
    Math.min(
      input.idleCapitalUsd * ENTRY_SIZE_WALLET_FRACTION,
      input.portfolioValueUsd * input.maxPerPoolAllocationPct,
      input.maxSizeUsd,
    ),
    0,
  );
}
