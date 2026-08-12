import { describe, it, expect } from "vitest";
import {
  createTokenCandidate,
  isCandidateEligible,
  evaluateCandidateHealth,
  hasFreshPriceEvidence,
  transitionCandidate,
  type CandidateHealthInput,
} from "../engine/candidate-policy.js";
import type { TokenCandidateRecord } from "../engine/types.js";
import type { TokenPriceEvidence } from "../engine/services.js";

const policy = { minHealthyScans: 3, minObservationMs: 60_000 };

function baseCandidate(overrides: Partial<TokenCandidateRecord> = {}): TokenCandidateRecord {
  const identity = {
    id: "cand-1",
    walletAddress: "wallet-1",
    agentInstanceId: "agent-1",
    poolAddress: "pool-1",
    tokenMint: "mint-1",
    firstSeenAt: 1_000,
  };
  return { ...createTokenCandidate(identity), ...overrides };
}

function healthInput(overrides: Partial<CandidateHealthInput> = {}): CandidateHealthInput {
  return {
    safety: { kind: "safe" },
    priceEvidence: [],
    requiredMints: ["mint-1"],
    now: 2_000,
    maxMarketDataAgeMs: 60_000,
    routeAvailable: true,
    screenerAccepted: true,
    marketDataAvailable: true,
    ...overrides,
  };
}

function freshEvidence(mint = "mint-1", observedAt = 1_500): TokenPriceEvidence {
  return { mint, priceUsd: 1.5, observedAt, fallbackUsed: false };
}

describe("createTokenCandidate", () => {
  it("creates a discovered candidate with zeroed counters and null gates", () => {
    const c = baseCandidate();
    expect(c.state).toBe("discovered");
    expect(c.healthyScanCount).toBe(0);
    expect(c.eligibleAt).toBeNull();
    expect(c.enteredAt).toBeNull();
    expect(c.cooldownUntil).toBeNull();
    expect(c.rejectionReason).toBeNull();
    expect(c.firstSeenAt).toBe(c.createdAt);
    expect(c.lastSeenAt).toBe(c.updatedAt);
  });
});

describe("hasFreshPriceEvidence / evaluateCandidateHealth", () => {
  it("returns true only when every required mint is fresh and non-fallback", () => {
    const input = healthInput({ priceEvidence: [freshEvidence()] });
    expect(hasFreshPriceEvidence(input)).toBe(true);
    expect(evaluateCandidateHealth(input).kind).toBe("healthy");
  });

  it("rejects stale, fallback, zero, negative, and future-dated evidence", () => {
    // observedAt 1_500 with a far-future now => age exceeds maxMarketDataAgeMs.
    const stale = healthInput({ priceEvidence: [freshEvidence("mint-1", 1_500)], now: 2_000_000 });
    expect(hasFreshPriceEvidence(stale)).toBe(false);
    expect(evaluateCandidateHealth(stale)).toEqual({
      kind: "transient_failure",
      reason: "price_evidence_stale",
    });

    const fallback = healthInput({
      priceEvidence: [{ ...freshEvidence(), fallbackUsed: true }],
    });
    expect(hasFreshPriceEvidence(fallback)).toBe(false);

    const noPrice = healthInput({ priceEvidence: [{ ...freshEvidence(), priceUsd: 0 }] });
    expect(hasFreshPriceEvidence(noPrice)).toBe(false);
  });

  it("returns price_evidence_unavailable when a required mint has no evidence at all", () => {
    const input = healthInput({ requiredMints: ["a", "b"], priceEvidence: [freshEvidence("a")] });
    expect(evaluateCandidateHealth(input)).toEqual({
      kind: "transient_failure",
      reason: "price_evidence_unavailable",
    });
  });

  it("returns hard_safety_failure and market_data/route/screener gates", () => {
    expect(
      evaluateCandidateHealth(healthInput({ safety: { kind: "hard_safety_failure", reason: "blacklisted" } })),
    ).toEqual({ kind: "hard_safety_failure", reason: "blacklisted" });

    expect(
      evaluateCandidateHealth(healthInput({ marketDataAvailable: false })).kind,
    ).toBe("transient_failure");

    expect(
      evaluateCandidateHealth(
        healthInput({ priceEvidence: [freshEvidence()], routeAvailable: false }),
      ),
    ).toEqual({ kind: "transient_failure", reason: "route_unavailable" });

    expect(
      evaluateCandidateHealth(
        healthInput({ priceEvidence: [freshEvidence()], screenerAccepted: false }),
      ),
    ).toEqual({ kind: "transient_failure", reason: "screener_rejected" });
  });
});

describe("isCandidateEligible", () => {
  it("requires both scan count and observation age", () => {
    const c = baseCandidate({ healthyScanCount: 3, firstSeenAt: 1_000, lastSeenAt: 100_000 });
    expect(isCandidateEligible(c, policy)).toBe(true);
    expect(isCandidateEligible({ ...c, healthyScanCount: 2 }, policy)).toBe(false);
    expect(isCandidateEligible({ ...c, lastSeenAt: 2_000 }, policy)).toBe(false);
  });
});

describe("transitionCandidate", () => {
  it("promotes discovered -> observing -> eligible across healthy scans", () => {
    const policy2 = { minHealthyScans: 2, minObservationMs: 0 };
    let c = baseCandidate();
    c = transitionCandidate(
      c,
      { kind: "scan", observedAt: 2_000, health: { kind: "healthy" } },
      policy2,
    );
    expect(c.state).toBe("observing");
    expect(c.healthyScanCount).toBe(1);
    c = transitionCandidate(
      c,
      { kind: "scan", observedAt: 3_000, health: { kind: "healthy" } },
      policy2,
    );
    expect(c.state).toBe("eligible");
    expect(c.healthyScanCount).toBe(2);
    expect(c.eligibleAt).toBe(3_000);
  });

  it("resets healthy scans on a transient failure while observing", () => {
    let c = transitionCandidate(
      baseCandidate({ state: "observing", healthyScanCount: 2 }),
      { kind: "scan", observedAt: 4_000, health: { kind: "transient_failure", reason: "route_unavailable" } },
      policy,
    );
    expect(c.state).toBe("observing");
    expect(c.healthyScanCount).toBe(0);
  });

  it("rejects on a hard safety failure and records the reason", () => {
    const c = transitionCandidate(
      baseCandidate({ state: "observing", healthyScanCount: 2, cooldownUntil: 999 }),
      { kind: "scan", observedAt: 5_000, health: { kind: "hard_safety_failure", reason: "blacklisted" } },
      policy,
    );
    expect(c.state).toBe("rejected");
    expect(c.rejectionReason).toBe("blacklisted");
    expect(c.healthyScanCount).toBe(0);
  });

  it("entry_confirmed only from eligible, cooldown_started only from entered", () => {
    const fromEligible = transitionCandidate(
      baseCandidate({ state: "eligible" }),
      { kind: "entry_confirmed", occurredAt: 6_000 },
      policy,
    );
    expect(fromEligible.state).toBe("entered");
    expect(fromEligible.enteredAt).toBe(6_000);

    const ignored = transitionCandidate(
      baseCandidate({ state: "observing" }),
      { kind: "entry_confirmed", occurredAt: 6_000 },
      policy,
    );
    expect(ignored.state).toBe("observing");

    const cooling = transitionCandidate(
      baseCandidate({ state: "entered" }),
      { kind: "cooldown_started", occurredAt: 7_000, cooldownUntil: 70_000 },
      policy,
    );
    expect(cooling.state).toBe("cooling_down");
    expect(cooling.cooldownUntil).toBe(70_000);
  });

  it("cooldown_elapsed returns discovered once the cooldown window has passed", () => {
    const c = transitionCandidate(
      baseCandidate({ state: "cooling_down", cooldownUntil: 70_000 }),
      { kind: "cooldown_elapsed", occurredAt: 80_000 },
      policy,
    );
    expect(c.state).toBe("discovered");
    expect(c.healthyScanCount).toBe(0);

    // Not yet elapsed → unchanged.
    const early = transitionCandidate(
      baseCandidate({ state: "cooling_down", cooldownUntil: 90_000 }),
      { kind: "cooldown_elapsed", occurredAt: 80_000 },
      policy,
    );
    expect(early.state).toBe("cooling_down");
  });
});