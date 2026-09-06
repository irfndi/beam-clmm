import { describe, expect, it } from "vitest";
import { decideKeep, passesWinGoal, type TrialScore } from "../ops/autoresearch-score.js";

const good: TrialScore = {
  netPnlUsd: 12,
  maxDrawdownPct: 0.02,
  roundTrips: 0,
  totalFeesUsd: 12,
  timeInRangePct: 0.7,
  winRate: 0.6,
  sharpeRatio: 1.2,
};

describe("autoresearch-score", () => {
  it("rejects below win-goal floors", () => {
    expect(passesWinGoal({ ...good, netPnlUsd: 1 })).toBe(false);
    expect(passesWinGoal({ ...good, maxDrawdownPct: 0.2 })).toBe(false);
    expect(passesWinGoal({ ...good, totalFeesUsd: 1 })).toBe(false);
    expect(passesWinGoal({ ...good, timeInRangePct: 0.2 })).toBe(false);
    expect(passesWinGoal(good)).toBe(true);
  });

  it("keeps first passing trial when baseline has not passed", () => {
    const d = decideKeep({
      trial: good,
      baseline: { ...good, netPnlUsd: 0, totalFeesUsd: 0, roundTrips: 0 },
      baselinePassedWinGoal: false,
    });
    expect(d.keep).toBe(true);
    expect(d.passedWinGoal).toBe(true);
  });

  it("requires +10% PnL once baseline already passes", () => {
    const baseline = { ...good, netPnlUsd: 10 };
    const weak = decideKeep({
      trial: { ...good, netPnlUsd: 10.5 },
      baseline,
      baselinePassedWinGoal: true,
    });
    expect(weak.keep).toBe(false);

    const strong = decideKeep({
      trial: { ...good, netPnlUsd: 11 },
      baseline,
      baselinePassedWinGoal: true,
    });
    expect(strong.keep).toBe(true);
  });
});
