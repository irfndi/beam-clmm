/**
 * policy.ts — thresholds and rule arming as DATA, not scattered env reads.
 *
 * Today `AppConfig` carries 238 fields and ~147 env keys, and a rule's
 * threshold is read from that object at the point of use. That makes a
 * strategy change a redeploy of the whole engine, impossible to A/B, and
 * impossible to explain after the fact (which threshold was live when this
 * position lost money?).
 *
 * A policy is a versioned value object. `buildPolicy` translates the legacy
 * config into one so behaviour is unchanged on day one; regime profiles then
 * scale it per market state. Every decision records the policy version that
 * produced it.
 */

import type { AppConfig } from "../config-service.js";
import {
  DEFAULT_DAILY_MOVE_PCT,
  DEFAULT_ENTRY_HORIZON_DAYS,
  DEFAULT_MIN_EV_USD,
} from "../unit-economics.js";

export type Regime = "calm" | "trending" | "volatile" | "degraded";

export interface EntryPolicy {
  /** Entries are disabled entirely in a `degraded` profile. */
  readonly enabled: boolean;
  readonly minFeeIlRatio: number;
  readonly minVolumeAuthenticity: number;
  readonly minBinUtilization: number;
  /** Weighted signal score an ENTER must reach. */
  readonly minEntryScore: number;
  /** Measured trailing-24h price range cap for an entry, percent. */
  readonly maxObservedRangePct: number;
  /** Highest daily fee yield (percent of TVL) treated as repeatable, not a spike. */
  readonly maxDailyFeeYieldPct: number;
  /** Holding horizon the EV is measured over. */
  readonly horizonDays: number;
  readonly minEvUsd: number;
  /** Longest break-even hold an entry may require, in days. */
  readonly maxBreakEvenHoldDays: number;
  readonly maxDailyMovePct: number;
  /** Fee-capture multiplier from range concentration (1 = pro-rata). */
  readonly concentrationFactor: number;
  /** Expected share of the horizon in range, 0..1. */
  readonly inRangeFraction: number;
}

export interface ExitPolicy {
  readonly stopLossPct: number;
  readonly trailingStopPct: number;
  /** Consecutive breaches required before a stop fires. */
  readonly confirmCycles: number;
  /** Fee/IL below this is a degradation EXIT. */
  readonly feeIlExitFloor: number;
  readonly tvlDropExitPct: number;
  /** Drift (percent of range) beyond which a rebalance is warranted. */
  readonly oorDriftPct: number;
  readonly oorGraceCycles: number;
  /** σ above which a volatile pool exits rather than re-ranges. */
  readonly maxVolatilityStddev: number;
  /** Age beyond which a low-yield position is a time stop; 0 disables. */
  readonly maxPositionAgeMs: number;
}

export interface PortfolioPolicy {
  readonly maxOpenPositions: number;
  readonly maxPositionsPerPool: number;
  readonly maxPerPoolAllocationPct: number;
  readonly maxDailyDrawdownPct: number;
}

/** Multipliers applied to the base policy for one market regime. */
export interface RegimeProfile {
  readonly entriesEnabled: boolean;
  readonly minEvMultiplier: number;
  readonly entrySizeMultiplier: number;
  readonly stopLossMultiplier: number;
  readonly driftMultiplier: number;
  readonly horizonMultiplier: number;
}

export interface DecisionPolicy {
  readonly version: string;
  readonly entry: EntryPolicy;
  readonly exit: ExitPolicy;
  readonly portfolio: PortfolioPolicy;
  readonly profiles: Readonly<Record<Regime, RegimeProfile>>;
}

/**
 * Day-one policy: derived from the existing config so turning the rule engine
 * on does not silently change thresholds. Only the EV horizon and the
 * entry-size economics are new.
 */
export function buildPolicy(config: AppConfig): DecisionPolicy {
  return {
    version: "v1",
    entry: {
      enabled: true,
      minFeeIlRatio: config.minFeeIlRatio,
      minVolumeAuthenticity: config.volumeAuthThreshold,
      minBinUtilization: config.minBinUtilization,
      minEntryScore: config.weightedEntryScoreThreshold,
      maxObservedRangePct: config.maxObservedPriceRangePct,
      maxDailyFeeYieldPct: 10,
      horizonDays: DEFAULT_ENTRY_HORIZON_DAYS,
      minEvUsd: DEFAULT_MIN_EV_USD,
      maxBreakEvenHoldDays: config.maxBreakEvenHoldDays ?? 3,
      maxDailyMovePct: DEFAULT_DAILY_MOVE_PCT,
      concentrationFactor: 2,
      inRangeFraction: 0.85,
    },
    exit: {
      stopLossPct: config.stopLossPct,
      trailingStopPct: config.trailingStopPct,
      confirmCycles: Math.max(1, config.trailingStopConfirmCycles),
      feeIlExitFloor: 0.5,
      tvlDropExitPct: config.tvlDropExitPct,
      oorDriftPct: 60,
      oorGraceCycles: config.oorGracePeriodCycles,
      maxVolatilityStddev: config.volatilityExitStddev,
      maxPositionAgeMs: config.maxPositionAgeMs ?? 0,
    },
    portfolio: {
      maxOpenPositions: config.maxOpenPositions,
      maxPositionsPerPool: config.maxPositionsPerPool,
      maxPerPoolAllocationPct: config.maxPerPoolAllocationPct,
      maxDailyDrawdownPct: config.maxDailyDrawdownPct,
    },
    profiles: DEFAULT_PROFILES,
  };
}

export const DEFAULT_PROFILES: Readonly<Record<Regime, RegimeProfile>> = {
  // Quiet, mean-reverting book: the conditions LP fees are paid for.
  calm: {
    entriesEnabled: true,
    minEvMultiplier: 0.8,
    entrySizeMultiplier: 1,
    stopLossMultiplier: 1,
    driftMultiplier: 1,
    horizonMultiplier: 1,
  },
  // Directional move: a range position bleeds IL, so demand a bigger edge.
  trending: {
    entriesEnabled: true,
    minEvMultiplier: 2,
    entrySizeMultiplier: 0.5,
    stopLossMultiplier: 0.6,
    driftMultiplier: 0.7,
    horizonMultiplier: 0.5,
  },
  // High σ chop: entries are usually a donation; hold the book steady.
  volatile: {
    entriesEnabled: false,
    minEvMultiplier: 4,
    entrySizeMultiplier: 0,
    stopLossMultiplier: 0.5,
    driftMultiplier: 0.5,
    horizonMultiplier: 0.5,
  },
  // Degraded pool (TVL flight, failed authenticity): capital protection only.
  degraded: {
    entriesEnabled: false,
    minEvMultiplier: 10,
    entrySizeMultiplier: 0,
    stopLossMultiplier: 0.4,
    driftMultiplier: 0.4,
    horizonMultiplier: 0.25,
  },
};

/**
 * Resolve the effective (regime-adjusted) policy. The returned object is a
 * plain DecisionPolicy with scaled thresholds, so rules never branch on the
 * regime themselves — one place owns the adaptation.
 */
export function resolveEffectivePolicy(policy: DecisionPolicy, regime: Regime): DecisionPolicy {
  const profile = policy.profiles[regime];
  if (profile === undefined) return policy;
  return {
    ...policy,
    entry: {
      ...policy.entry,
      enabled: policy.entry.enabled && profile.entriesEnabled,
      horizonDays: Math.max(0.25, policy.entry.horizonDays * profile.horizonMultiplier),
      minEvUsd: policy.entry.minEvUsd * profile.minEvMultiplier,
      maxDailyMovePct: policy.entry.maxDailyMovePct,
    },
    exit: {
      ...policy.exit,
      stopLossPct: policy.exit.stopLossPct * profile.stopLossMultiplier,
      oorDriftPct: policy.exit.oorDriftPct * profile.driftMultiplier,
    },
  };
}
