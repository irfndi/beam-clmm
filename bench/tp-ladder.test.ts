import { describe, it, expect } from "vitest";
import {
  buildTpLadder,
  evaluateTpLadder,
  parseTpLadder,
  serializeTpLadder,
  type TpLadder,
} from "../engine/tp-ladder.js";

const baseConfig = {
  rungs: [0.15, 0.3, 0.5],
  fractions: [0.4, 0.3, 0.3],
  invalidationStopPct: 0.2,
};

describe("buildTpLadder", () => {
  it("builds ascending rungs and renormalizes fractions that sum below 1", () => {
    const result = buildTpLadder(100, baseConfig)!;
    expect(result.ladder.rungs.map((r) => r.targetPrice)).toEqual([114.99999999999999, 130, 150]);
    expect(result.ladder.rungs.map((r) => r.fraction)).toEqual([0.4, 0.3, 0.3]);
    expect(result.ladder.totalFraction).toBeCloseTo(1, 8);
    expect(result.invalidationPrice).toBeCloseTo(80, 8);
  });

  it("renormalizes fractions that sum above 1 down to exactly 1", () => {
    const result = buildTpLadder(100, {
      rungs: [0.1, 0.2],
      fractions: [1, 1],
      invalidationStopPct: 0.1,
    })!;
    expect(result.ladder.totalFraction).toBeCloseTo(1, 8);
    expect(result.ladder.rungs.map((r) => r.fraction)).toEqual([0.5, 0.5]);
  });

  it("caps at the shorter of rungs/fractions", () => {
    const result = buildTpLadder(100, {
      rungs: [0.1, 0.2, 0.3],
      fractions: [0.5],
      invalidationStopPct: 0.1,
    })!;
    expect(result.ladder.rungs).toHaveLength(1);
    expect(result.ladder.rungs[0]!.targetPrice).toBeCloseTo(110, 8);
  });

  it("sorts unsorted rung pcts while keeping fractions attached", () => {
    const result = buildTpLadder(100, {
      rungs: [0.5, 0.15],
      fractions: [0.7, 0.3],
      invalidationStopPct: 0.1,
    })!;
    expect(result.ladder.rungs[0]!.targetPrice).toBeCloseTo(115, 8);
    expect(result.ladder.rungs[0]!.fraction).toBe(0.3);
    expect(result.ladder.rungs[1]!.targetPrice).toBe(150);
    expect(result.ladder.rungs[1]!.fraction).toBe(0.7);
  });

  it("returns null for empty config (no rungs)", () => {
    expect(buildTpLadder(100, { rungs: [], fractions: [], invalidationStopPct: 0.1 })).toBeNull();
  });

  it("returns null for non-positive or non-finite entry", () => {
    expect(buildTpLadder(0, baseConfig)).toBeNull();
    expect(buildTpLadder(-5, baseConfig)).toBeNull();
    expect(buildTpLadder(Number.NaN, baseConfig)).toBeNull();
  });
});

describe("evaluateTpLadder", () => {
  const ladder = buildTpLadder(100, baseConfig)!;

  it("fires invalidation first when price is at or below the invalidation price", () => {
    const result = evaluateTpLadder(80, ladder.ladder, ladder.invalidationPrice);
    expect(result.status).toBe("invalidation");
    expect(result.invalidationPrice).toBe(80);
  });

  it("reports the first reached rung with its scale-out fraction", () => {
    const result = evaluateTpLadder(120, ladder.ladder, ladder.invalidationPrice);
    expect(result.status).toBe("tp");
    expect(result.rungReached!.targetPrice).toBeCloseTo(115, 8);
    expect(result.scaleOutFraction).toBeCloseTo(0.4, 8);
    expect(result.ladderComplete).toBe(false);
  });

  it("marks the last rung as ladder complete on a single-rung ladder", () => {
    const single = buildTpLadder(100, { rungs: [0.5], fractions: [1], invalidationStopPct: 0.2 })!;
    const result = evaluateTpLadder(200, single.ladder, single.invalidationPrice);
    expect(result.status).toBe("tp");
    expect(result.rungReached!.targetPrice).toBeCloseTo(150, 8);
    expect(result.ladderComplete).toBe(true);
  });

  it("returns none when no rung is reached and invalidation is not hit", () => {
    const result = evaluateTpLadder(100, ladder.ladder, ladder.invalidationPrice);
    expect(result.status).toBe("none");
  });

  it("returns none for non-positive or non-finite current price", () => {
    expect(evaluateTpLadder(0, ladder.ladder, 80)).toEqual({ status: "none" });
    expect(evaluateTpLadder(Number.NaN, ladder.ladder, 80)).toEqual({ status: "none" });
  });
});

describe("serializeTpLadder / parseTpLadder", () => {
  const ladder: TpLadder = {
    rungs: [
      { targetPrice: 115, fraction: 0.4 },
      { targetPrice: 130, fraction: 0.3 },
    ],
    totalFraction: 0.7,
  };

  it("round-trips a ladder through JSON", () => {
    const raw = serializeTpLadder(ladder)!;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime typeof assertion on a genuinely-dynamic test value / real union narrowing, not a type alias
    expect(typeof raw).toBe("string");
    const parsed = parseTpLadder(raw)!;
    expect(parsed.rungs).toEqual(ladder.rungs);
    expect(parsed.totalFraction).toBeCloseTo(0.7, 8);
  });

  it("serializes an empty or undefined ladder to null", () => {
    expect(serializeTpLadder(undefined)).toBeNull();
    expect(serializeTpLadder({ rungs: [], totalFraction: 0 })).toBeNull();
  });

  it("parses null, empty, and invalid JSON to null", () => {
    expect(parseTpLadder(null)).toBeNull();
    expect(parseTpLadder(undefined)).toBeNull();
    expect(parseTpLadder("")).toBeNull();
    expect(parseTpLadder("not json")).toBeNull();
  });

  it("parses a payload with no valid rungs to null", () => {
    expect(parseTpLadder('{"rungs":[]}')).toBeNull();
    expect(parseTpLadder('{"rungs":[{"targetPrice":-5,"fraction":2}]}')).toBeNull();
    expect(parseTpLadder('{"notRungs":123}')).toBeNull();
  });
});
