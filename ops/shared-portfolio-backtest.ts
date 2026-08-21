/**
 * A deterministic, mark-to-market simulator for several pools sharing one
 * wallet. This is deliberately independent of the live execution engine.
 */

export interface SharedPortfolioConfig {
  readonly initialCapitalUsd: number;
  readonly maxConcurrentPositions: number;
  readonly maxTotalDeployedUsd: number;
  readonly maxAllocationPerPoolUsd: number;
}

export interface EntryRequestEvent {
  readonly type: "entry-request";
  readonly timestamp: number;
  readonly pool: string;
  readonly amountUsd: number;
}

export interface MarkEvent {
  readonly type: "mark";
  readonly timestamp: number;
  readonly pool: string;
  readonly valueUsd: number;
}

export interface ExitEvent {
  readonly type: "exit";
  readonly timestamp: number;
  readonly pool: string;
  readonly valueUsd: number;
}

/** Positive amounts are fees/rebates; negative amounts are costs. */
export interface FeeEvent {
  readonly type: "fee";
  readonly timestamp: number;
  readonly pool: string;
  readonly amountUsd: number;
}

export type SharedPortfolioEvent = EntryRequestEvent | MarkEvent | ExitEvent | FeeEvent;

export interface PoolExposureConcentration {
  readonly peakDeployedUsd: number;
  /** The pool's largest share of deployed capital at any observed mark. */
  readonly peakShareOfDeployed: number;
}

export interface SharedPortfolioBacktestResult {
  readonly finalEquityUsd: number;
  readonly netPnlUsd: number;
  readonly maxDrawdownUsd: number;
  readonly maxDrawdownPct: number;
  readonly rejectedEntries: number;
  readonly perPoolExposureConcentration: Readonly<Record<string, PoolExposureConcentration>>;
}

interface Position {
  readonly depositedUsd: number;
  markedValueUsd: number;
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
}

function validateConfig(config: SharedPortfolioConfig): void {
  assertFiniteNonNegative("initialCapitalUsd", config.initialCapitalUsd);
  assertFiniteNonNegative("maxTotalDeployedUsd", config.maxTotalDeployedUsd);
  assertFiniteNonNegative("maxAllocationPerPoolUsd", config.maxAllocationPerPoolUsd);
  if (!Number.isInteger(config.maxConcurrentPositions) || config.maxConcurrentPositions < 0) {
    throw new Error("maxConcurrentPositions must be a non-negative integer");
  }
}

function validateEvent(event: SharedPortfolioEvent): void {
  if (!Number.isFinite(event.timestamp)) throw new Error("event timestamp must be finite");
  if (event.pool.length === 0) throw new Error("event pool must not be empty");
  const amount =
    event.type === "fee"
      ? event.amountUsd
      : event.type === "entry-request"
        ? event.amountUsd
        : event.valueUsd;
  if (!Number.isFinite(amount) || (event.type !== "fee" && amount < 0)) {
    throw new Error(`${event.type} amount must be a finite non-negative number`);
  }
}

export function simulateSharedPortfolio(
  events: readonly SharedPortfolioEvent[],
  config: SharedPortfolioConfig,
): SharedPortfolioBacktestResult {
  validateConfig(config);

  const positions = new Map<string, Position>();
  const exposures = new Map<string, { peakDeployedUsd: number; peakShareOfDeployed: number }>();
  let cashUsd = config.initialCapitalUsd;
  let deployedUsd = 0;
  let peakEquityUsd = config.initialCapitalUsd;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let rejectedEntries = 0;
  let previousTimestamp = -Infinity;

  const observe = (): void => {
    const equityUsd =
      cashUsd + [...positions.values()].reduce((sum, position) => sum + position.markedValueUsd, 0);
    if (equityUsd > peakEquityUsd) peakEquityUsd = equityUsd;
    const drawdownUsd = peakEquityUsd - equityUsd;
    if (drawdownUsd > maxDrawdownUsd) {
      maxDrawdownUsd = drawdownUsd;
      maxDrawdownPct = peakEquityUsd > 0 ? drawdownUsd / peakEquityUsd : 0;
    }
    for (const [pool, position] of positions) {
      const exposure = exposures.get(pool) ?? { peakDeployedUsd: 0, peakShareOfDeployed: 0 };
      exposure.peakDeployedUsd = Math.max(exposure.peakDeployedUsd, position.depositedUsd);
      exposure.peakShareOfDeployed = Math.max(
        exposure.peakShareOfDeployed,
        deployedUsd > 0 ? position.depositedUsd / deployedUsd : 0,
      );
      exposures.set(pool, exposure);
    }
  };

  for (const event of events) {
    validateEvent(event);
    if (event.timestamp < previousTimestamp)
      throw new Error("events must be chronologically ordered");
    previousTimestamp = event.timestamp;

    if (event.type === "entry-request") {
      const canEnter =
        !positions.has(event.pool) &&
        positions.size < config.maxConcurrentPositions &&
        event.amountUsd <= cashUsd &&
        deployedUsd + event.amountUsd <= config.maxTotalDeployedUsd &&
        event.amountUsd <= config.maxAllocationPerPoolUsd;
      if (!canEnter) {
        rejectedEntries++;
      } else {
        cashUsd -= event.amountUsd;
        deployedUsd += event.amountUsd;
        positions.set(event.pool, {
          depositedUsd: event.amountUsd,
          markedValueUsd: event.amountUsd,
        });
        if (!exposures.has(event.pool))
          exposures.set(event.pool, { peakDeployedUsd: 0, peakShareOfDeployed: 0 });
      }
    } else if (event.type === "mark") {
      const position = positions.get(event.pool);
      if (!position) throw new Error(`cannot mark pool without an open position: ${event.pool}`);
      position.markedValueUsd = event.valueUsd;
    } else if (event.type === "exit") {
      const position = positions.get(event.pool);
      if (!position) throw new Error(`cannot exit pool without an open position: ${event.pool}`);
      cashUsd += event.valueUsd;
      deployedUsd -= position.depositedUsd;
      positions.delete(event.pool);
    } else {
      cashUsd += event.amountUsd;
    }
    observe();
  }

  const finalEquityUsd =
    cashUsd + [...positions.values()].reduce((sum, position) => sum + position.markedValueUsd, 0);
  const concentration: Record<string, PoolExposureConcentration> = {};
  for (const [pool, exposure] of exposures) concentration[pool] = exposure;
  return {
    finalEquityUsd,
    netPnlUsd: finalEquityUsd - config.initialCapitalUsd,
    maxDrawdownUsd,
    maxDrawdownPct,
    rejectedEntries,
    perPoolExposureConcentration: concentration,
  };
}
