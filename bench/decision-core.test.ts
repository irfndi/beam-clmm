import { describe, it, expect } from "vitest";
import {
  DEFAULT_COST_MODEL,
  costModelFromConfig,
  estimateEnterCostUsd,
  estimateRebalanceCostUsd,
  estimateRoundTripCostUsd,
} from "../engine/cost-model.js";
import {
  estimateExpectedIlFraction,
  evaluateEntryEconomics,
  evaluateRebalanceEconomics,
  minimumViableSizeUsd,
} from "../engine/unit-economics.js";
import { classifyRegime } from "../engine/core/regime.js";
import {
  signal,
  type PoolFacts,
  type PortfolioFacts,
  type RuleSignal,
} from "../engine/core/rule.js";
import { resolveDecision } from "../engine/core/resolver.js";
import { buildPolicy } from "../engine/core/policy.js";
import { decide } from "../engine/core/decide.js";
import {
  buildDecisionJournalRecord,
  compareDecisions,
  compactJson,
} from "../engine/decision-journal.js";
import { runDecisionShadow } from "../engine/decision-shadow.js";
import { defaultAppConfig, makePool, makeBinArray } from "./helpers.js";
import type { PoolMetrics } from "../engine/types.js";

// ─── Cost model ──────────────────────────────────────────────────────────────

describe("cost model", () => {
  it("prices a Base L2 entry in cents, not dollars", () => {
    const enter = estimateEnterCostUsd(500, DEFAULT_COST_MODEL);
    expect(enter.gasUsd).toBeGreaterThan(0);
    expect(enter.gasUsd).toBeLessThan(0.1);
    expect(enter.totalUsd).toBeGreaterThan(0.05);
    expect(enter.totalUsd).toBeLessThan(1);
  });

  it("prices a round trip above either leg and scales with size", () => {
    const small = estimateRoundTripCostUsd(20, DEFAULT_COST_MODEL);
    const large = estimateRoundTripCostUsd(2_000, DEFAULT_COST_MODEL);
    expect(small.totalUsd).toBeGreaterThan(estimateEnterCostUsd(20, DEFAULT_COST_MODEL).totalUsd);
    expect(large.totalUsd).toBeGreaterThan(small.totalUsd);
  });

  it("keeps a $17 round trip under ten cents", () => {
    const cost = estimateRoundTripCostUsd(17, DEFAULT_COST_MODEL);
    expect(cost.totalUsd).toBeLessThan(0.1);
    expect(cost.totalUsd).toBeGreaterThan(0.01);
  });

  it("prices a rebalance without the old $18.85 constant", () => {
    const cost = estimateRebalanceCostUsd(500, DEFAULT_COST_MODEL);
    expect(cost.totalUsd).toBeLessThan(1);
  });

  it("resolves config overrides and keeps sane fallbacks", () => {
    const model = costModelFromConfig({
      gasPriceGwei: 0.1,
      nativePriceUsd: 2_000,
      swapFeeBps: 30,
      slippageBps: 0,
      l1DataFeeUsd: 0,
    });
    expect(model.gasPriceGwei).toBe(0.1);
    expect(model.swapFeeBps).toBe(30);
    expect(model.slippageBps).toBe(0);
    expect(model.l1DataFeeUsd).toBe(0);

    const fallback = costModelFromConfig({ nativePriceUsd: 0 });
    expect(fallback.nativePriceUsd).toBe(DEFAULT_COST_MODEL.nativePriceUsd);
    expect(fallback.gasPriceGwei).toBe(DEFAULT_COST_MODEL.gasPriceGwei);
  });
});

// ─── Unit economics ──────────────────────────────────────────────────────────

const LIVE_POOL = {
  poolTvlUsd: 5_000_000,
  poolFees24hUsd: 3_000,
  concentrationFactor: 2,
  inRangeFraction: 0.85,
};

describe("unit economics", () => {
  it("rejects the observed live shape: $17 for two hours", () => {
    const econ = evaluateEntryEconomics({
      positionSizeUsd: 17,
      ...LIVE_POOL,
      horizonDays: 2 / 24,
      dailyMovePct: 1.5,
      roundTripCostUsd: estimateRoundTripCostUsd(17, DEFAULT_COST_MODEL).totalUsd,
    });
    expect(econ.approved).toBe(false);
    expect(econ.evUsd).toBeLessThan(0);
    expect(econ.minViableSizeUsd).toBeGreaterThan(17);
  });

  it("accepts a $500 position held a week in a paying pool", () => {
    const econ = evaluateEntryEconomics({
      positionSizeUsd: 500,
      ...LIVE_POOL,
      horizonDays: 7,
      dailyMovePct: 1.5,
      roundTripCostUsd: estimateRoundTripCostUsd(500, DEFAULT_COST_MODEL).totalUsd,
    });
    expect(econ.approved).toBe(true);
    expect(econ.evUsd).toBeGreaterThan(0);
  });

  it("computes a break-even size that shrinks with a longer horizon", () => {
    const short = minimumViableSizeUsd({
      ...LIVE_POOL,
      horizonDays: 2,
      roundTripCostUsd: 0.1,
    });
    const long = minimumViableSizeUsd({
      ...LIVE_POOL,
      horizonDays: 7,
      roundTripCostUsd: 0.1,
    });
    expect(short).toBeGreaterThan(long);
    expect(long).toBeCloseTo(0.1 / (0.0006 * 2 * 0.85 * 7), 4);
  });

  it("returns an infinite break-even for a pool that pays nothing", () => {
    const size = minimumViableSizeUsd({
      poolTvlUsd: 1_000_000,
      poolFees24hUsd: 0,
      horizonDays: 7,
      concentrationFactor: 1,
      inRangeFraction: 1,
      roundTripCostUsd: 0.1,
    });
    expect(size).toBe(Number.POSITIVE_INFINITY);
  });

  it("prices IL symmetrically around the entry", () => {
    expect(estimateExpectedIlFraction(0, 7)).toBe(0);
    const up = estimateExpectedIlFraction(2, 7);
    expect(up).toBeGreaterThan(0);
    expect(up).toBeLessThan(0.01);
  });

  it("requires a rebalance to earn back its own cost", () => {
    const cheap = evaluateRebalanceEconomics({
      positionValueUsd: 500,
      recoveredYieldPerDayPct: 0.1,
      horizonDays: 1,
      costUsd: 0.02,
    });
    expect(cheap.approved).toBe(true);

    const pointless = evaluateRebalanceEconomics({
      positionValueUsd: 20,
      recoveredYieldPerDayPct: 0.001,
      horizonDays: 1,
      costUsd: 0.05,
    });
    expect(pointless.approved).toBe(false);
  });
});

// ─── Regime ──────────────────────────────────────────────────────────────────

describe("regime classification", () => {
  const base = {
    volatilityStddev: 0.5,
    maxVolatilityStddev: 5,
    netDriftBins: 0,
    tvlVelocity: 0,
    volumeAuthenticity: 0.9,
    volumeAuthenticityKnown: true,
  };

  it("classifies a quiet book as calm", () => {
    expect(classifyRegime(base)).toBe("calm");
  });

  it("classifies a directional move as trending", () => {
    expect(classifyRegime({ ...base, netDriftBins: 12 })).toBe("trending");
  });

  it("classifies high sigma as volatile", () => {
    expect(classifyRegime({ ...base, volatilityStddev: 9 })).toBe("volatile");
  });

  it("lets a TVL flight override every other state", () => {
    expect(classifyRegime({ ...base, tvlVelocity: -0.4, volatilityStddev: 0 })).toBe("degraded");
  });

  it("treats fake volume as degraded", () => {
    expect(classifyRegime({ ...base, volumeAuthenticity: 0.2 })).toBe("degraded");
  });
});

// ─── Resolver ────────────────────────────────────────────────────────────────

function sig(partial: Partial<RuleSignal> & Pick<RuleSignal, "ruleId" | "strength" | "action">) {
  return signal({ ...partial, reason: partial.reason ?? "test" });
}

describe("resolver", () => {
  it("lets a directive beat any vote", () => {
    const resolved = resolveDecision([
      sig({ ruleId: "exit.stop_loss", strength: "directive", action: "EXIT", confidence: 1 }),
      sig({ ruleId: "entry.economics", strength: "vote", action: "ENTER", score: 100 }),
    ]);
    expect(resolved.action).toBe("EXIT");
    expect(resolved.reasons.find((r) => r.ruleId === "exit.stop_loss")?.decisive).toBe(true);
  });

  it("prefers EXIT over REBALANCE when both are directives", () => {
    const resolved = resolveDecision([
      sig({ ruleId: "exit.out_of_range", strength: "directive", action: "REBALANCE" }),
      sig({ ruleId: "exit.tvl_flight", strength: "directive", action: "EXIT" }),
    ]);
    expect(resolved.action).toBe("EXIT");
  });

  it("blocks ENTER when a veto is present even with a large vote", () => {
    const resolved = resolveDecision([
      sig({ ruleId: "guard.unit_economics", strength: "veto", action: "ENTER" }),
      sig({ ruleId: "entry.economics", strength: "vote", action: "ENTER", score: 10 }),
    ]);
    expect(resolved.action).toBe("HOLD");
    expect(resolved.vetoes).toHaveLength(1);
  });

  it("holds when no rule fires", () => {
    expect(resolveDecision([]).action).toBe("HOLD");
  });

  it("is order independent", () => {
    const signals = [
      sig({ ruleId: "a", strength: "vote", action: "ENTER", score: 2 }),
      sig({ ruleId: "b", strength: "vote", action: "REBALANCE", score: 3 }),
    ];
    expect(resolveDecision(signals).action).toBe("REBALANCE");
    expect(resolveDecision([...signals].reverse()).action).toBe("REBALANCE");
  });
});

// ─── Decision core ───────────────────────────────────────────────────────────

const GOOD_POOL: PoolFacts = {
  address: "0xpool",
  tokenXSymbol: "WETH",
  tokenYSymbol: "USDC",
  tvlUsd: 5_000_000,
  volume24hUsd: 2_000_000,
  fees24hUsd: 3_000,
  currentPrice: 3_000,
  activeBinId: 0,
  binStep: 10,
  feeIlRatio: 3,
  volumeAuthenticity: 0.95,
  binUtilization: 0.6,
  tvlVelocity: 0.01,
  feeIlRatioKnown: true,
  volumeAuthenticityKnown: true,
  binUtilizationKnown: true,
  farmAprPct: null,
  observedRangePct: null,
  volatilityStddev: 0.4,
  netDriftBins: 0.5,
};

const NO_POSITION_PORTFOLIO: PortfolioFacts = {
  valueUsd: 10_000,
  openPositions: 1,
  poolPositions: 0,
  poolExposureUsd: 0,
  dailyDrawdownPct: 0,
  stopLossBreachCycles: 0,
  trailingStopBreachCycles: 0,
};

function baseDecideInput(overrides: Partial<Parameters<typeof decide>[0]> = {}) {
  const config = defaultAppConfig();
  return {
    now: 1_700_000_000_000,
    pool: GOOD_POOL,
    position: null,
    portfolio: NO_POSITION_PORTFOLIO,
    costs: DEFAULT_COST_MODEL,
    policy: buildPolicy(config),
    candidateSizeUsd: 500,
    ...overrides,
  };
}

describe("decision core", () => {
  it("enters a paying pool with a positive net EV", () => {
    const decision = decide(baseDecideInput());
    expect(decision.action).toBe("ENTER");
    expect(decision.economics.evUsd).toBeGreaterThan(0);
    expect(decision.regime).toBe("calm");
    expect(decision.reasons.some((r) => r.ruleId === "entry.economics" && r.decisive)).toBe(true);
  });

  it("refuses a dead pool", () => {
    const decision = decide(
      baseDecideInput({
        pool: { ...GOOD_POOL, tvlUsd: 0, fees24hUsd: 0, volume24hUsd: 0 },
      }),
    );
    expect(decision.action).toBe("HOLD");
    expect(decision.vetoes.length).toBeGreaterThan(0);
  });

  it("refuses a one-off fee print (19%/day of TVL)", () => {
    const decision = decide(
      baseDecideInput({
        pool: { ...GOOD_POOL, fees24hUsd: 950_000 },
      }),
    );
    expect(decision.action).toBe("HOLD");
    expect(decision.vetoes.some((v) => v.ruleId === "guard.fee_plausibility")).toBe(true);
  });

  it("refuses an entry whose cost exceeds its expected fees", () => {
    const decision = decide(baseDecideInput({ candidateSizeUsd: 17 }));
    expect(decision.action).toBe("HOLD");
    expect(decision.economics.approved).toBe(false);
    expect(decision.vetoes.some((v) => v.ruleId === "guard.unit_economics")).toBe(true);
  });

  it("fires the stop-loss only after the confirmation cycles", () => {
    const position = {
      id: "pos-1",
      depositedUsd: 100,
      currentValueUsd: 80,
      ageMs: 3_600_000,
      outOfRangeMs: 0,
      outOfRangeCycles: 0,
      peakValueUsd: 100,
      feesClaimedUsd: 0,
      rewardsClaimedUsd: 0,
      driftPct: 0.1,
      inRange: true,
    };
    const unconfirmed = decide(
      baseDecideInput({
        position,
        portfolio: { ...NO_POSITION_PORTFOLIO, stopLossBreachCycles: 0 },
      }),
    );
    expect(unconfirmed.action).not.toBe("EXIT");

    const confirmed = decide(
      baseDecideInput({
        position,
        portfolio: { ...NO_POSITION_PORTFOLIO, stopLossBreachCycles: 2 },
      }),
    );
    expect(confirmed.action).toBe("EXIT");
    expect(confirmed.reasons.some((r) => r.ruleId === "exit.stop_loss" && r.decisive)).toBe(true);
  });

  it("disables entries in a volatile regime", () => {
    const decision = decide(baseDecideInput({ pool: { ...GOOD_POOL, volatilityStddev: 9 } }));
    expect(decision.regime).toBe("volatile");
    expect(decision.action).toBe("HOLD");
  });
});

// ─── Journal + shadow ────────────────────────────────────────────────────────

describe("decision journal", () => {
  it("normalises optional values to null", () => {
    const row = buildDecisionJournalRecord({
      id: "j1",
      timestamp: 1,
      cycleId: "c1",
      poolAddress: "0xpool",
      engine: "legacy",
      kind: "suppressed",
      action: "ENTER",
      confidence: 0.5,
      reasoning: "test",
    });
    expect(row.positionId).toBeNull();
    expect(row.evUsd).toBeNull();
    expect(row.factsJson).toBeNull();
  });

  it("truncates oversized facts instead of storing them whole", () => {
    const json = compactJson({ blob: "x".repeat(10_000) }, 100);
    expect(json).not.toBeNull();
    expect(json!.length).toBeLessThanOrEqual(101);
  });

  it("compares actions and confidence", () => {
    expect(
      compareDecisions({ action: "HOLD", confidence: 0.5 }, { action: "HOLD", confidence: 0.55 })
        .agree,
    ).toBe(true);
    expect(
      compareDecisions({ action: "ENTER", confidence: 0.5 }, { action: "HOLD", confidence: 0.5 })
        .agree,
    ).toBe(false);
  });
});

describe("shadow runner", () => {
  function shadowInput() {
    const pool = makePool({
      tvlUsd: 5_000_000,
      volume24hUsd: 2_000_000,
      fees24hUsd: 3_000,
    });
    const metrics: PoolMetrics = {
      pool,
      binArray: makeBinArray(),
      tvlVelocity: 0.01,
      feeIlRatio: 3,
      volumeAuthenticity: 0.95,
      binUtilization: 0.6,
      volumeAuthenticityKnown: true,
      feeIlRatioKnown: true,
      binUtilizationKnown: true,
      farmAprPct: null,
    };
    const config = defaultAppConfig({ decisionEngine: "shadow", nativePriceUsd: 3_000 });
    return {
      now: 1_700_000_000_000,
      cycleId: "cycle-1",
      config,
      pool,
      metrics,
      position: null,
      portfolio: {
        valueUsd: 10_000,
        openPositions: 1,
        poolPositions: 0,
        poolExposureUsd: 0,
        dailyDrawdownPct: 0,
        stopLossBreachCycles: 0,
        trailingStopBreachCycles: 0,
      },
      volatilityStddev: 0.4,
      netDriftBins: 0.5,
      observedRangePct: null,
      candidateSizeUsd: 500,
      legacyDecision: {
        action: "ENTER" as const,
        poolAddress: pool.address,
        confidence: 0.8,
        reasoning: "legacy says enter",
        positionSizeUsd: 500,
      },
      riskApproved: true,
      legacyJournalId: "legacy-1",
      shadowJournalId: "rules-1",
    };
  }

  it("journals the legacy decision and a shadow row when armed", () => {
    const out = runDecisionShadow(shadowInput());
    expect(out.legacyRow.engine).toBe("legacy");
    expect(out.legacyRow.kind).toBe("proposed");
    expect(out.shadowRow?.engine).toBe("rules");
    expect(out.shadowRow?.kind).toBe("shadow");
    expect(out.engineDecision.action).toBe("ENTER");
    expect(out.economics?.blocked).toBe(false);
  });

  it("flags a tiny entry as value-destroying", () => {
    const out = runDecisionShadow({ ...shadowInput(), candidateSizeUsd: 17 });
    expect(out.economics?.blocked).toBe(true);
    expect(out.economics?.reason).toContain("Break-even hold");
  });

  it("does not emit a shadow row when the engine is legacy", () => {
    const out = runDecisionShadow({
      ...shadowInput(),
      config: defaultAppConfig({ decisionEngine: "legacy" }),
    });
    expect(out.shadowRow).toBeNull();
  });
});
