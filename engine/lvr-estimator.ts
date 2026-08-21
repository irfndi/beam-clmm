/**
 * LVR (loss-versus-rebalancing) estimator — logging-only.
 *
 * From Di Nosse & Lillo (arXiv 2606.23070), Eq. 17: a Uniswap v3 position's
 * instantaneous LVR cost is  σ²·L·√m / 4. Normalized by the position's own
 * value (L·√m at mid-range, Milionis et al.), that collapses to
 * LVR% ≈ σ²/8 per unit time — the concentration-amplified short-volatility
 * bleed of providing liquidity. An LP profits only when realized fee yield
 * exceeds it:  edge = feeYield − σ²/8.
 *
 * All inputs are LOCAL (pool_snapshots): trailing hourly log-return variance
 * for σ², and Krystal-measured 24h fees over TVL for fee yield. No RPC.
 *
 * LOGGING-ONLY by design, same playbook as market-stress.ts: the score must
 * separate our past winning entries from the losing ones on recorded data
 * before any gate promotion. It gates nothing today.
 */

export interface LvrAssessment {
  readonly poolAddress: string;
  /** Annualized hourly-log-return variance (decimal, e.g. 0.85 = 85%/yr). */
  readonly annualizedVariance: number;
  /** Trailing 24h fees / TVL, annualized ×365 (decimal). */
  readonly annualizedFeeYield: number;
  /** feeYield − σ²/8 (annualized decimal). Negative = LP-losing regime. */
  readonly edge: number;
}

/** Minimum aligned hourly samples to trust the variance estimate. */
const MIN_SAMPLES = 12;

/**
 * Annualized variance of hourly log returns from irregular snapshot prices.
 * Prices are last-known-carried-forward onto an hourly grid; returns are
 * consecutive-grid-point log diffs; annualization is ×24×365 under the
 * random-walk scaling (√time for vol ⇒ ×time for variance).
 */
export function annualizedVarianceFromSnapshots(
  snaps: ReadonlyArray<{ timestamp: number; price: number }>,
  nowMs: number,
  windowHours: number,
): { variance: number | null; samples: number } {
  const gridStart = nowMs - windowHours * 3_600_000;
  const sorted = [...snaps].filter((s) => s.price > 0).sort((a, b) => a.timestamp - b.timestamp);
  const prices: number[] = [];
  for (let t = gridStart; t <= nowMs; t += 3_600_000) {
    let last: number | null = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i]!.timestamp <= t) {
        last = sorted[i]!.price;
        break;
      }
    }
    if (last !== null) prices.push(last);
  }
  if (prices.length < MIN_SAMPLES + 1) return { variance: null, samples: prices.length - 1 };
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) rets.push(Math.log(prices[i]! / prices[i - 1]!));
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  let acc = 0;
  for (const r of rets) acc += (r - mean) ** 2;
  const hourlyVar = acc / rets.length;
  return { variance: hourlyVar * 24 * 365, samples: rets.length };
}

/**
 * The entry-quality score: annualized fee yield minus the σ²/8 LVR drag.
 * Returns null when inputs are insufficient (caller logs and skips).
 */
export function estimateLvrEdge(params: {
  annualizedFeeYield: number;
  annualizedVariance: number;
}): number {
  return params.annualizedFeeYield - params.annualizedVariance / 8;
}
