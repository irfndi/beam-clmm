/**
 * rotation-controller.ts — Fee-Truth Two-Seat rotation decisions.
 *
 * PURE portfolio-level decision module: no network I/O, no Effect, no logging.
 * Everything here is deterministic; the caller (program/strategy wiring) maps
 * live pool data into `Seat`/`Challenger` and applies the returned decision.
 *
 * Decision rules encoded:
 * - rule 7  — incumbents keep the switching advantage: rotation only fires when
 *             the challenger clears every superiority gate (relative net-fee
 *             velocity, APR lead, fee-density lead), not merely when it is
 *             "bigger".
 * - rule 8  — seat impairment: hold short excursions while re-entry is
 *             plausible and no superior replacement exists; rerange when the
 *             forgone-fee opportunity cost beats the intervention cost; exit
 *             only when impaired AND a superior challenger is available.
 * - rule 9  — replacement only after the challenger is fully admissible
 *             (`Challenger.admissible` plus the config floor); confirmations
 *             are consecutive observations via `observeRotationPair`.
 */

export interface RotationConfig {
  /** Relative net-fee-velocity superiority required to rotate. Default 25. */
  readonly minSuperiorityPct?: number;
  /** Absolute APR lead (percentage points) required to rotate. Default 20. */
  readonly minAprLeadPct?: number;
  /** Relative fee-density lead required to rotate. Default 15. */
  readonly minFeeDensityLeadPct?: number;
  /** Consecutive superior observations required. Default 2. */
  readonly requiredConfirmations?: number;
  /** Floor on a challenger's net fee velocity (USD/day). Required. */
  readonly minChallengerNetFeesUsdPerDay: number;
  /** All-in cost of switching seats (USD). Required; gates the exit action. */
  readonly switchingCostUsd: number;
}

export type ResolvedRotationConfig = Required<RotationConfig>;

const DEFAULT_THRESHOLDS = {
  minSuperiorityPct: 25,
  minAprLeadPct: 20,
  minFeeDensityLeadPct: 15,
  requiredConfirmations: 2,
} as const;

/** An occupied seat: the incumbent position in a pool. */
export interface Seat {
  readonly pool: string;
  /** Annualized yield, percent (e.g. 25 = 25%). */
  readonly apr: number;
  /** Relative fee density (fees per unit of pool TVL), arbitrary scale. */
  readonly feeDensity: number;
  /** Gross fees collected over the last 24h, USD. */
  readonly fees24hUsd: number;
  /** 0..1 share of pool fees attributable to this seat. */
  readonly positionShare: number;
  /** 0..100 share of time the position is expected to be in range. */
  readonly expectedInRangePct: number;
  /** Operating costs, USD/day. */
  readonly costsPerDayUsd: number;
}

/** A candidate seat. Fully admissible (rule 9) before it may replace a seat. */
export interface Challenger extends Seat {
  /** True when every admission check (route proof, liquidity, policy) passed. */
  readonly admissible: boolean;
}

export type RotationDecision =
  | { readonly action: "rotate"; readonly exitPool: string; readonly enterPool: string; readonly reason: string }
  | { readonly action: "hold"; readonly reason: string };

/** Canonical confirmations-map key for an exit->enter rotation pair. */
export function rotationPairKey(exitPool: string, enterPool: string): string {
  return `${exitPool}|${enterPool}`;
}

/** Net fee velocity: expected fees/day attributable to the seat minus costs. */
export function estimateNetFeeVelocityUsdPerDay(
  fees24hUsd: number,
  positionShare: number,
  expectedInRangePct: number,
  costsPerDay: number,
): number {
  return fees24hUsd * positionShare * (expectedInRangePct / 100) - costsPerDay;
}

/** All-in cost of switching from one seat to another, USD. */
export function switchingCostUsd(
  withdrawGas: number,
  swapGas: number,
  entryGas: number,
  swapFees: number,
  slippage: number,
): number {
  return withdrawGas + swapGas + entryGas + swapFees + slippage;
}

/**
 * Record one observation of a rotation pair.
 *
 * Pure: returns a NEW map, never mutates `confirmations`. A `superior`
 * observation increments the pair's counter (capped at `required`, so a
 * confirmed pair stays confirmed); a not-superior observation resets it to 0 —
 * confirmations mean CONSECUTIVE observations.
 */
export function observeRotationPair(
  exitPool: string,
  enterPool: string,
  superior: boolean,
  confirmations: ReadonlyMap<string, number>,
  required: number,
): Map<string, number> {
  const next = new Map(confirmations);
  const key = rotationPairKey(exitPool, enterPool);
  if (superior) {
    // ponytail: cap at max(required,1) — the counter carries no information
    // beyond `required`, and this keeps required=0 (rotate immediately) sane.
    const cap = Math.max(required, 1);
    next.set(key, Math.min((next.get(key) ?? 0) + 1, cap));
  } else {
    next.set(key, 0);
  }
  return next;
}

interface Candidate {
  readonly seat: Seat;
  readonly challenger: Challenger;
  readonly incumbentNet: number;
  readonly challengerNet: number;
  readonly margin: number;
  readonly key: string;
}

function* candidatePairs(seats: readonly Seat[], challengers: readonly Challenger[]): Generator<Candidate> {
  for (const seat of seats) {
    const incumbentNet = estimateNetFeeVelocityUsdPerDay(
      seat.fees24hUsd,
      seat.positionShare,
      seat.expectedInRangePct,
      seat.costsPerDayUsd,
    );
    for (const challenger of challengers) {
      if (challenger.pool === seat.pool) continue; // cannot rotate to the same pool
      const challengerNet = estimateNetFeeVelocityUsdPerDay(
        challenger.fees24hUsd,
        challenger.positionShare,
        challenger.expectedInRangePct,
        challenger.costsPerDayUsd,
      );
      yield {
        seat,
        challenger,
        incumbentNet,
        challengerNet,
        margin: challengerNet - incumbentNet,
        key: rotationPairKey(seat.pool, challenger.pool),
      };
    }
  }
}

function betterCandidate(a: Candidate, b: Candidate): Candidate {
  // Deterministic tie-breaks: net-velocity margin, then APR lead, then pair key.
  if (b.margin !== a.margin) return b.margin > a.margin ? b : a;
  if (b.challenger.apr !== a.challenger.apr) return b.challenger.apr > a.challenger.apr ? b : a;
  return b.key > a.key ? b : a;
}

/**
 * Decide the single best rotation for the portfolio, or hold.
 *
 * Gates, in order (all must pass; the first failure of the best candidate is
 * reported verbatim in the hold reason):
 *  1. challenger is admissible (rule 9)
 *  2. challenger net fee velocity >= minChallengerNetFeesUsdPerDay
 *  3. challenger net fee velocity >= incumbent x (1 + minSuperiorityPct/100)
 *  4. challenger apr >= incumbent apr + minAprLeadPct
 *  5. challenger feeDensity >= incumbent feeDensity x (1 + minFeeDensityLeadPct/100)
 *  6. confirmations[key] >= requiredConfirmations (2-consecutive observations)
 *
 * If only gate 6 fails for the best fully-qualified candidate, hold reports the
 * confirmations shortfall (rule 9: replacement only once the challenger is
 * fully admissible — which here includes the observation streak). At most one
 * rotation per call: the pair with the largest net-velocity margin (tie-broken
 * by APR lead, then pair key) — the caller re-evaluates each cycle.
 */
export function evaluateRotation(
  seats: readonly Seat[],
  challengers: readonly Challenger[],
  cfg: RotationConfig,
  confirmations: ReadonlyMap<string, number>,
): RotationDecision {
  const c: ResolvedRotationConfig = { ...DEFAULT_THRESHOLDS, ...cfg };
  const candidates = [...candidatePairs(seats, challengers)];
  if (candidates.length === 0) {
    return { action: "hold", reason: "no rotation candidates (no seats or no challengers)" };
  }

  const fmt = (n: number): string => n.toFixed(2);

  // Fully admissible + superior (gates 1..5) — only the observation streak may be missing.
  const qualified = candidates.filter((cand) => {
    if (!cand.challenger.admissible) return false;
    if (cand.challengerNet < c.minChallengerNetFeesUsdPerDay) return false;
    if (cand.challengerNet < cand.incumbentNet * (1 + c.minSuperiorityPct / 100)) return false;
    if (cand.challenger.apr < cand.seat.apr + c.minAprLeadPct) return false;
    if (cand.challenger.feeDensity < cand.seat.feeDensity * (1 + c.minFeeDensityLeadPct / 100)) return false;
    return true;
  });

  if (qualified.length > 0) {
    const best = qualified.reduce((a, b) => betterCandidate(a, b));
    const got = confirmations.get(best.key) ?? 0;
    if (got >= c.requiredConfirmations) {
      return {
        action: "rotate",
        exitPool: best.seat.pool,
        enterPool: best.challenger.pool,
        reason:
          `challenger '${best.challenger.pool}' superior to '${best.seat.pool}' ` +
          `(net +$${fmt(best.margin)}/day, apr +${fmt(best.challenger.apr - best.seat.apr)}pp, ` +
          `fee density ${fmt((best.challenger.feeDensity / best.seat.feeDensity) * 100)}%, confirmed ${got}/${c.requiredConfirmations})`,
      };
    }
    // Rule 9: everything checks out except the consecutive-observation streak.
    return {
      action: "hold",
      reason: `insufficient confirmations for ${best.key} (${fmt(got)}/${c.requiredConfirmations})`,
    };
  }

  // No fully-qualified candidate: report the first failed gate of the nearest miss.
  const best = candidates.reduce((a, b) => betterCandidate(a, b));
  const { seat, challenger, incumbentNet, challengerNet } = best;
  const reason = (() => {
    if (!challenger.admissible) return `challenger '${challenger.pool}' not admissible`;
    if (challengerNet < c.minChallengerNetFeesUsdPerDay)
      return `challenger '${challenger.pool}' net fees $${fmt(challengerNet)}/day below $${fmt(c.minChallengerNetFeesUsdPerDay)}/day floor`;
    const superiorityNeed = incumbentNet * (1 + c.minSuperiorityPct / 100);
    if (challengerNet < superiorityNeed)
      return `challenger '${challenger.pool}' net fee velocity $${fmt(challengerNet)}/day below ` +
        `incumbent '${seat.pool}' x ${1 + c.minSuperiorityPct / 100} ($${fmt(superiorityNeed)}/day required)`;
    if (challenger.apr < seat.apr + c.minAprLeadPct)
      return `challenger '${challenger.pool}' apr ${fmt(challenger.apr)}% below incumbent '${seat.pool}' ${fmt(seat.apr)}% + ${c.minAprLeadPct}pp`;
    return `challenger '${challenger.pool}' fee density ${fmt(challenger.feeDensity)} below incumbent '${seat.pool}' x ${1 + c.minFeeDensityLeadPct / 100} (${fmt(seat.feeDensity * (1 + c.minFeeDensityLeadPct / 100))} required)`;
  })();
  return { action: "hold", reason };
}

// --- Rule 8: seat impairment ------------------------------------------------

/** Distance at/below which an excursion is "short" (percent of range). */
export const SHORT_EXCURSION_PCT = 25;
/** Re-entry within this many days makes an excursion "plausible". */
export const REENTRY_HORIZON_DAYS = 2;
/** Ceiling on the forgone-fee estimate (days) — beyond a week it is noise. */
export const OPPORTUNITY_HORIZON_DAYS = 7;

export interface ImpairmentAssessment {
  readonly impaired: boolean;
  readonly action: "hold" | "rerange" | "exit";
  readonly reason: string;
}

/**
 * Rule 8: assess whether an incumbent seat needs intervention.
 *
 * - hold   — price is within tolerance, or the excursion is short with
 *            plausible re-entry (rule 8 holds short excursions when no
 *            superior replacement is available), or the seat is impaired but
 *            no superior challenger exists and intervention is uneconomical
 *            (rule 7: incumbents keep the switching advantage).
 * - rerange — forgone-fee opportunity cost exceeds the intervention cost
 *            (rerange cost, offset by fees already accumulated since the last
 *            intervention).
 * - exit   — impaired AND `superiorChallengerAvailable` AND the switch pays
 *            for itself within the opportunity horizon. Defaults to false:
 *            fail closed — impairment alone never exits a seat.
 */
export function assessImpaired(
  seat: Seat,
  priceDistancePct: number,
  rerangeCostUsd: number,
  priceVelocityPctPerDay: number,
  accumulatedFeesUsd: number,
  cfg: RotationConfig,
  superiorChallengerAvailable = false,
): ImpairmentAssessment {
  const c: ResolvedRotationConfig = { ...DEFAULT_THRESHOLDS, ...cfg };
  const fmt = (n: number): string => n.toFixed(2);

  const shortExcursion = priceDistancePct <= SHORT_EXCURSION_PCT;
  const daysToReentry = priceVelocityPctPerDay > 0 ? priceDistancePct / priceVelocityPctPerDay : Infinity;
  const reentryPlausible = Number.isFinite(daysToReentry) && daysToReentry <= REENTRY_HORIZON_DAYS;
  const impaired = !shortExcursion && !reentryPlausible;

  // Forgone fees until the price returns (bounded so a stalled position does
  // not produce an unbounded estimate); accumulated fees pay for the fix.
  const daysOut = Number.isFinite(daysToReentry)
    ? Math.min(Math.max(daysToReentry, 1), OPPORTUNITY_HORIZON_DAYS)
    : OPPORTUNITY_HORIZON_DAYS;
  const opportunityCostUsd = seat.fees24hUsd * daysOut;
  const effectiveRerangeCostUsd = Math.max(0, rerangeCostUsd - accumulatedFeesUsd);

  if (!impaired) {
    return {
      impaired: false,
      action: "hold",
      reason: reentryPlausible
        ? `short excursion; re-entry plausible in ~${fmt(daysToReentry)} days`
        : `price within tolerance (${fmt(priceDistancePct)}% from range)`,
    };
  }
  if (superiorChallengerAvailable && opportunityCostUsd > c.switchingCostUsd) {
    return {
      impaired: true,
      action: "exit",
      reason:
        `impaired (${fmt(priceDistancePct)}% from range, re-entry not plausible); ` +
        `superior challenger available; switching pays for itself (forgone $${fmt(opportunityCostUsd)} > $${fmt(c.switchingCostUsd)})`,
    };
  }
  if (opportunityCostUsd > effectiveRerangeCostUsd) {
    return {
      impaired: true,
      action: "rerange",
      reason: `opportunity cost $${fmt(opportunityCostUsd)} exceeds rerange cost $${fmt(effectiveRerangeCostUsd)}`,
    };
  }
  return {
    impaired: true,
    action: "hold",
    reason:
      `impaired; intervention uneconomical (forgone $${fmt(opportunityCostUsd)} ` +
      `vs rerange $${fmt(effectiveRerangeCostUsd)})`,
  };
}
