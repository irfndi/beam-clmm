// Fee-persistence check (Fee-Truth spec, rule 2): fees are only "real" when
// they recur across several days — a one-off spike must not be mistaken for
// a persistent income stream. Pure and deterministic.
//
// "Non-zero days" means strictly positive finite USD values; null, NaN,
// zero, and negative entries never count as evidence of persistence
// (negatives are losses/corrections, not fee days). The spike ratio is
// max/median over the positive days only.

export interface FeePersistenceOptions {
  readonly windowDays?: number;
  readonly minPositiveDays?: number;
  readonly maxSpikeRatio?: number;
}

export interface FeePersistenceDecision {
  readonly persistent: boolean;
  readonly reason: string;
}

/**
 * Decide whether a fee series looks persistent.
 *
 * Persistent only when BOTH hold, over the LAST `windowDays` entries:
 *   count(positive days) >= minPositiveDays
 *   max(positive days) / median(positive days) <= maxSpikeRatio
 *
 * Malformed config (non-finite / out-of-range thresholds) fails closed.
 */
export function feePersistence(
  dailyFeesUsd: readonly (number | null)[],
  options: FeePersistenceOptions = {},
): FeePersistenceDecision {
  const windowDays = options.windowDays ?? 7;
  const minPositiveDays = options.minPositiveDays ?? 4;
  const maxSpikeRatio = options.maxSpikeRatio ?? 3;

  if (!Number.isFinite(windowDays) || windowDays < 1) {
    return { persistent: false, reason: `invalid windowDays: ${String(windowDays)}` };
  }
  if (!Number.isFinite(minPositiveDays) || minPositiveDays < 1) {
    return {
      persistent: false,
      reason: `invalid minPositiveDays: ${String(minPositiveDays)}`,
    };
  }
  if (!Number.isFinite(maxSpikeRatio) || maxSpikeRatio <= 0) {
    return {
      persistent: false,
      reason: `invalid maxSpikeRatio: ${String(maxSpikeRatio)}`,
    };
  }

  const window = dailyFeesUsd.slice(-windowDays);
  const positives = window.filter(
    (value): value is number => value !== null && Number.isFinite(value) && value > 0,
  );

  if (positives.length < minPositiveDays) {
    return {
      persistent: false,
      reason: `only ${positives.length} positive fee days in ${windowDays}-day window (need ${minPositiveDays})`,
    };
  }

  const sorted = [...positives].sort((a, b) => a - b);
  const median = medianOfSorted(sorted);
  const max = sorted[sorted.length - 1]!;
  const spikeRatio = max / median;

  if (spikeRatio > maxSpikeRatio) {
    return {
      persistent: false,
      reason: `max/median fee ratio ${spikeRatio.toFixed(2)} exceeds ${maxSpikeRatio}`,
    };
  }

  return {
    persistent: true,
    reason: `${positives.length} positive days, max/median ratio ${spikeRatio.toFixed(2)} <= ${maxSpikeRatio}`,
  };
}

function medianOfSorted(sortedAsc: number[]): number {
  const mid = Math.floor(sortedAsc.length / 2);
  if (sortedAsc.length % 2 === 1) return sortedAsc[mid]!;
  return (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
}
