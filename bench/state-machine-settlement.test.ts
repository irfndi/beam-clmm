import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { processSettlementJobs, sweepOrphanSettlements } from "../engine/autonomous-runtime.js";
import { NATIVE_MINT, STABLECOIN_MINT } from "../engine/constants.js";
import type { DbApi, AdapterApi } from "../engine/services.js";
import type { SettlementJobRecord } from "../engine/types.js";
import { makePosition } from "./helpers.js";

const USDC_KEY = STABLECOIN_MINT.toLowerCase();
const STRAY = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function settlementJob(overrides: Partial<SettlementJobRecord> = {}): SettlementJobRecord {
  return {
    id: "settlement-1",
    walletAddress: "wallet-1",
    agentInstanceId: "primary",
    positionId: "position-1",
    poolAddress: "pool-1",
    tokenMint: STRAY,
    amountAtomic: "1000000",
    destinationAsset: "ETH",
    status: "pending",
    attempts: 0,
    nextRetryAt: 0,
    txSignature: null,
    confirmedOutputAtomic: null,
    outputUsd: null,
    executionCostUsd: null,
    finalizedAt: null,
    realizedPnlUsd: null,
    expiresAt: 3_600_000,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** One whole token (18 decimals) so it clears the dust gate at $2/token. */
const ONE_TOKEN_18D = 10n ** 18n;

function holdingsOf(
  entries: ReadonlyArray<[string, bigint, number]>,
): Map<string, { amountAtomic: bigint; decimals: number }> {
  return new Map(
    entries.map(([mint, amountAtomic, decimals]) => [mint, { amountAtomic, decimals }]),
  );
}

function sweep(
  holdings: Map<string, { amountAtomic: bigint; decimals: number }>,
  prices: Record<string, number>,
  existingJobs: ReadonlyArray<SettlementJobRecord> = [],
) {
  const adapter: Partial<AdapterApi> = {
    hasWallet: () => true,
    getWalletHoldings: () => Effect.succeed(holdings),
    getPoolState: () => Effect.fail(new Error("no pool")),
    getTokenPrices: () => Effect.succeed(prices),
  };
  const db: Partial<DbApi> = {
    listSettlementJobs: () => Effect.succeed([...existingJobs]),
    getAllPositions: () => Effect.succeed([]),
  };
  // SAFETY: both partials implement exactly the methods this sweep calls; no
  // other member is reachable through the widened value.
  const adapterApi = adapter as AdapterApi;
  // SAFETY: same contract for the db partial.
  const dbApi = db as DbApi;
  return Effect.runPromise(
    sweepOrphanSettlements({
      adapter: adapterApi,
      db: dbApi,
      walletAddress: "wallet-1",
      agentInstanceId: "primary",
      settlementMaxPendingMs: 3_600_000,
      settlementDustUsd: 0.1,
      now: 1_000,
    }),
  );
}

describe("orphan settlement sweep: settlement assets", () => {
  it("keeps a lowercased settlement stablecoin out of the orphan bucket", async () => {
    // Given the adapter's real holdings shape: every key lowercased, so the
    // checksummed USDC constant never string-matches the holding key.
    const holdings = holdingsOf([
      [NATIVE_MINT.toLowerCase(), 10n ** 16n, 18],
      [USDC_KEY, 50_000_000n, 6], // $50 funding stablecoin
      [STRAY, ONE_TOKEN_18D, 18],
    ]);

    // When
    const jobs = await sweep(holdings, { [USDC_KEY]: 1, [STRAY]: 2 });

    // Then only the stray token is sold; sweeping USDC swaps the engine's
    // funding leg to ETH and pays gas + slippage for it.
    expect(jobs.map((job) => job.tokenMint)).toEqual([STRAY]);
  });

  it("keeps the native gas token out of the orphan bucket", async () => {
    // Given
    const holdings = holdingsOf([
      [NATIVE_MINT.toLowerCase(), 10n ** 16n, 18],
      [STRAY, ONE_TOKEN_18D, 18],
    ]);

    // When
    const jobs = await sweep(holdings, { [NATIVE_MINT.toLowerCase()]: 2000, [STRAY]: 2 });

    // Then
    expect(jobs.map((job) => job.tokenMint)).toEqual([STRAY]);
  });
});

describe("orphan settlement sweep: terminal revival", () => {
  const terminalWithError = (error: string): SettlementJobRecord =>
    settlementJob({
      id: "old",
      positionId: "orphan:old",
      status: "terminal",
      attempts: 4,
      nextRetryAt: null,
      txSignature: null,
      confirmedOutputAtomic: null,
      expiresAt: 1,
      error,
    });

  it("does not revive a terminal job whose error is deterministic", async () => {
    // Given a job terminalized for an unrecoverable route while the mint is
    // still in the wallet.
    const holdings = holdingsOf([[STRAY, ONE_TOKEN_18D, 18]]);
    const existing = terminalWithError(
      "quoteSwap: no direct v3 or registered v4 pool for 0xdeadbeef",
    );

    // When
    const jobs = await sweep(holdings, { [STRAY]: 2 }, [existing]);

    // Then no revived job: a deterministic failure can never succeed, and
    // reviving it also undoes an operator's manual terminalization.
    expect(jobs).toEqual([]);
  });

  it("still revives a terminal job that merely expired", async () => {
    // Given a job that terminalized on the max-pending window, not on a
    // deterministic failure — retrying is correct because the cause was time.
    const holdings = holdingsOf([[STRAY, ONE_TOKEN_18D, 18]]);
    const existing = terminalWithError("Settlement exceeded max pending window");

    // When
    const jobs = await sweep(holdings, { [STRAY]: 2 }, [existing]);

    // Then the row is revived in place (same id, attempts kept, window refreshed).
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: "old",
      status: "pending",
      attempts: 5,
      amountAtomic: ONE_TOKEN_18D.toString(),
      expiresAt: 1_000 + 3_600_000,
    });
  });
});

describe("settlement group finalization", () => {
  const confirmedLeg = (id: string): SettlementJobRecord =>
    settlementJob({
      id,
      status: "confirmed",
      txSignature: `0x${id}`,
      confirmedOutputAtomic: "1",
      outputUsd: 10,
      executionCostUsd: 1,
      nextRetryAt: null,
    });

  /** A confirmed leg whose accounting is incomplete, so it must be re-written. */
  const incompleteConfirmedLeg = (id: string): SettlementJobRecord =>
    settlementJob({
      id,
      status: "confirmed",
      txSignature: `0x${id}`,
      confirmedOutputAtomic: "1",
      outputUsd: null,
      executionCostUsd: null,
    });

  const completingAdapter: Partial<AdapterApi> = {
    getSwapStatus: () => Effect.succeed({ state: "confirmed", error: null }),
    getConfirmedSwapOutput: () => Effect.succeed({ outputAtomic: 5n, feeAtomic: 1n }),
    getTokenPrices: () => Effect.succeed({ [NATIVE_MINT]: 2_000 }),
  };

  // SAFETY: the fixture implements exactly the adapter methods this path calls.
  const completingAdapterApi = completingAdapter as AdapterApi;

  const positionRow = makePosition({
    positionId: "position-1",
    poolAddress: "pool-1",
    depositedUsd: 100,
    cumulativeFeesClaimedUsd: 0,
    cumulativeRewardsClaimedUsd: 0,
    entrySignalSnapshotId: null,
  });

  it("does not finalize a group whose sibling write failed", async () => {
    // Given a position whose second leg can only be completed by re-writing the
    // row, and that write hits a transient SQLite error.
    const finalizedGroups: Array<{ jobIds: ReadonlyArray<string> }> = [];
    const db: Partial<DbApi> = {
      saveSettlementJob: (job: SettlementJobRecord) =>
        job.id === "leg-b" ? Effect.fail(new Error("SQLITE_BUSY")) : Effect.void,
      getPosition: () => Effect.succeed(positionRow),
      finalizeSettlementGroup: (input: { jobIds: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          finalizedGroups.push(input);
        }),
    };

    // SAFETY: the fixture implements exactly the db methods this path calls.
    const dbApi = db as DbApi;

    // When
    await Effect.runPromise(
      processSettlementJobs({
        adapter: completingAdapterApi,
        db: dbApi,
        jobs: [confirmedLeg("leg-a"), incompleteConfirmedLeg("leg-b")],
        mode: "live",
        now: 10_000,
        maxSwapSlippageBps: 50,
      }),
    );

    // Then no PnL is booked from half the position; the next cycle retries.
    expect(finalizedGroups).toEqual([]);
  });

  it("finalizes a group whose legs all persisted", async () => {
    // Given the same group with the completing write succeeding.
    const finalizedGroups: Array<{ jobIds: ReadonlyArray<string> }> = [];
    const db: Partial<DbApi> = {
      saveSettlementJob: () => Effect.void,
      getPosition: () => Effect.succeed(positionRow),
      finalizeSettlementGroup: (input: { jobIds: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          finalizedGroups.push(input);
        }),
    };

    // SAFETY: the fixture implements exactly the db methods this path calls.
    const dbApi = db as DbApi;

    // When
    await Effect.runPromise(
      processSettlementJobs({
        adapter: completingAdapterApi,
        db: dbApi,
        jobs: [confirmedLeg("leg-a"), incompleteConfirmedLeg("leg-b")],
        mode: "live",
        now: 10_000,
        maxSwapSlippageBps: 50,
      }),
    );

    // Then
    expect(finalizedGroups).toHaveLength(1);
    expect(finalizedGroups[0]).toMatchObject({
      positionId: "position-1",
      jobIds: ["leg-a", "leg-b"],
    });
  });
});
