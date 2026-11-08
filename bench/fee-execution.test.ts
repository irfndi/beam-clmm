import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  createFeeExecution,
  type FeeExecutionAdapter,
  type FeeExecutionDb,
  type FeeExecutionMemory,
} from "../engine/fee-execution.js";
import type { RevenueConfigApi, AlertApi } from "../engine/services.js";
import { defaultAppConfig, makePosition } from "./helpers.js";

describe("fee execution path", () => {
  it("claims, books, and persists net fees for an eligible position", async () => {
    const position = makePosition({
      positionPubKey: "0xposition",
      lastFeeClaimAt: 0,
      cumulativeFeesClaimedUsd: 0,
    });
    const events: string[] = [];
    const feeClaims: unknown[] = [];
    const alerts: Array<{ pool: string; feeUsd: number }> = [];

    const db: FeeExecutionDb = {
      saveFeeClaim: (claim: Parameters<FeeExecutionDb["saveFeeClaim"]>[0]) =>
        Effect.sync(() => {
          feeClaims.push(claim);
        }),
      savePosition: () =>
        Effect.sync(() => {
          events.push("savePosition");
        }),
      savePositionEvent: () =>
        Effect.sync(() => {
          events.push("savePositionEvent");
        }),
      deletePosition: () => Effect.void,
    };
    const adapter: FeeExecutionAdapter = {
      claimRewards: () =>
        Effect.succeed({ skipped: true, skipReason: null, txSignatures: [], rewards: [] }),
      rebalancePosition: () => Effect.die("not used in this test"),
      reportFeeCollection: () => Effect.void,
      claimFees: () =>
        Effect.succeed({
          txSignature: "0xclaim",
          feeX: 10,
          feeY: 20,
          platformFeeX: 1,
          platformFeeY: 2,
          netFeeX: 9,
          netFeeY: 18,
          netFeesUsd: 27,
        }),
    };
    const memory: FeeExecutionMemory = {
      upsert: () => Effect.void,
    };
    const revenueConfig: RevenueConfigApi = {
      getConfig: () =>
        Effect.succeed({
          tier: "free",
          platformFeeRate: 0,
          revenueShareEnabled: false,
          revenueShareOperatorPct: 0,
          feeWalletAddress: "",
        }),
      refreshConfig: () =>
        Effect.succeed({
          tier: "free",
          platformFeeRate: 0,
          revenueShareEnabled: false,
          revenueShareOperatorPct: 0,
          feeWalletAddress: "",
        }),
    };
    const alertApi: Pick<AlertApi, "recordFeeClaim"> = {
      recordFeeClaim: (pool, feeUsd) =>
        Effect.sync(() => {
          alerts.push({ pool, feeUsd });
        }),
    };

    const execution = createFeeExecution({
      adapter,
      db,
      memory,
      config: defaultAppConfig({
        feeClaimIntervalMs: 0,
        farmRewardsEnabled: false,
        feeDestination: "compound",
        autoCompoundFees: false,
      }),
      trackedPositions: new Map([[position.positionId, position]]),
      revenueConfig,
      alerts: alertApi,
      persist: (_label, effect) => Effect.ignore(effect),
      reportCollectedFees: () => Effect.void,
    });

    await Effect.runPromise(execution.claimAllFees());

    expect(feeClaims).toHaveLength(1);
    expect(position.cumulativeFeesClaimedUsd).toBe(27);
    expect(position.lastFeeClaimAt).toBeGreaterThan(0);
    expect(alerts).toEqual([{ pool: position.poolAddress, feeUsd: 27 }]);
    expect(events).toContain("savePosition");
    expect(events).toContain("savePositionEvent");
  });
});
