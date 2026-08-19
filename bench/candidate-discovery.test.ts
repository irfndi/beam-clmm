import { describe, it, expect } from "vitest";
import {
  advanceScreenedCandidates,
  type AdvanceScreenedCandidatesInput,
} from "../engine/candidate-discovery.js";
import { createTokenCandidate } from "../engine/candidate-policy.js";
import { NATIVE_MINT } from "../engine/constants.js";
import type { ScreenedPool, TokenPriceEvidence } from "../engine/services.js";

const policy = { minHealthyScans: 2, minObservationMs: 60_000 };

function pool(overrides: Partial<ScreenedPool> = {}): ScreenedPool {
  // SAFETY: this fixture supplies the screened-pool contract consumed by candidate discovery.
  return {
    address: "pool-1",
    tvlUsd: 100_000,
    volume24hUsd: 1000,
    fees24hUsd: 10,
    apr: 5,
    feeIlRatio: 1,
    volumeAuth: 1,
    binUtilization: 0.5,
    tokenX: "0xToken",
    tokenY: NATIVE_MINT,
    ...overrides,
  } as ScreenedPool;
}

function evidence(mint: string, observedAt = 1_500): TokenPriceEvidence {
  return { mint, priceUsd: 1.5, observedAt, fallbackUsed: false };
}

function bothEvidence(observedAt = 1_500): TokenPriceEvidence[] {
  return [evidence("0xToken", observedAt), evidence(NATIVE_MINT, observedAt)];
}

function input(
  overrides: Partial<AdvanceScreenedCandidatesInput> = {},
): AdvanceScreenedCandidatesInput {
  return {
    walletAddress: "wallet-1",
    agentInstanceId: "agent-1",
    screenedPools: [pool()],
    existingCandidates: [],
    priceEvidence: bothEvidence(),
    routeAvailableMints: new Set([NATIVE_MINT, "0xToken"]),
    now: 2_000,
    policy,
    maxMarketDataAgeMs: 60_000,
    ...overrides,
  };
}

describe("advanceScreenedCandidates", () => {
  it("creates a new candidate for a screened pool and returns it with no eligible pools yet", () => {
    const result = advanceScreenedCandidates(input());
    expect(result.updatedCandidates).toHaveLength(1);
    const c = result.updatedCandidates[0]!;
    expect(c.state).toBe("observing");
    expect(c.poolAddress).toBe("pool-1");
    expect(c.tokenMint).toBe("0xToken"); // tokenX since tokenY is native
    expect(result.eligiblePoolAddresses).toEqual([]);
  });

  it("promotes a candidate to eligible once health requirements are met across scans", () => {
    // First healthy scan at t=2000 with fresh evidence.
    const first = advanceScreenedCandidates(input({ now: 2_000 }));
    // Second healthy scan later (fresh evidence, meets observation window) → eligible.
    const secondNow = 2_000 + 120_000;
    const second = advanceScreenedCandidates(
      input({
        existingCandidates: first.updatedCandidates,
        now: secondNow,
        priceEvidence: bothEvidence(secondNow - 1_000),
      }),
    );
    const c = second.updatedCandidates[0]!;
    expect(c.state).toBe("eligible");
    expect(second.eligiblePoolAddresses).toEqual(["pool-1"]);
  });

  it("uses the native-mint side as the candidate token when tokenX is native", () => {
    const result = advanceScreenedCandidates(
      input({ screenedPools: [pool({ tokenX: NATIVE_MINT, tokenY: "0xOther" })] }),
    );
    expect(result.updatedCandidates[0]!.tokenMint).toBe("0xOther");
  });

  it("re-uses an existing candidate identity across scans (stable id)", () => {
    const seeded = createTokenCandidate({
      id: "wallet-1:agent-1:pool-1:0xToken",
      walletAddress: "wallet-1",
      agentInstanceId: "agent-1",
      poolAddress: "pool-1",
      tokenMint: "0xToken",
      firstSeenAt: 1_000,
    });
    const result = advanceScreenedCandidates(input({ existingCandidates: [seeded], now: 2_000 }));
    expect(result.updatedCandidates).toHaveLength(1);
    expect(result.updatedCandidates[0]!.id).toBe(seeded.id);
    expect(result.updatedCandidates[0]!.healthyScanCount).toBe(1);
  });

  it("marks a candidate not eligible when market data is unavailable (transient)", () => {
    const result = advanceScreenedCandidates(
      input({ screenedPools: [pool({ tvlUsd: 0, volume24hUsd: -1 })] }),
    );
    expect(result.updatedCandidates[0]!.state).not.toBe("eligible");
    expect(result.eligiblePoolAddresses).toEqual([]);
  });

  it("dedupes eligible pool addresses across multiple screened pools", () => {
    const twoPools = [pool(), pool({ address: "pool-2" })];
    // Two healthy scans with fresh evidence to reach eligibility.
    let candidates: AdvanceScreenedCandidatesInput["existingCandidates"] = [];
    for (let i = 0; i < 2; i++) {
      const t = 2_000 + i * 120_000;
      const r = advanceScreenedCandidates(
        input({
          screenedPools: twoPools,
          existingCandidates: candidates,
          now: t,
          priceEvidence: bothEvidence(t - 1_000),
        }),
      );
      candidates = r.updatedCandidates;
    }
    const finalNow = 2_000 + 3 * 120_000;
    const final = advanceScreenedCandidates(
      input({
        screenedPools: twoPools,
        existingCandidates: candidates,
        now: finalNow,
        priceEvidence: bothEvidence(finalNow - 1_000),
      }),
    );
    expect(final.eligiblePoolAddresses).toEqual(["pool-1", "pool-2"]);
  });
});
