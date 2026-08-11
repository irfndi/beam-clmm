// Harvest decision gate (Fee-Truth spec, rule 10):
// "do not spend $0.80 to realize $1.00" — harvest only when the fees are
// worth realizing and the gas cost is a small fraction of them.
// Pure and deterministic; every malformed input fails closed (no harvest).

export interface HarvestGateOptions {
  readonly minNetUsd?: number;
  readonly maxGasPct?: number;
}

export interface HarvestDecision {
  readonly harvest: boolean;
  readonly reason: string;
}

/**
 * Decide whether to broadcast a claimFees transaction.
 *
 * Harvests only when BOTH hold:
 *   feesUsd >= minNetUsd          (fees are worth realizing)
 *   estGasCostUsd <= maxGasPct * feesUsd  (gas is a small slice of fees)
 *
 * Any NaN/negative/infinite input fails closed with a descriptive reason.
 * Boundary behavior: equality on either comparison harvests.
 */
export function shouldHarvest(
  feesUsd: number,
  estGasCostUsd: number,
  options: HarvestGateOptions = {},
): HarvestDecision {
  const minNetUsd = options.minNetUsd ?? 1;
  const maxGasPct = options.maxGasPct ?? 0.15;

  if (!Number.isFinite(feesUsd) || feesUsd < 0) {
    return { harvest: false, reason: `invalid feesUsd: ${String(feesUsd)}` };
  }
  if (!Number.isFinite(estGasCostUsd) || estGasCostUsd < 0) {
    return {
      harvest: false,
      reason: `invalid estGasCostUsd: ${String(estGasCostUsd)}`,
    };
  }
  if (!Number.isFinite(minNetUsd) || minNetUsd < 0) {
    return { harvest: false, reason: `invalid minNetUsd: ${String(minNetUsd)}` };
  }
  if (!Number.isFinite(maxGasPct) || maxGasPct < 0) {
    return { harvest: false, reason: `invalid maxGasPct: ${String(maxGasPct)}` };
  }

  if (feesUsd < minNetUsd) {
    return {
      harvest: false,
      reason: `fees ${feesUsd} below minNetUsd ${minNetUsd}`,
    };
  }

  const gasCeilingUsd = feesUsd * maxGasPct;
  if (estGasCostUsd > gasCeilingUsd) {
    return {
      harvest: false,
      reason: `gas ${estGasCostUsd} exceeds ${maxGasPct * 100}% of fees (${gasCeilingUsd})`,
    };
  }

  return {
    harvest: true,
    reason: `fees ${feesUsd} >= ${minNetUsd} and gas ${estGasCostUsd} <= ${maxGasPct * 100}% of fees`,
  };
}
