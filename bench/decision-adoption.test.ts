import { describe, it, expect } from "vitest";
import { adoptRuleDecision } from "../engine/decision-adoption.js";
import type { EngineDecision } from "../engine/core/decide.js";
import type { ActionType, AgentDecision } from "../engine/types.js";

function engineDecision(
  action: ActionType,
  overrides: Partial<EngineDecision> = {},
): EngineDecision {
  return {
    action,
    confidence: 0.8,
    reasoning: "pool pays but costs more than it earns",
    reasons: [],
    vetoes: [],
    regime: "calm",
    policyVersion: "test-policy",
    economics: {
      expectedFeesUsd: 10,
      expectedIlUsd: 2,
      costUsd: 1,
      evUsd: 7,
      minViableSizeUsd: 20,
      breakEvenHoldDays: 1,
      approved: true,
      reason: "positive EV",
    },
    costUsd: 1,
    minSizeUsd: 20,
    horizonDays: 3,
    ...overrides,
  };
}

function legacyDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    action: "ENTER",
    poolAddress: "0xpool",
    confidence: 0.6,
    reasoning: "legacy branch table",
    ...overrides,
  };
}

describe("rule-core adoption", () => {
  it("leaves an agreeing decision untouched, verb and size", () => {
    const legacy = legacyDecision({ positionSizeUsd: 250 });
    const result = adoptRuleDecision({
      legacy,
      engine: engineDecision("ENTER"),
      targetPositionId: null,
    });
    expect(result.adopted).toBe(false);
    expect(result.verdict).toBe("agreed");
    expect(result.decision).toBe(legacy);
    expect(result.decision.positionSizeUsd).toBe(250);
  });

  it("adopts a HOLD veto and drops the entry size", () => {
    const result = adoptRuleDecision({
      legacy: legacyDecision({ positionSizeUsd: 250 }),
      engine: engineDecision("HOLD"),
      targetPositionId: null,
    });
    expect(result.adopted).toBe(true);
    expect(result.verdict).toBe("vetoed");
    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.positionSizeUsd).toBeUndefined();
    expect(result.decision.reasoning).toContain("[rules]");
    expect(result.decision.poolAddress).toBe("0xpool");
  });

  it("drops rebalance params when a veto turns REBALANCE into HOLD", () => {
    const result = adoptRuleDecision({
      legacy: legacyDecision({
        action: "REBALANCE",
        rebalanceParams: { newLowerBinId: 1, newUpperBinId: 9, slippageBps: 50 },
      }),
      engine: engineDecision("HOLD"),
      targetPositionId: "pos-1",
    });
    expect(result.decision.action).toBe("HOLD");
    expect(result.decision.rebalanceParams).toBeUndefined();
  });

  it("never cancels a legacy EXIT, even when rules says HOLD", () => {
    const legacy = legacyDecision({ action: "EXIT" });
    const result = adoptRuleDecision({
      legacy,
      engine: engineDecision("HOLD"),
      targetPositionId: "pos-1",
    });
    expect(result.adopted).toBe(false);
    expect(result.verdict).toBe("protected-exit");
    expect(result.decision).toBe(legacy);
    expect(result.decision.action).toBe("EXIT");
  });

  it("upgrades a legacy HOLD to a protective EXIT on the resolved position", () => {
    const result = adoptRuleDecision({
      legacy: legacyDecision({ action: "HOLD" }),
      engine: engineDecision("EXIT"),
      targetPositionId: "pos-42",
    });
    expect(result.adopted).toBe(true);
    expect(result.verdict).toBe("exit-upgraded");
    expect(result.decision.action).toBe("EXIT");
    expect(result.decision.positionId).toBe("pos-42");
    expect(result.decision.positionSizeUsd).toBeUndefined();
  });

  it("refuses a rules EXIT with no unambiguous position", () => {
    const legacy = legacyDecision({ action: "HOLD" });
    const result = adoptRuleDecision({
      legacy,
      engine: engineDecision("EXIT"),
      targetPositionId: null,
    });
    expect(result.adopted).toBe(false);
    expect(result.verdict).toBe("exit-without-position");
    expect(result.decision).toBe(legacy);
  });

  it("keeps rules ENTER advisory when no gated entry plan exists", () => {
    const legacy = legacyDecision({ action: "HOLD" });
    const result = adoptRuleDecision({
      legacy,
      engine: engineDecision("ENTER"),
      targetPositionId: null,
    });
    expect(result.adopted).toBe(false);
    expect(result.verdict).toBe("enter-needs-gates");
    expect(result.decision).toBe(legacy);
  });

  it("dispatches a rules ENTER that carries a gated size", () => {
    const result = adoptRuleDecision({
      legacy: legacyDecision({ action: "HOLD" }),
      engine: engineDecision("ENTER"),
      targetPositionId: null,
      entry: { positionSizeUsd: 327.5 },
    });
    expect(result.adopted).toBe(true);
    expect(result.verdict).toBe("entered-through-gates");
    expect(result.decision.action).toBe("ENTER");
    expect(result.decision.positionSizeUsd).toBe(327.5);
    expect(result.decision.reasoning).toContain("[rules]");
  });

  it("refuses a zero-sized entry plan", () => {
    const result = adoptRuleDecision({
      legacy: legacyDecision({ action: "HOLD" }),
      engine: engineDecision("ENTER"),
      targetPositionId: null,
      entry: { positionSizeUsd: 0 },
    });
    expect(result.adopted).toBe(false);
    expect(result.verdict).toBe("enter-needs-gates");
  });

  it("keeps rules REBALANCE advisory — the core has no range params", () => {
    const legacy = legacyDecision({ action: "HOLD" });
    const result = adoptRuleDecision({
      legacy,
      engine: engineDecision("REBALANCE"),
      targetPositionId: "pos-1",
    });
    expect(result.adopted).toBe(false);
    expect(result.verdict).toBe("rebalance-needs-params");
    expect(result.decision).toBe(legacy);
  });

  it("carries fallen-angel lifecycle fields onto an adopted EXIT", () => {
    const result = adoptRuleDecision({
      legacy: legacyDecision({
        action: "HOLD",
        positionMode: "fallen-angel",
        tpLadderJson: "[]",
        invalidationStopPrice: 1.5,
      }),
      engine: engineDecision("EXIT"),
      targetPositionId: "pos-7",
    });
    expect(result.decision.positionMode).toBe("fallen-angel");
    expect(result.decision.tpLadderJson).toBe("[]");
    expect(result.decision.invalidationStopPrice).toBe(1.5);
  });
});
