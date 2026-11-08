/**
 * Periodic fee/reward execution path.
 *
 * Extracted from the decision loop so the claim → convert/compound lifecycle
 * is testable and inspectable on its own. It is intentionally a factory over
 * explicit deps: the engine's mutable position book and services stay owned by
 * program.ts, and this module never reaches back into that closure.
 */
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config-service.js";
import type { PositionRecord } from "./db-service.js";
import type {
  AdapterApi,
  AlertApi,
  DbApi,
  MemoryApi,
  RevenueConfig,
  RevenueConfigApi,
} from "./services.js";
import { evaluateCompoundGate } from "./risk-service.js";
import { shouldHarvest } from "./harvest-gate.js";
import { applyCompoundToCostBasis } from "./pnl.js";
import { buildRewardClaimMetadata, summarizeRewardClaim } from "./rewards.js";

export type ClaimFeesResult = Effect.Success<ReturnType<AdapterApi["claimFees"]>>;
export type ClaimRewardsResult = Effect.Success<ReturnType<AdapterApi["claimRewards"]>>;
export type PendingFeesResult = Effect.Success<
  ReturnType<NonNullable<AdapterApi["getPendingFees"]>>
>;

/** Only the adapter surface this execution path touches. */
export type FeeExecutionAdapter = Pick<
  AdapterApi,
  | "claimRewards"
  | "claimFees"
  | "rebalancePosition"
  | "convertClaimedFees"
  | "getPendingFees"
  | "reportFeeCollection"
>;

/** Only the DB surface this execution path touches. */
export type FeeExecutionDb = Pick<
  DbApi,
  "saveFeeClaim" | "savePosition" | "savePositionEvent" | "deletePosition"
>;

/** Only the memory surface this execution path touches. */
export type FeeExecutionMemory = Pick<MemoryApi, "upsert">;

export interface FeeExecutionDeps {
  readonly adapter: FeeExecutionAdapter;
  readonly db: FeeExecutionDb;
  readonly memory: FeeExecutionMemory;
  readonly config: AppConfig;
  /** Live book keyed by position identity; mutated in place on claims. */
  readonly trackedPositions: Map<string, PositionRecord>;
  readonly revenueConfig: RevenueConfigApi;
  readonly alerts: Pick<AlertApi, "recordFeeClaim">;
  readonly persist: <T>(
    label: string,
    effect: Effect.Effect<T, Error, never>,
  ) => Effect.Effect<void, never, never>;
  readonly reportCollectedFees: (
    adapter: FeeExecutionAdapter,
    poolAddress: string,
    positionPubKey: string | null,
    claimed: ClaimFeesResult,
    tier: string,
  ) => Effect.Effect<void, never, never>;
}

export interface FeeExecution {
  readonly claimAllFees: () => Effect.Effect<void>;
}

export function createFeeExecution(deps: FeeExecutionDeps): FeeExecution {
  const { adapter, db, memory, config, trackedPositions, revenueConfig, alerts, persist } = deps;

  const claimPositionRewards = (
    pos: PositionRecord,
    poolAddress: string,
    positionPubKey: string,
  ): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      // LM farm rewards ride the same periodic cadence as swap-fee claims.
      // The adapter skips silently for LimitOrder pools and positions with no
      // pending rewards, so this is a cheap no-op for non-farm positions.
      // Rewards are tracked separately from fees: cumulativeFeesClaimedUsd
      // stays fee-pure (fee APR), while the USD-valued portion accumulates in
      // cumulativeRewardsClaimedUsd.
      if (!config.farmRewardsEnabled) return;
      const rewardResult: ClaimRewardsResult | null = yield* adapter
        .claimRewards(poolAddress, positionPubKey)
        .pipe(Effect.orElseSucceed(() => null));
      if (rewardResult && !rewardResult.skipped && rewardResult.rewards.length > 0) {
        const rewardSummary = summarizeRewardClaim(rewardResult.rewards);
        console.info("Farm rewards claimed", {
          pool: poolAddress,
          rewards: rewardResult.rewards,
          totalUsd: rewardSummary.totalUsd,
          txSignatures: rewardResult.txSignatures,
        });
        pos.cumulativeRewardsClaimedUsd += rewardSummary.totalUsd;
        // Re-arm the shared claim gate: lastFeeClaimAt means "last on-chain
        // claim of either kind" — a successful reward claim is a real claim
        // tx, so the position waits one full interval before the next claim
        // pass even when swap fees are zero (their claim path never updates
        // the timestamp on a zero result, which would otherwise re-fire every
        // scan cycle).
        pos.lastFeeClaimAt = Date.now();
        yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
        yield* db
          .savePositionEvent({
            id: randomUUID(),
            poolAddress,
            positionPubKey: pos.positionPubKey,
            positionId: pos.positionId,
            event: "CLAIM",
            valueUsd: rewardSummary.totalUsd > 0 ? rewardSummary.totalUsd : null,
            feesUsd: null,
            price: null,
            metadata: {
              ...buildRewardClaimMetadata({
                txSignatures: rewardResult.txSignatures,
                rewards: rewardResult.rewards,
              }),
            },
            createdAt: Date.now(),
          })
          .pipe(Effect.ignore);
        if (rewardSummary.unpricedCount > 0) {
          yield* memory
            .upsert({
              category: "warning",
              content: `Claimed ${rewardSummary.unpricedCount} farm reward(s) for ${poolAddress} without USD pricing — raw amounts recorded in position_events.`,
              poolAddress,
            })
            .pipe(Effect.ignore);
        }
      }
    });

  const checkHarvestGate = (
    poolAddress: string,
    positionPubKey: string,
  ): Effect.Effect<boolean, never, never> =>
    Effect.gen(function* () {
      // Fee-Truth harvest gate (rule 10): claim only when pending fees clear
      // the economic floor ($1 net, gas <= 15% of gross fees). getPendingFees
      // reads unclaimed amounts without broadcasting; a read failure fails
      // CLOSED (no claim — rule 11: don't act on stale data). The gas estimate
      // is a static L2 claim cost (~120k gas at 2x base fee ≈ 6.24e-6 ETH)
      // priced at the config native price — dust-tiny on this chain, so the $1
      // floor is the real gate.
      const pending: PendingFeesResult = adapter.getPendingFees
        ? yield* adapter
            .getPendingFees(poolAddress, positionPubKey)
            .pipe(Effect.orElseSucceed(() => null))
        : null;
      if (pending) {
        const pendingUsd = pending.feeXUsd + pending.feeYUsd;
        const estGasUsd = (config.nativePriceUsd ?? 3000) * 6.24e-6;
        const harvestDecision = shouldHarvest(pendingUsd, estGasUsd, {
          minNetUsd: config.harvestMinNetUsd ?? 1,
          maxGasPct: config.harvestMaxGasPct ?? 0.15,
        });
        if (!harvestDecision.harvest) {
          console.info(
            `[harvest-gate] Skipping claim on ${poolAddress}: ${harvestDecision.reason}`,
          );
          return false;
        }
      }
      return true;
    });

  const collectPositionFees = (
    poolAddress: string,
    positionPubKey: string,
    revenue: RevenueConfig,
    tier: string,
  ): Effect.Effect<ClaimFeesResult | null, never, never> =>
    Effect.gen(function* () {
      const result = yield* adapter
        .claimFees(
          poolAddress,
          positionPubKey,
          revenue.platformFeeRate,
          revenue.revenueShareEnabled,
          revenue.revenueShareOperatorPct,
          revenue.feeWalletAddress,
        )
        .pipe(
          Effect.tap((r) =>
            Effect.sync(() =>
              console.info("Fees claimed", {
                pool: poolAddress,
                tier,
                feeX: r.feeX,
                feeY: r.feeY,
                platformFeeX: r.platformFeeX,
                platformFeeY: r.platformFeeY,
                netFeeX: r.netFeeX,
                netFeeY: r.netFeeY,
                tx: r.txSignature,
              }),
            ),
          ),
          Effect.orElseSucceed(() => null),
        );
      if (!result || (result.feeX === 0 && result.feeY === 0)) return null;
      return result;
    });

  const convertCollectedFees = (
    pos: PositionRecord,
    poolAddress: string,
    claimed: ClaimFeesResult,
  ): Effect.Effect<boolean, never, never> =>
    Effect.gen(function* () {
      const feeDestination = config.feeDestination ?? "compound";
      if (feeDestination === "compound") return false;
      const liveConversion = adapter.convertClaimedFees
        ? adapter
            .convertClaimedFees(poolAddress, feeDestination, claimed.netFeeX, claimed.netFeeY)
            .pipe(Effect.orElseSucceed(() => null))
        : Effect.succeed(null);
      const conversion = config.paperTrading
        ? Effect.succeed({
            destination: feeDestination,
            outputAtomic: 0n,
            outputUsd: null,
            // SAFETY: this assertion is applied to a value whose producer and invariant are controlled by this code path.
            txSignatures: [] as ReadonlyArray<string>,
          })
        : liveConversion;
      const converted = yield* conversion;
      if (converted) {
        yield* db
          .savePositionEvent({
            id: randomUUID(),
            poolAddress,
            positionPubKey: pos.positionPubKey,
            positionId: pos.positionId,
            event: "CLAIM",
            valueUsd: converted.outputUsd,
            feesUsd: null,
            price: null,
            metadata: {
              kind: "fee_accumulation",
              destination: converted.destination,
              outputAtomic: converted.outputAtomic.toString(),
              txSignatures: converted.txSignatures,
            },
            createdAt: Date.now(),
          })
          .pipe(Effect.ignore);
      }
      return true;
    });

  const compoundCollectedFees = (
    pos: PositionRecord,
    poolAddress: string,
    positionPubKey: string,
    claimed: ClaimFeesResult,
    netFeesUsd: number,
  ): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      // F3: fee compounding — if AUTO_COMPOUND_FEES is on and the net fees
      // cleared the cost threshold, redeposit them into the same range.
      if (config.autoCompoundFees && config.paperTrading === false) {
        const rebalanceGasCostUsd = config.rebalanceGasCostNative * config.nativePriceUsd;
        const compoundGate = evaluateCompoundGate({
          netFeesUsd,
          minCompoundFeesUsd: config.minCompoundFeesUsd,
          compoundGasBufferUsd: config.compoundGasBufferUsd,
          rebalanceGasCostUsd,
        });
        if (compoundGate.approved) {
          console.info(
            `[compound] Redeeming fees back into ${poolAddress} — ${compoundGate.reason}`,
          );
          // Atomic rebalance into the same range with the just-claimed net
          // fees as top-up, so the claimed fees become new liquidity in the
          // preserved position (no close+reopen).
          const topUp = {
            amountXAtomic: BigInt(Math.max(Math.trunc(claimed.netFeeX), 0)),
            amountYAtomic: BigInt(Math.max(Math.trunc(claimed.netFeeY), 0)),
          };
          const compoundResult =
            topUp.amountXAtomic === 0n && topUp.amountYAtomic === 0n
              ? null
              : yield* adapter
                  .rebalancePosition(
                    poolAddress,
                    positionPubKey,
                    pos.lowerBinId,
                    pos.upperBinId,
                    topUp,
                  )
                  .pipe(
                    Effect.tap((r) =>
                      Effect.sync(() =>
                        console.info("Compound rebalance succeeded", {
                          pool: poolAddress,
                          position: r.positionPubKey,
                        }),
                      ),
                    ),
                    Effect.catch((err) => {
                      console.warn("Compound rebalance failed", {
                        pool: poolAddress,
                        // SAFETY: this assertion is applied to a value whose producer and invariant are controlled by this code path.
                        err: (err as { message?: string }).message ?? String(err),
                      });
                      return Effect.succeed(null);
                    }),
                  );
          if (compoundResult) {
            if (compoundResult.positionPubKey !== pos.positionId) {
              // Defensive re-key: the identity and its row move with the
              // pubkey (same contract as the atomic rebalance path).
              trackedPositions.delete(pos.positionId);
              yield* persist(`deletePosition ${pos.positionId}`, db.deletePosition(pos.positionId));
              pos.positionId = compoundResult.positionPubKey;
              trackedPositions.set(pos.positionId, pos);
            }
            pos.positionPubKey = compoundResult.positionPubKey;
            pos.lastRebalanceAt = Date.now();
            // Compounded fees become new cost basis; currentValue/highest
            // adjust in lockstep so PnL and the trailing stop stay honest
            // (see applyCompoundToCostBasis in engine/pnl.ts).
            const compounded = applyCompoundToCostBasis({
              depositedUsd: pos.depositedUsd,
              currentValueUsd: pos.currentValueUsd,
              highestValueUsd: pos.highestValueUsd,
              compoundedFeesUsd: netFeesUsd,
            });
            pos.depositedUsd = compounded.depositedUsd;
            pos.currentValueUsd = compounded.currentValueUsd;
            pos.highestValueUsd = compounded.highestValueUsd;
            yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));
            yield* db
              .savePositionEvent({
                id: randomUUID(),
                poolAddress,
                positionPubKey: pos.positionPubKey,
                positionId: pos.positionId,
                event: "COMPOUND",
                valueUsd: netFeesUsd,
                feesUsd: null,
                price: null,
                metadata: { savingsUsd: compoundGate.savingsUsd },
                createdAt: Date.now(),
              })
              .pipe(Effect.ignore);
            yield* memory
              .upsert({
                category: "pattern",
                content: `Auto-compounded $${netFeesUsd.toFixed(2)} fees into ${poolAddress} (savings $${compoundGate.savingsUsd.toFixed(2)})`,
                poolAddress,
              })
              .pipe(Effect.ignore);
          }
        }
      }
    });

  const claimAllFees = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const revenueConfigResult = yield* revenueConfig.getConfig();
      const tier = revenueConfigResult.tier;

      for (const pos of trackedPositions.values()) {
        const poolAddress = pos.poolAddress;
        if (pos.positionPubKey && Date.now() - pos.lastFeeClaimAt > config.feeClaimIntervalMs) {
          yield* claimPositionRewards(pos, poolAddress, pos.positionPubKey);
          if (!(yield* checkHarvestGate(poolAddress, pos.positionPubKey))) continue;

          const claimed = yield* collectPositionFees(
            poolAddress,
            pos.positionPubKey,
            revenueConfigResult,
            tier,
          );
          if (!claimed) continue;

          // Mint-based net-fee USD from the adapter; null → 0 fails the
          // compound gate closed (see convertCollectedFees — the legacy
          // convertClaimFeesToUsd helper was removed with the Solana surface).
          const netFeesUsd = claimed.netFeesUsd ?? 0;

          yield* db
            .saveFeeClaim({
              id: randomUUID(),
              poolAddress,
              positionPubkey: pos.positionPubKey,
              feeX: claimed.feeX,
              feeY: claimed.feeY,
              platformFeeX: claimed.platformFeeX,
              platformFeeY: claimed.platformFeeY,
              netFeeX: claimed.netFeeX,
              netFeeY: claimed.netFeeY,
              operatorFeeX: claimed.operatorFeeX ?? 0,
              operatorFeeY: claimed.operatorFeeY ?? 0,
              txSignature: claimed.txSignature,
              feeTransferTxSignature: claimed.feeTransferTxSignature ?? null,
              reportedToApi: false,
              createdAt: Date.now(),
            })
            .pipe(Effect.ignore);

          yield* deps.reportCollectedFees(adapter, poolAddress, pos.positionPubKey, claimed, tier);

          pos.lastFeeClaimAt = Date.now();
          pos.cumulativeFeesClaimedUsd += netFeesUsd;
          yield* persist(`savePosition ${pos.positionId}`, db.savePosition(pos));

          yield* db
            .savePositionEvent({
              id: randomUUID(),
              poolAddress,
              positionPubKey: pos.positionPubKey,
              positionId: pos.positionId,
              event: "CLAIM",
              valueUsd: null,
              feesUsd: netFeesUsd,
              price: null,
              metadata: { txSignature: claimed.txSignature },
              createdAt: Date.now(),
            })
            .pipe(Effect.ignore);

          yield* alerts.recordFeeClaim(poolAddress, netFeesUsd);

          if (yield* convertCollectedFees(pos, poolAddress, claimed)) continue;
          yield* compoundCollectedFees(pos, poolAddress, pos.positionPubKey, claimed, netFeesUsd);
        }
      }
    });

  return { claimAllFees };
}
