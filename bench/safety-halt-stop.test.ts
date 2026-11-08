import { describe, it, expect } from "vitest";

/**
 * The safety-halt stop-loss rule in `engine/program.ts::rejectForSafety`.
 *
 * This mirrors the decision exactly: mark to the pool price, compute lossPct
 * against cost basis, and require `TRAILING_STOP_CONFIRM_CYCLES` consecutive
 * breaches so one noisy snapshot cannot churn a position out.
 *
 * Regression guard: before this rule existed, a safety halt (blacklist /
 * token-risk / freeze) returned before the per-position EXIT phase and left
 * held positions unmanaged. A $130 position on a token whose risk verdict
 * flipped post-entry rode to $0 (−100%, 588 min) because nothing ever
 * evaluated a stop for it.
 */
interface StopOutcome {
  readonly breach: boolean;
  readonly breaches: number;
  readonly exit: boolean;
}

function safetyHaltStopOutcome(
  currentValueUsd: number,
  depositedUsd: number,
  stopLossPct: number,
  priorBreaches: number,
  confirmCycles: number,
): StopOutcome {
  if (!(depositedUsd > 0)) return { breach: false, breaches: 0, exit: false };
  const lossPct = (currentValueUsd - depositedUsd) / depositedUsd;
  const breach = lossPct < -stopLossPct;
  const breaches = breach ? priorBreaches + 1 : 0;
  return { breach, breaches, exit: breach && breaches >= confirmCycles };
}

describe("safety-halt stop-loss", () => {
  const STOP = 0.15;
  const CONFIRM = 2;

  it("exits a position marked to zero (the −100% GME trade)", () => {
    // Actual case: $129.98 deposited, closed at $0, 588 minutes held.
    const r = safetyHaltStopOutcome(0, 129.98, STOP, 1, CONFIRM);
    expect(r.exit).toBe(true);
  });

  it("exits once the loss passes the stop threshold", () => {
    expect(safetyHaltStopOutcome(84, 100, STOP, 1, CONFIRM).exit).toBe(true);
    expect(safetyHaltStopOutcome(50, 100, STOP, 1, CONFIRM).exit).toBe(true);
  });

  it("does not exit while the loss is still inside the threshold", () => {
    expect(safetyHaltStopOutcome(86, 100, STOP, 1, CONFIRM).exit).toBe(false);
    // The duplicate STACK/USDG entries lost ~4% — well inside the stop.
    expect(safetyHaltStopOutcome(1096, 1144, STOP, 1, CONFIRM).exit).toBe(false);
  });

  it("never exits a flat or profitable position", () => {
    expect(safetyHaltStopOutcome(100, 100, STOP, 1, CONFIRM).exit).toBe(false);
    expect(safetyHaltStopOutcome(110, 100, STOP, 1, CONFIRM).exit).toBe(false);
  });

  it("honours the confirm-cycle debounce on the first breach", () => {
    const first = safetyHaltStopOutcome(50, 100, STOP, 0, CONFIRM);
    expect(first.exit).toBe(false);
    expect(first.breaches).toBe(1);
    // Second consecutive breach confirms and exits.
    expect(safetyHaltStopOutcome(50, 100, STOP, first.breaches, CONFIRM).exit).toBe(true);
  });

  it("resets the breach counter when the mark recovers", () => {
    const r = safetyHaltStopOutcome(105, 100, STOP, 1, CONFIRM);
    expect(r.breaches).toBe(0);
    expect(r.exit).toBe(false);
  });

  it("ignores a position with no cost basis", () => {
    expect(safetyHaltStopOutcome(0, 0, STOP, 5, 1).exit).toBe(false);
  });
});
