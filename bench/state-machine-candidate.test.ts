import { describe, it, expect } from "vitest";
import { transitionCandidate } from "../engine/candidate-policy.js";
import { createTokenCandidate, positionGoneEvent } from "../engine/candidate-policy.js";
import type { TokenCandidateRecord } from "../engine/types.js";

const policy = { minHealthyScans: 2, minObservationMs: 0 };

function candidate(overrides: Partial<TokenCandidateRecord> = {}): TokenCandidateRecord {
  return {
    ...createTokenCandidate({
      id: "cand-1",
      walletAddress: "wallet-1",
      agentInstanceId: "primary",
      poolAddress: "pool-1",
      tokenMint: "mint-1",
      firstSeenAt: 1_000,
    }),
    ...overrides,
  };
}

describe("candidate state machine: entered is not absorbing", () => {
  it("an entered candidate with no open position enters cooldown", () => {
    // Given an entered candidate whose position vanished without an executed
    // EXIT (external close, liquidation, reconcile delete). No lifecycle event
    // fires in that case, so the recovery reuses the exit event.
    const entered = candidate({ state: "entered", enteredAt: 5_000, lastSeenAt: 5_000 });

    // When
    const event = positionGoneEvent(entered, 10_000, 60_000);
    expect(event).not.toBeNull();
    const cooling = transitionCandidate(entered, event!, policy);

    // Then it reaches cooling_down, which is the ONLY path back to discovered.
    expect(cooling.state).toBe("cooling_down");
    expect(cooling.cooldownUntil).toBe(70_000);

    const back = transitionCandidate(
      cooling,
      { kind: "cooldown_elapsed", occurredAt: 80_000 },
      policy,
    );
    expect(back.state).toBe("discovered");
  });

  it("positionGoneEvent is null for every non-entered state", () => {
    // Guards the fix's precision: a healthy observing candidate must not be
    // pushed into cooldown by an unrelated pool's missing position.
    for (const state of ["discovered", "observing", "eligible", "cooling_down", "rejected"] as const) {
      expect(positionGoneEvent(candidate({ state }), 10_000, 60_000)).toBeNull();
    }
  });

  it("a scan alone leaves an entered candidate entered", () => {
    // Pins the reason the cooldown event is required: recordScan has no
    // entered -> cooling_down edge, so time never advances the state.
    const entered = candidate({ state: "entered", enteredAt: 5_000 });

    const scanned = transitionCandidate(
      entered,
      { kind: "scan", observedAt: 10_000, health: { kind: "healthy" } },
      policy,
    );

    expect(scanned.state).toBe("entered");
  });
});
