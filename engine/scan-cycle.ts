/**
 * One scan cycle: settlement/wallet hydration, pool scans, redeploy/decay,
 * pruning and reporting. Extracted from program.ts so the sequence is readable
 * in one place; the engine's mutable state and per-pool decision logic stay in
 * program.ts and are supplied through the callbacks below.
 */
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config-service.js";
import type { PositionRecord } from "./db-service.js";
import type { AdapterApi, DbApi } from "./services.js";
import type { AgentCycle, BinArray, PoolMetrics, PoolState } from "./types.js";
import { decayExecutionFailureCounter } from "./autonomous-runtime.js";

/** Qualified-but-unconsumed ENTER candidate for the idle-redeploy pass. */
export interface IdleRedeployCandidate {
  readonly poolAddress: string;
  readonly pool: PoolState;
  readonly metrics: PoolMetrics;
  readonly entryScore: number;
  readonly feeIlRatio: number;
  /**
   * The size the normal conservative path chose (or proposed) for this pool.
   * Mutable on purpose: when the normal ENTER for the pool actually executes,
   * the in-slot tail overwrites this with the FINAL executed size
   * (post-overlay, post-risk-adjustment) so the widened-size guard compares
   * against the position really opened, not a stale pre-overlay figure.
   */
  normalEntrySizeUsd: number;
  readonly volatilityStddev: number;
  readonly netDriftBins: number;
}

export interface ScanCycleDeps {
  readonly config: AppConfig;
  readonly db: DbApi;
  readonly adapter: AdapterApi;

  readonly getScanCount: () => number;
  readonly getPoolsToScan: () => ReadonlyArray<string>;

  readonly resetCoreDataFailures: () => void;
  readonly setClosedPositions: (positions: ReadonlyArray<PositionRecord>) => void;
  readonly resetPositionValues: () => void;
  readonly resetExecutionFailures: () => void;
  readonly getConsecutiveExecutionFailures: () => number;
  readonly setConsecutiveExecutionFailures: (value: number) => void;

  readonly refreshAutonomousCandidates: (scanOrdinal: number) => Effect.Effect<void, never, never>;
  readonly refreshFallenAngelCandidates: (scanOrdinal: number) => Effect.Effect<void, never, never>;
  readonly refreshHarvestBook: () => Effect.Effect<void, never, never>;
  readonly refreshMarketUniverse: (now: number) => Effect.Effect<void, never, never>;
  readonly rebuildPoolsToScan: () => void;
  readonly processSettlementPhase: () => Effect.Effect<number, never, never>;
  readonly resolveCycleExecutionFailuresPause: () => Effect.Effect<void, never, never>;
  readonly refreshCycleWallet: () => Effect.Effect<void, never, never>;
  readonly hydrateChallengePeak: () => Effect.Effect<void, never, never>;
  readonly hydrateChallengeCooldowns: () => Effect.Effect<void, never, never>;
  readonly hydrateChallengeFirstSeen: () => Effect.Effect<void, never, never>;
  readonly hydrateChallengeRotations: () => Effect.Effect<void, never, never>;
  readonly refreshCycleSolBudget: () => Effect.Effect<void, never, never>;
  readonly logWalletComposition: () => Effect.Effect<void, never, never>;

  readonly runPoolScanLoop: (
    cycle: AgentCycle,
    idleRedeployCandidates: IdleRedeployCandidate[],
    executedExitPools: Set<string>,
    getPrefetched: (poolAddress: string) => { state: PoolState; bins: BinArray | null } | undefined,
  ) => Effect.Effect<void, never, never>;
  readonly runRedeployAndDecay: (
    cycle: AgentCycle,
    idleRedeployCandidates: IdleRedeployCandidate[],
    executedExitPools: Set<string>,
    oldestSettlementAgeMs: number,
  ) => Effect.Effect<void, never, never>;
  readonly pruneAndReportCycle: (cycle: AgentCycle) => Effect.Effect<void, never, never>;
}

export interface ScanCycle {
  readonly runScanCycle: () => Effect.Effect<void, never, never>;
}

export function createScanCycle(deps: ScanCycleDeps): ScanCycle {
  const runScanCycle = (): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      deps.resetCoreDataFailures();
      const cycle: AgentCycle = {
        cycleId: randomUUID(),
        startedAt: Date.now(),
        poolsScanned: 0,
        poolsDecided: 0,
        poolsExecuted: 0,
        poolsFailed: 0,
        decisions: [],
        totalGasCostSol: 0,
        paperTrading: deps.config.paperTrading,
      };

      console.info("Scan cycle started", { cycleId: cycle.cycleId });

      deps.setClosedPositions(
        yield* deps.db
          .getClosedPositions()
          .pipe(Effect.orElseSucceed((): ReadonlyArray<PositionRecord> => [])),
      );
      deps.resetPositionValues();

      yield* deps.refreshAutonomousCandidates(deps.getScanCount());
      yield* deps.refreshFallenAngelCandidates(deps.getScanCount());
      yield* deps.refreshHarvestBook();
      yield* deps.refreshMarketUniverse(Date.now());
      // The universe refresh may have rebuilt the market top-K — make the
      // fresh active set visible to the "no pools" check and the scan loop.
      deps.rebuildPoolsToScan();
      const oldestSettlementAgeMs = yield* deps.processSettlementPhase();

      // Issue #182: an armed execution_failures pause must not outlive the
      // failure spike that raised it. Runs at the TOP of the cycle, before any
      // pool is decided — a resolved latch must not block the very cycle that
      // clears it. The counter is decayed to 0 after every quiet cycle (see the
      // end-of-cycle decay below), so "below the threshold" is the recovery
      // signal for restarts AND mid-run spikes; the end-of-cycle arm block
      // re-arms only when a cycle genuinely breaches again. `beam resume`
      // remains an operator override.
      yield* deps.resolveCycleExecutionFailuresPause();

      if (deps.getPoolsToScan().length === 0) {
        console.info("No pools configured — skipping cycle");
        // Issue #182: a skipped cycle is a quiet cycle — no execution failure
        // was possible, so the consecutive counter decays like any other quiet
        // cycle (otherwise recovery lags behind skipped cycles).
        deps.resetExecutionFailures();
        deps.setConsecutiveExecutionFailures(
          decayExecutionFailureCounter(deps.getConsecutiveExecutionFailures(), 0),
        );
        cycle.completedAt = Date.now();
        return;
      }

      yield* deps.refreshCycleWallet();
      yield* deps.hydrateChallengePeak();
      yield* deps.hydrateChallengeCooldowns();
      yield* deps.hydrateChallengeFirstSeen();
      yield* deps.hydrateChallengeRotations();
      // Issue #170: batch wallet-reserve gate — refresh the per-cycle native
      // budget for SOL-funded entries. One read, reused by every ENTER gate
      // this cycle; a failed read leaves the budget UNKNOWN and the gate skips
      // entries fail-closed (never commit SOL the engine cannot confirm). The
      // USD→lamports estimate keys off the LIVE NATIVE price read fresh every
      // cycle (the static NATIVE_PRICE_USD config was a Solana-era $150
      // fallback that floored the real ~$1880 ETH price and over-reserved every
      // entry ~12x, silently skipping all live ENTERs on a small wallet).
      yield* deps.refreshCycleSolBudget();
      yield* deps.logWalletComposition();

      const idleRedeployCandidates: IdleRedeployCandidate[] = [];
      const executedExitPools = new Set<string>();
      // Reset AFTER the issue #182 resolve block above: the resolver reads the
      // PREVIOUS cycle's failure count, and this cycle's failures start
      // counting from here (the pool loop records them).
      deps.resetExecutionFailures();

      // One batched state+bins read for the whole scan (when the adapter
      // exposes it): per-pool getPoolState+getBinArray cost 3-6 round trips
      // each with duplicate slot0/tickSpacing reads; the batched path is ~2 per
      // pool total. Pools missing from the map fall back to the sequential
      // per-pool read inside evaluatePool.
      const prefetched =
        deps.adapter.getPoolStatesWithBins !== undefined
          ? yield* deps.adapter
              .getPoolStatesWithBins([...deps.getPoolsToScan()])
              .pipe(Effect.orElseSucceed(() => null))
          : null;
      const getPrefetched = (poolAddress: string) => prefetched?.get(poolAddress.toLowerCase());

      yield* deps.runPoolScanLoop(cycle, idleRedeployCandidates, executedExitPools, getPrefetched);
      yield* deps.runRedeployAndDecay(
        cycle,
        idleRedeployCandidates,
        executedExitPools,
        oldestSettlementAgeMs,
      );
      yield* deps.pruneAndReportCycle(cycle);
    });

  return { runScanCycle };
}
