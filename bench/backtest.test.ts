import { describe, expect, it } from "vitest";
import { replayUsesMeasuredVolume } from "../ops/backtest.js";

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
});
