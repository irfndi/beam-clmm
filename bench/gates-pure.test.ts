import { describe, expect, it } from "vitest";
import { shouldHarvest } from "../engine/harvest-gate.js";
import { feePersistence } from "../engine/fee-persistence.js";
import { applyMinRangePct } from "../engine/range-floor.js";
import { entryBudgetWei } from "../engine/gas-reserve.js";

describe("harvest gate (rule 10: do not spend $0.80 to realize $1.00)", () => {
  it("harvests when both conditions are comfortably met", () => {
    const decision = shouldHarvest(10, 0.5);
    expect(decision.harvest).toBe(true);
    expect(decision.reason).toContain("fees");
  });

  it("uses default minNetUsd=1: $1 of fees with 14c gas harvests", () => {
    expect(shouldHarvest(1, 0.14).harvest).toBe(true);
  });

  it("uses default maxGasPct=0.15: $1 of fees with 16c gas does not", () => {
    const decision = shouldHarvest(1, 0.16);
    expect(decision.harvest).toBe(false);
    expect(decision.reason).toContain("gas");
  });

  it("refuses when fees are below minNetUsd", () => {
    const decision = shouldHarvest(0.9, 0.01);
    expect(decision.harvest).toBe(false);
    expect(decision.reason).toContain("minNetUsd");
  });

  it("refuses when gas exceeds maxGasPct of fees", () => {
    expect(shouldHarvest(10, 1.6).harvest).toBe(false); // ceiling 1.5
  });

  it("harvests at the boundary: fees exactly equal to minNetUsd", () => {
    expect(shouldHarvest(1, 0.15).harvest).toBe(true);
  });

  it("harvests at the boundary: gas exactly equal to the ceiling", () => {
    expect(shouldHarvest(10, 1.5).harvest).toBe(true);
  });

  it("fails closed on NaN fees", () => {
    expect(shouldHarvest(Number.NaN, 0.1).harvest).toBe(false);
  });

  it("fails closed on NaN gas cost", () => {
    expect(shouldHarvest(10, Number.NaN).harvest).toBe(false);
  });

  it("fails closed on negative fees", () => {
    expect(shouldHarvest(-5, 0.1).harvest).toBe(false);
  });

  it("fails closed on negative gas cost", () => {
    expect(shouldHarvest(10, -0.1).harvest).toBe(false);
  });

  it("fails closed on infinite fees", () => {
    expect(shouldHarvest(Number.POSITIVE_INFINITY, 0.1).harvest).toBe(false);
  });

  it("does not harvest zero fees (below default minimum)", () => {
    expect(shouldHarvest(0, 0).harvest).toBe(false);
  });

  it("fails closed on malformed minNetUsd", () => {
    expect(shouldHarvest(10, 0.1, { minNetUsd: Number.NaN }).harvest).toBe(false);
    expect(shouldHarvest(10, 0.1, { minNetUsd: -1 }).harvest).toBe(false);
  });

  it("fails closed on malformed maxGasPct", () => {
    expect(shouldHarvest(10, 0.1, { maxGasPct: Number.NaN }).harvest).toBe(false);
    expect(shouldHarvest(10, 0.1, { maxGasPct: -0.1 }).harvest).toBe(false);
  });

  it("honors custom options", () => {
    expect(shouldHarvest(5, 0.5, { minNetUsd: 5, maxGasPct: 0.1 }).harvest).toBe(true);
    expect(shouldHarvest(5, 0.51, { minNetUsd: 5, maxGasPct: 0.1 }).harvest).toBe(false);
  });
});

describe("fee persistence (rule 2: reject one-off spikes)", () => {
  it("is persistent for a flat series with a small bump", () => {
    const decision = feePersistence([1, 1, 1, 1, 1, 1, 2]);
    expect(decision.persistent).toBe(true);
    expect(decision.reason).toContain("positive days");
  });

  it("rejects when fewer than minPositiveDays days are positive", () => {
    const decision = feePersistence([1, 1, 1, 0, 0, 0, 0]);
    expect(decision.persistent).toBe(false);
    expect(decision.reason).toContain("positive fee days");
  });

  it("rejects a one-off spike (max/median above maxSpikeRatio)", () => {
    const decision = feePersistence([1, 1, 1, 1, 1, 1, 100]);
    expect(decision.persistent).toBe(false);
    expect(decision.reason).toContain("exceeds");
  });

  it("accepts at the spike-ratio boundary (ratio exactly 3)", () => {
    expect(feePersistence([1, 1, 1, 1, 1, 1, 3]).persistent).toBe(true);
  });

  it("rejects just past the boundary", () => {
    expect(feePersistence([1, 1, 1, 1, 1, 1, 3.01]).persistent).toBe(false);
  });

  it("ignores null days when counting positives", () => {
    expect(feePersistence([null, null, 1, 2, 3, 4, 5]).persistent).toBe(true);
  });

  it("ignores NaN days when counting positives", () => {
    expect(feePersistence([Number.NaN, 1, 2, 3, 4, 5, 6]).persistent).toBe(true);
  });

  it("does not count zero days", () => {
    expect(feePersistence([0, 0, 0, 1, 1, 1, 1]).persistent).toBe(true);
    expect(feePersistence([0, 0, 0, 0, 1, 1, 1]).persistent).toBe(false);
  });

  it("is not persistent for an empty series", () => {
    expect(feePersistence([]).persistent).toBe(false);
  });

  it("is not persistent for an all-null series", () => {
    expect(feePersistence([null, null, null, null, null, null, null]).persistent).toBe(false);
  });

  it("only considers the last windowDays entries", () => {
    const tenFlatDays = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    expect(feePersistence(tenFlatDays, { windowDays: 7 }).persistent).toBe(true);
    expect(feePersistence(tenFlatDays, { windowDays: 3 }).persistent).toBe(false);
  });

  it("works with a single-day window", () => {
    expect(feePersistence([5], { windowDays: 1, minPositiveDays: 1 }).persistent).toBe(true);
  });

  it("computes the median of an even positive count", () => {
    // positives [1,2,3,100] -> median 2.5, ratio 40 -> rejected
    expect(feePersistence([1, 2, 3, 100]).persistent).toBe(false);
    // positives [1,2,3,4] -> median 2.5, ratio 1.6 -> accepted
    expect(feePersistence([1, 2, 3, 4]).persistent).toBe(true);
  });

  it("excludes negative days without poisoning the series", () => {
    expect(feePersistence([-5, 1, 2, 3, 4, 5, 6]).persistent).toBe(true);
  });

  it("fails closed on malformed windowDays", () => {
    expect(feePersistence([1, 1, 1, 1, 1, 1, 1], { windowDays: 0 }).persistent).toBe(false);
    expect(feePersistence([1, 1, 1, 1, 1, 1, 1], { windowDays: Number.NaN }).persistent).toBe(
      false,
    );
  });

  it("fails closed on malformed minPositiveDays", () => {
    expect(feePersistence([1, 1, 1, 1, 1, 1, 1], { minPositiveDays: 0 }).persistent).toBe(false);
  });

  it("fails closed on malformed maxSpikeRatio", () => {
    expect(feePersistence([1, 1, 1, 1, 1, 1, 1], { maxSpikeRatio: 0 }).persistent).toBe(false);
    expect(feePersistence([1, 1, 1, 1, 1, 1, 1], { maxSpikeRatio: Number.NaN }).persistent).toBe(
      false,
    );
  });
});

describe("range floor (low-volatility pools still get >= 20% full width)", () => {
  it("leaves a half-width already above the floor unchanged", () => {
    expect(applyMinRangePct(0.15)).toBe(0.15);
    expect(applyMinRangePct(0.5)).toBe(0.5);
  });

  it("raises a narrow half-width to half of minFullRangePct", () => {
    expect(applyMinRangePct(0.05)).toBe(0.1); // full width 0.2
  });

  it("keeps a half-width exactly at the floor", () => {
    expect(applyMinRangePct(0.1)).toBe(0.1);
  });

  it("honors a custom minFullRangePct", () => {
    expect(applyMinRangePct(0.05, 0.4)).toBe(0.2); // full width 0.4
    expect(applyMinRangePct(0.3, 0.4)).toBe(0.3); // already above 0.2 floor
  });

  it("allows an explicit 0 minFullRangePct to disable the floor", () => {
    expect(applyMinRangePct(0.03, 0)).toBe(0.03);
  });

  it("returns the floor for NaN half-width", () => {
    expect(applyMinRangePct(Number.NaN)).toBe(0.1);
  });

  it("returns the floor for a negative half-width", () => {
    expect(applyMinRangePct(-0.05)).toBe(0.1);
  });

  it("returns the floor for an infinite half-width", () => {
    expect(applyMinRangePct(Number.POSITIVE_INFINITY)).toBe(0.1);
  });

  it("falls back to the default floor for NaN minFullRangePct", () => {
    expect(applyMinRangePct(0.05, Number.NaN)).toBe(0.1);
  });

  it("falls back to the default floor for negative minFullRangePct", () => {
    expect(applyMinRangePct(0.05, -0.1)).toBe(0.1);
  });

  it("never returns NaN or a negative result", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      expect(Number.isFinite(applyMinRangePct(bad))).toBe(true);
      expect(applyMinRangePct(bad)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("gas reserve (rule 6: max(10% allocation, emergency-exit minimum))", () => {
  it("returns 0 for a zero balance", () => {
    expect(entryBudgetWei(0n)).toBe(0n);
  });

  it("returns 0 for a negative balance", () => {
    expect(entryBudgetWei(-100n)).toBe(0n);
  });

  it("reserves 10% by default", () => {
    expect(entryBudgetWei(1_000n)).toBe(900n);
  });

  it("uses the emergency-exit floor when it exceeds the percentage", () => {
    expect(entryBudgetWei(1_000n, { emergencyExitWei: 300n })).toBe(700n);
  });

  it("uses the percentage reserve when it exceeds the emergency floor", () => {
    expect(entryBudgetWei(1_000n, { emergencyExitWei: 50n })).toBe(900n);
  });

  it("floors spendable at 0 when the balance cannot cover the reserve", () => {
    expect(entryBudgetWei(200n, { emergencyExitWei: 300n })).toBe(0n);
  });

  it("spends nothing when the balance exactly equals the reserve", () => {
    expect(entryBudgetWei(100n, { reservePct: 100 })).toBe(0n);
  });

  it("computes the max of equal reserves once", () => {
    // reservePct 30 -> 300; emergency 300 -> max 300
    expect(entryBudgetWei(1_000n, { reservePct: 30, emergencyExitWei: 300n })).toBe(700n);
  });

  it("supports reservePct 0 (only the emergency floor applies)", () => {
    expect(entryBudgetWei(1_000n, { reservePct: 0 })).toBe(1_000n);
    expect(entryBudgetWei(1_000n, { reservePct: 0, emergencyExitWei: 100n })).toBe(900n);
  });

  it("returns 0 for reservePct 100", () => {
    expect(entryBudgetWei(1_000n, { reservePct: 100 })).toBe(0n);
  });

  it("returns 0 for an absurdly large reservePct", () => {
    expect(entryBudgetWei(1_000n, { reservePct: 1e9 })).toBe(0n);
  });

  it("falls back to 10% for NaN reservePct", () => {
    expect(entryBudgetWei(1_000n, { reservePct: Number.NaN })).toBe(900n);
  });

  it("falls back to 10% for negative reservePct", () => {
    expect(entryBudgetWei(1_000n, { reservePct: -5 })).toBe(900n);
  });

  it("falls back to 10% for infinite reservePct", () => {
    expect(entryBudgetWei(1_000n, { reservePct: Number.POSITIVE_INFINITY })).toBe(900n);
  });

  it("floors fractional reservePct to a whole percent", () => {
    expect(entryBudgetWei(1_000n, { reservePct: 10.9 })).toBe(900n);
    expect(entryBudgetWei(1_000n, { reservePct: 12.5 })).toBe(880n); // 12% -> 120
  });

  it("clamps a negative emergencyExitWei to 0", () => {
    expect(entryBudgetWei(1_000n, { emergencyExitWei: -50n })).toBe(900n);
  });

  it("keeps full wei precision (no float rounding)", () => {
    const balance = 10n ** 24n;
    expect(entryBudgetWei(balance)).toBe(9n * 10n ** 23n);
    expect(entryBudgetWei(balance, { emergencyExitWei: 7n * 10n ** 22n })).toBe(9n * 10n ** 23n);
  });

  it("never returns a negative spendable", () => {
    expect(entryBudgetWei(10n, { reservePct: 10, emergencyExitWei: 10n })).toBe(0n);
    expect(entryBudgetWei(5n, { reservePct: 10, emergencyExitWei: 10n })).toBe(0n);
  });
});
