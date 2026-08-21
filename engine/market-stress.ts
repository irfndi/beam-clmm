/**
 * Market-stress monitor (logging-only) — ORCA-inspired, adapted to our
 * constraints. The paper's core finding: systemic stress shows up as
 * correlation-spectrum compression (assets moving in lockstep) BEFORE
 * per-asset volatility gates fire. Full ORCA (127 spectral features, RF,
 * 15y walk-forward) does not transplant — we have weeks of data on ~noisy
 * meme pools — but the narrow version is cheap and testable: mean pairwise
 * correlation of hourly returns across our most-snapshotted pools, z-scored
 * against its own trailing history. Pure local math over pool_snapshots;
 * zero RPC cost.
 *
 * Logging-only by design: before this becomes a gate, its value must be
 * checked at the timestamps of past blowups (STACK/USDG-type events). If it
 * visibly spiked beforehand, promote with data behind it; if not, delete it.
 */

export interface StressAssessment {
  /** Mean pairwise Pearson correlation across the universe's hourly returns,
   *  in [-1, 1]. null when fewer than 3 pools have usable overlap. */
  readonly meanCorrelation: number | null;
  /** Z-score of meanCorrelation vs the trailing baseline window. null when
   *  the baseline has too few assessments (< 8). */
  readonly zScore: number | null;
  readonly poolCount: number;
  readonly sampleCount: number;
}

/** Minimum pools with sufficient overlapping samples for a stable estimate. */
const MIN_POOLS = 3;
/** Minimum aligned hourly samples per pool within the assessment window. */
const MIN_SAMPLES_PER_POOL = 12;
/** Minimum trailing assessments before a z-score is meaningful. */
const MIN_BASELINE = 8;

/**
 * Align each pool's snapshot prices onto a common hourly grid (last price at
 * or before each grid point), compute hourly log returns, then the mean
 * pairwise Pearson correlation across pools. Hourly alignment matters:
 * snapshots arrive at irregular per-pool cadences and raw-timestamp pairing
 * would correlate sampling noise instead of prices.
 */
export function assessMarketStress(
  seriesByPool: ReadonlyMap<string, ReadonlyArray<{ timestamp: number; price: number }>>,
  nowMs: number,
  windowHours: number,
): StressAssessment {
  const gridStart = nowMs - windowHours * 3_600_000;
  const returnsByPool = new Map<string, number[]>();
  for (const [pool, snaps] of seriesByPool) {
    // Sort + dedupe guard (snapshots are unique per (pool, ts) but be safe).
    const sorted = [...snaps].sort((a, b) => a.timestamp - b.timestamp);
    const prices: number[] = [];
    for (let t = gridStart; t <= nowMs; t += 3_600_000) {
      let last: number | null = null;
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i]!.timestamp <= t && sorted[i]!.price > 0) {
          last = sorted[i]!.price;
          break;
        }
      }
      if (last !== null) prices.push(last);
    }
    if (prices.length < MIN_SAMPLES_PER_POOL + 1) continue;
    const rets: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      rets.push(Math.log(prices[i]! / prices[i - 1]!));
    }
    if (rets.length >= MIN_SAMPLES_PER_POOL) {
      returnsByPool.set(pool, rets);
    }
  }
  if (returnsByPool.size < MIN_POOLS) {
    return { meanCorrelation: null, zScore: null, poolCount: returnsByPool.size, sampleCount: 0 };
  }

  // Pools may cover different sub-spans of the grid; align on the intersection
  // by trimming every series to the shortest common length from the END (the
  // most recent hours are what stress detection cares about).
  const minLength = Math.min(...[...returnsByPool.values()].map((r) => r.length));
  const aligned = [...returnsByPool.values()].map((r) => r.slice(r.length - minLength));

  const n = aligned.length;
  const means = aligned.map((r) => r.reduce((s, v) => s + v, 0) / r.length);
  const stds = aligned.map((r, i) => {
    let acc = 0;
    for (let k = 0; k < r.length; k++) acc += (r[k]! - means[i]!) ** 2;
    return Math.sqrt(acc / r.length);
  });
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const si = stds[i]!;
      const sj = stds[j]!;
      if (si <= 0 || sj <= 0) continue; // flat series carry no correlation info
      let cov = 0;
      for (let k = 0; k < minLength; k++) {
        cov += (aligned[i]![k]! - means[i]!) * (aligned[j]![k]! - means[j]!);
      }
      sum += cov / (minLength * si * sj);
      pairs++;
    }
  }
  if (pairs === 0) {
    return { meanCorrelation: null, zScore: null, poolCount: n, sampleCount: 0 };
  }
  return {
    meanCorrelation: sum / pairs,
    zScore: null, // filled by assessStressZScore against trailing history
    poolCount: n,
    sampleCount: minLength,
  };
}

/**
 * Z-score the current mean correlation against a trailing baseline of prior
 * assessments (oldest first). Returns null until MIN_BASELINE assessments
 * exist — early cycles report the level only.
 */
export function assessStressZScore(
  current: number,
  baseline: ReadonlyArray<number>,
): number | null {
  if (baseline.length < MIN_BASELINE) return null;
  const mean = baseline.reduce((s, v) => s + v, 0) / baseline.length;
  let acc = 0;
  for (const v of baseline) acc += (v - mean) ** 2;
  const std = Math.sqrt(acc / baseline.length);
  if (std <= 1e-12) return null;
  return (current - mean) / std;
}
