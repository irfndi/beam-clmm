import { describe, expect, it } from "vitest";
import { inferReplayPoolAgeMs, replayUsesMeasuredVolume } from "../ops/backtest.js";

describe("replay stats-source trust", () => {
  it("treats Krystal and Data API snapshots as measured volume", () => {
    expect(replayUsesMeasuredVolume("krystal")).toBe(true);
    expect(replayUsesMeasuredVolume("datapi")).toBe(true);
  });

  it("keeps modeled and heuristic sources out of the measured gate", () => {
    expect(replayUsesMeasuredVolume("geckoterminal")).toBe(false);
    expect(replayUsesMeasuredVolume("heuristic")).toBe(false);
    expect(replayUsesMeasuredVolume(undefined)).toBe(false);
  });

  it("does not treat the replay window start as measured-pool creation", () => {
    const firstObserved = 1_000_000;
    expect(
      inferReplayPoolAgeMs(
        { timestamp: firstObserved, statsSource: "krystal", fees24hUsd: 10 },
        firstObserved,
      ),
    ).toBe(24 * 60 * 60 * 1000);
    expect(
      inferReplayPoolAgeMs(
        { timestamp: firstObserved, statsSource: "heuristic", fees24hUsd: 10 },
        firstObserved,
      ),
    ).toBe(0);
  });
});
