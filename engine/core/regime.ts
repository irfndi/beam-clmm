/**
 * regime.ts — classify the pool's current market state, once per decision.
 *
 * The engine already computes the ingredients (volatility σ, net drift,
 * TVL velocity, volume authenticity) but each rule re-interprets them
 * locally. Classifying once gives the policy one place to adapt and gives
 * every journal row a regime stamp, so "this rule loses money in trending
 * pools" becomes an answerable question.
 */

import type { Regime } from "./policy.js";

export interface RegimeInput {
  /** σ of recent active-bin moves. */
  readonly volatilityStddev: number;
  /** σ at/above which the pool is high-volatility. */
  readonly maxVolatilityStddev: number;
  /** Net active-bin drift over the lookback window (signed). */
  readonly netDriftBins: number;
  /** Signed 24h TVL change, fraction. */
  readonly tvlVelocity: number;
  readonly volumeAuthenticity: number;
  readonly volumeAuthenticityKnown: boolean;
}

/** Severity order for reporting: degraded is the most protective. */
export const REGIME_ORDER: ReadonlyArray<Regime> = ["degraded", "volatile", "trending", "calm"];

/**
 * Degraded → volatile → trending → calm. Degraded wins over everything: a
 * pool losing its TVL or showing fake volume is a capital-protection state,
 * not a trading opportunity, regardless of how quiet the price looks.
 */
export function classifyRegime(input: RegimeInput): Regime {
  const tvlFlight = Number.isFinite(input.tvlVelocity) && input.tvlVelocity <= -0.3;
  const fakeVolume =
    input.volumeAuthenticityKnown &&
    Number.isFinite(input.volumeAuthenticity) &&
    input.volumeAuthenticity < 0.5;
  if (tvlFlight || fakeVolume) return "degraded";

  if (
    Number.isFinite(input.volatilityStddev) &&
    Number.isFinite(input.maxVolatilityStddev) &&
    input.maxVolatilityStddev > 0 &&
    input.volatilityStddev >= input.maxVolatilityStddev
  ) {
    return "volatile";
  }

  const drift = Number.isFinite(input.netDriftBins) ? Math.abs(input.netDriftBins) : 0;
  const sigma = Number.isFinite(input.volatilityStddev) ? input.volatilityStddev : 0;
  if (drift >= Math.max(3, 2 * sigma)) return "trending";

  return "calm";
}

/** Human-readable one-liner for logs and journal rows. */
export function describeRegime(input: RegimeInput, regime: Regime): string {
  return (
    `regime=${regime} (σ=${input.volatilityStddev.toFixed(2)}/${input.maxVolatilityStddev}, ` +
    `drift=${input.netDriftBins.toFixed(1)}bins, tvlVel=${(input.tvlVelocity * 100).toFixed(1)}%, ` +
    `volAuth=${input.volumeAuthenticityKnown ? input.volumeAuthenticity.toFixed(2) : "unknown"})`
  );
}
