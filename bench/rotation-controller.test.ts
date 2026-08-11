import { describe, expect, test } from "vitest";
import {
  assessImpaired,
  estimateNetFeeVelocityUsdPerDay,
  evaluateRotation,
  observeRotationPair,
  rotationPairKey,
  switchingCostUsd,
  type Challenger,
  type RotationConfig,
  type Seat,
} from "../engine/rotation-controller.js";

function makeSeat(over: Partial<Seat> = {}): Seat {
  return {
    pool: "seat-A",
    apr: 30,
    feeDensity: 10,
    fees24hUsd: 100,
    positionShare: 0.5,
    expectedInRangePct: 80,
    costsPerDayUsd: 5,
    ...over,
  };
}

// Net velocity = 120 x 0.6 x 0.9 - 4 = 60.8 USD/day.
function makeChallenger(over: Partial<Challenger> = {}): Challenger {
  return {
    pool: "chal-B",
    apr: 55,
    feeDensity: 14,
    fees24hUsd: 120,
    positionShare: 0.6,
    expectedInRangePct: 90,
    costsPerDayUsd: 4,
    admissible: true,
    ...over,
  };
}

function makeCfg(over: Partial<RotationConfig> = {}): RotationConfig {
  return {
    minSuperiorityPct: 25,
    minAprLeadPct: 20,
    minFeeDensityLeadPct: 15,
    requiredConfirmations: 2,
    minChallengerNetFeesUsdPerDay: 10,
    switchingCostUsd: 5,
    ...over,
  };
}

// Default fixture pair: incumbent net = 100 x 0.5 x 0.8 - 5 = 35,
// challenger net = 60.8, superiority need 43.75, apr need 50, density need 11.5.
function confirmed(): Map<string, number> {
  return new Map([["seat-A|chal-B", 2]]);
}

describe("estimateNetFeeVelocityUsdPerDay", () => {
  test("fees x share x in-range minus per-day costs", () => {
    expect(estimateNetFeeVelocityUsdPerDay(100, 0.5, 80, 5)).toBeCloseTo(35, 10);
  });

  test("full share and in-range yields fees minus costs", () => {
    expect(estimateNetFeeVelocityUsdPerDay(100, 1, 100, 10)).toBe(90);
  });

  test("costs exceeding fees yields a negative net velocity", () => {
    expect(estimateNetFeeVelocityUsdPerDay(50, 0.5, 80, 30)).toBe(-10);
  });

  test("zero share yields exactly negative per-day costs", () => {
    expect(estimateNetFeeVelocityUsdPerDay(100, 0, 80, 5)).toBe(-5);
  });
});

describe("switchingCostUsd", () => {
  test("sums all five cost components", () => {
    expect(switchingCostUsd(2, 3, 4, 5, 6)).toBe(20);
  });

  test("zero components sum to zero", () => {
    expect(switchingCostUsd(0, 0, 0, 0, 0)).toBe(0);
  });
});

describe("rotationPairKey", () => {
  test("uses exit|enter pipe format", () => {
    expect(rotationPairKey("pool-1", "pool-2")).toBe("pool-1|pool-2");
  });
});

describe("observeRotationPair", () => {
  test("superior increments an absent key from 0 to 1", () => {
    const next = observeRotationPair("A", "B", true, new Map(), 2);
    expect(next.get("A|B")).toBe(1);
  });

  test("superior increments an existing counter", () => {
    const next = observeRotationPair("A", "B", true, new Map([["A|B", 1]]), 2);
    expect(next.get("A|B")).toBe(2);
  });

  test("not-superior resets the counter to 0", () => {
    const next = observeRotationPair("A", "B", false, new Map([["A|B", 1]]), 2);
    expect(next.get("A|B")).toBe(0);
  });

  test("a not-superior observation breaks a two-observation streak", () => {
    const next = observeRotationPair("A", "B", false, new Map([["A|B", 2]]), 2);
    expect(next.get("A|B")).toBe(0);
  });

  test("counter caps at required confirmations", () => {
    const next = observeRotationPair("A", "B", true, new Map([["A|B", 2]]), 2);
    expect(next.get("A|B")).toBe(2);
  });

  test("required=0 still records confirmations (cap floors at 1)", () => {
    const next = observeRotationPair("A", "B", true, new Map(), 0);
    expect(next.get("A|B")).toBe(1);
  });

  test("is pure: returns a new map, leaves the input untouched, preserves unrelated keys", () => {
    const input = new Map([["C|D", 1]]);
    const next = observeRotationPair("A", "B", true, input, 2);
    expect(next).not.toBe(input);
    expect(input.has("A|B")).toBe(false);
    expect(input.get("C|D")).toBe(1);
    expect(next.get("C|D")).toBe(1);
  });
});

describe("evaluateRotation", () => {
  test("holds when there are no candidates", () => {
    const d = evaluateRotation([makeSeat()], [], makeCfg(), new Map());
    expect(d.action).toBe("hold");
    if (d.action === "hold") expect(d.reason).toContain("no rotation candidates");
  });

  test("holds when the challenger is not admissible (rule 9)", () => {
    const d = evaluateRotation([makeSeat()], [makeChallenger({ admissible: false })], makeCfg(), confirmed());
    expect(d.action).toBe("hold");
    if (d.action === "hold") expect(d.reason).toContain("not admissible");
  });

  test("holds when challenger net fees are below the config floor", () => {
    const weak = makeChallenger({ fees24hUsd: 10, costsPerDayUsd: 4 }); // net = 10 x 0.6 x 0.9 - 4 = 1.4
    const d = evaluateRotation([makeSeat()], [weak], makeCfg(), confirmed());
    expect(d.action).toBe("hold");
    if (d.action === "hold") {
      expect(d.reason).toContain("below $10.00/day floor");
      expect(d.reason).toContain("$1.40/day");
    }
  });

  test("holds when net fee velocity superiority is insufficient (rule 7)", () => {
    const below = makeChallenger({ fees24hUsd: 80, costsPerDayUsd: 4 }); // net = 80 x 0.6 x 0.9 - 4 = 39.2 < 43.75 need, > 10 floor
    const d = evaluateRotation([makeSeat()], [below], makeCfg(), confirmed());
    expect(d.action).toBe("hold");
    if (d.action === "hold") {
      expect(d.reason).toContain("net fee velocity $39.20/day below");
      expect(d.reason).toContain("x 1.25");
    }
  });

  test("holds when APR lead is insufficient", () => {
    const lowApr = makeChallenger({ apr: 45 }); // lead 15pp < 20pp
    const d = evaluateRotation([makeSeat()], [lowApr], makeCfg(), confirmed());
    expect(d.action).toBe("hold");
    if (d.action === "hold") {
      expect(d.reason).toContain("apr 45.00% below incumbent");
      expect(d.reason).toContain("+ 20pp");
    }
  });

  test("holds when fee density lead is insufficient", () => {
    const lowDensity = makeChallenger({ feeDensity: 11 }); // 11 < 10 x 1.15 = 11.5
    const d = evaluateRotation([makeSeat()], [lowDensity], makeCfg(), confirmed());
    expect(d.action).toBe("hold");
    if (d.action === "hold") expect(d.reason).toContain("fee density 11.00 below incumbent");
  });

  test("holds on insufficient confirmations for a fully-qualified challenger (rule 9)", () => {
    const d = evaluateRotation([makeSeat()], [makeChallenger()], makeCfg(), new Map());
    expect(d.action).toBe("hold");
    if (d.action === "hold") {
      expect(d.reason).toContain("insufficient confirmations for seat-A|chal-B");
      expect(d.reason).toContain("(0.00/2)");
    }
  });

  test("holds with 1 of 2 required confirmations", () => {
    const one = new Map([["seat-A|chal-B", 1]]);
    const d = evaluateRotation([makeSeat()], [makeChallenger()], makeCfg(), one);
    expect(d.action).toBe("hold");
    if (d.action === "hold") expect(d.reason).toContain("(1.00/2)");
  });

  test("rotates when every gate passes with required confirmations", () => {
    const d = evaluateRotation([makeSeat()], [makeChallenger()], makeCfg(), confirmed());
    expect(d).toEqual({
      action: "rotate",
      exitPool: "seat-A",
      enterPool: "chal-B",
      reason: expect.stringContaining("superior to 'seat-A'"),
    });
  });

  test("superiority gate is inclusive at the exact boundary (candNet == incumbent x 1.25)", () => {
    const seat = makeSeat(); // incumbent net 35, need 43.75
    const boundary = makeChallenger({ fees24hUsd: 100, positionShare: 0.5, expectedInRangePct: 90, costsPerDayUsd: 1.25 }); // net 43.75
    const d = evaluateRotation([seat], [boundary], makeCfg(), confirmed());
    expect(d.action).toBe("rotate");
  });

  test("default thresholds apply when optional config fields are omitted", () => {
    const cfg = { minChallengerNetFeesUsdPerDay: 10, switchingCostUsd: 5 };
    const lowApr = makeChallenger({ apr: 45 }); // lead 15pp < default 20pp
    const d = evaluateRotation([makeSeat()], [lowApr], cfg, confirmed());
    expect(d.action).toBe("hold");
    if (d.action === "hold") expect(d.reason).toContain("+ 20pp");
  });

  test("rotates for the seat with the largest net-velocity margin", () => {
    const weakSeat = makeSeat({ pool: "seat-weak", fees24hUsd: 50, costsPerDayUsd: 10 }); // net = 50 x 0.5 x 0.8 - 10 = 10
    const strongSeat = makeSeat({ pool: "seat-strong" }); // net 35
    const conf = new Map([
      ["seat-weak|chal-B", 2],
      ["seat-strong|chal-B", 2],
    ]);
    const d = evaluateRotation([strongSeat, weakSeat], [makeChallenger()], makeCfg(), conf);
    expect(d).toEqual({
      action: "rotate",
      exitPool: "seat-weak", // margin 60.8 - 10 = 50.8 beats 60.8 - 35 = 25.8
      enterPool: "chal-B",
      reason: expect.any(String),
    });
  });

  test("tie-breaks equal margins by higher APR lead", () => {
    const conf = new Map([
      ["seat-A|chal-B1", 2],
      ["seat-A|chal-B2", 2],
    ]);
    const challengers = [
      makeChallenger({ pool: "chal-B1", apr: 55 }),
      makeChallenger({ pool: "chal-B2", apr: 60 }),
    ];
    const d = evaluateRotation([makeSeat()], challengers, makeCfg(), conf);
    expect(d.action).toBe("rotate");
    if (d.action === "rotate") expect(d.enterPool).toBe("chal-B2");
  });

  test("tie-breaks equal margins and APR by pair key (deterministic)", () => {
    const conf = new Map([
      ["seat-A|chal-B1", 2],
      ["seat-A|chal-B2", 2],
    ]);
    // Same margin (60.8) and APR (55): the final deterministic tie-break picks
    // the higher pair key (">" comparison in betterCandidate).
    const challengers = [
      makeChallenger({ pool: "chal-B2", apr: 55 }),
      makeChallenger({ pool: "chal-B1", apr: 55 }),
    ];
    const d = evaluateRotation([makeSeat()], challengers, makeCfg(), conf);
    expect(d.action).toBe("rotate");
    if (d.action === "rotate") expect(d.enterPool).toBe("chal-B2");
  });

  test("skips a challenger that targets the seat's own pool", () => {
    const d = evaluateRotation([makeSeat()], [makeChallenger({ pool: "seat-A" })], makeCfg(), confirmed());
    expect(d).toEqual({ action: "hold", reason: expect.stringContaining("no rotation candidates") });
  });

  test("rotates to a valid challenger when a same-pool challenger is also present", () => {
    const d = evaluateRotation([makeSeat()], [makeChallenger({ pool: "seat-A" }), makeChallenger()], makeCfg(), confirmed());
    expect(d.action).toBe("rotate");
    if (d.action === "rotate") expect(d.enterPool).toBe("chal-B");
  });

  test("handles a negative incumbent net velocity (relative gate trivially satisfied)", () => {
    const lossySeat = makeSeat({ costsPerDayUsd: 100 }); // net = 40 - 100 = -60
    const d = evaluateRotation([lossySeat], [makeChallenger()], makeCfg(), confirmed());
    expect(d.action).toBe("rotate");
    if (d.action === "rotate") expect(d.exitPool).toBe("seat-A");
  });

  test("confirmations for the wrong pair do not count", () => {
    const conf = new Map([
      ["chal-B|seat-A", 2], // reversed direction
      ["other|other", 2],
    ]);
    const d = evaluateRotation([makeSeat()], [makeChallenger()], makeCfg(), conf);
    expect(d.action).toBe("hold");
    if (d.action === "hold") expect(d.reason).toContain("insufficient confirmations");
  });

  test("full cycle: two superior observations rotate, one bad observation resets", () => {
    const challengers = [makeChallenger()];
    let conf = new Map<string, number>();
    conf = observeRotationPair("seat-A", "chal-B", true, conf, 2);
    conf = observeRotationPair("seat-A", "chal-B", true, conf, 2);
    expect(evaluateRotation([makeSeat()], challengers, makeCfg(), conf).action).toBe("rotate");
    conf = observeRotationPair("seat-A", "chal-B", false, conf, 2);
    const after = evaluateRotation([makeSeat()], challengers, makeCfg(), conf);
    expect(after.action).toBe("hold");
    if (after.action === "hold") expect(after.reason).toContain("(0.00/2)");
  });
});

describe("assessImpaired", () => {
  const cfg = makeCfg();

  test("holds when price is within tolerance", () => {
    const r = assessImpaired(makeSeat(), 10, 500, 0, 0, cfg);
    expect(r).toMatchObject({ impaired: false, action: "hold" });
    expect(r.reason).toContain("price within tolerance (10.00%");
  });

  test("holds a short excursion with plausible re-entry", () => {
    const r = assessImpaired(makeSeat(), 10, 500, 5, 0, cfg);
    expect(r).toMatchObject({ impaired: false, action: "hold" });
    expect(r.reason).toContain("re-entry plausible in ~2.00 days");
  });

  test("holds an excursion beyond tolerance when re-entry is fast", () => {
    const r = assessImpaired(makeSeat(), 40, 500, 20, 0, cfg);
    expect(r).toMatchObject({ impaired: false, action: "hold" });
    expect(r.reason).toContain("re-entry plausible in ~2.00 days");
  });

  test("boundary: exactly 25% from range is still a short excursion", () => {
    const r = assessImpaired(makeSeat(), 25, 500, 0, 0, cfg);
    expect(r.impaired).toBe(false);
  });

  test("just past 25% with no re-entry is impaired", () => {
    const r = assessImpaired(makeSeat(), 25.01, 500, 0, 0, cfg);
    expect(r.impaired).toBe(true);
  });

  test("zero velocity at large distance is impaired", () => {
    const r = assessImpaired(makeSeat(), 100, 500, 0, 0, cfg);
    expect(r.impaired).toBe(true);
  });

  test("negative velocity (price moving away) is impaired", () => {
    const r = assessImpaired(makeSeat(), 100, 500, -10, 0, cfg);
    expect(r.impaired).toBe(true);
  });

  test("impaired with no superior challenger and uneconomical intervention holds", () => {
    // forgone = 100 x 7 (capped horizon) = 700; rerange 1000 - 0 = 1000; no challenger.
    const r = assessImpaired(makeSeat(), 60, 1000, 1, 0, cfg);
    expect(r).toMatchObject({ impaired: true, action: "hold" });
    expect(r.reason).toContain("intervention uneconomical");
  });

  test("reranges when forgone-fee opportunity cost exceeds rerange cost", () => {
    const r = assessImpaired(makeSeat(), 60, 500, 1, 0, cfg);
    expect(r).toMatchObject({ impaired: true, action: "rerange" });
    expect(r.reason).toContain("opportunity cost $700.00 exceeds rerange cost $500.00");
  });

  test("accumulated fees offset the rerange cost", () => {
    // Without the offset: 700 < 1000 -> hold. With 400 accumulated: 700 > 600 -> rerange.
    const r = assessImpaired(makeSeat(), 60, 1000, 1, 400, cfg);
    expect(r).toMatchObject({ impaired: true, action: "rerange" });
    expect(r.reason).toContain("exceeds rerange cost $600.00");
  });

  test("exits when impaired, a superior challenger exists, and switching pays for itself", () => {
    const r = assessImpaired(makeSeat(), 60, 10, 1, 0, cfg, true);
    expect(r).toMatchObject({ impaired: true, action: "exit" });
    expect(r.reason).toContain("superior challenger available");
  });

  test("fails closed: impaired with superior challenger but uneconomical switch holds", () => {
    const r = assessImpaired(makeSeat(), 60, 1000, 1, 0, { ...cfg, switchingCostUsd: 800 }, true);
    expect(r.action).not.toBe("exit");
    expect(r).toMatchObject({ impaired: true, action: "hold" });
  });

  test("fails closed: impaired with a superior challenger never exits without the flag", () => {
    const r = assessImpaired(makeSeat(), 60, 10, 1, 0, cfg);
    expect(r.action).not.toBe("exit");
  });

  test("forgone-fee estimate is capped at the opportunity horizon", () => {
    // 10000% away at 1%/day -> daysToReentry 10000, capped at 7 -> forgone 700.
    const r = assessImpaired(makeSeat(), 10000, 500, 1, 0, cfg);
    expect(r).toMatchObject({ impaired: true, action: "rerange" });
    expect(r.reason).toContain("opportunity cost $700.00");
  });

  test("works with a config that omits the optional threshold fields", () => {
    const minimal = { minChallengerNetFeesUsdPerDay: 10, switchingCostUsd: 5 };
    const r = assessImpaired(makeSeat(), 60, 500, 1, 0, minimal);
    expect(r.action).toBe("rerange");
  });
});
