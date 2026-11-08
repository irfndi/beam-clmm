import { describe, it, expect } from "vitest";
import {
  buildDecisionJournalRecord,
  type DecisionJournalRecord,
} from "../engine/decision-journal.js";
import { buildParityReport, formatParityReport } from "../engine/decision-parity.js";

function row(
  overrides: Partial<DecisionJournalRecord> & {
    readonly engine: "legacy" | "rules";
    readonly action: string;
  },
): DecisionJournalRecord {
  return buildDecisionJournalRecord({
    id: overrides.id ?? `${overrides.engine}-${overrides.cycleId ?? "c1"}-${overrides.action}`,
    timestamp: overrides.timestamp ?? 1_000,
    cycleId: overrides.cycleId ?? "c1",
    poolAddress: overrides.poolAddress ?? "0xpool",
    engine: overrides.engine,
    kind: overrides.kind ?? "shadow",
    action: overrides.action,
    confidence: overrides.confidence ?? 0.5,
    reasoning: overrides.reasoning ?? "test",
  });
}

describe("decision parity", () => {
  it("reports nothing when there are no rows", () => {
    const report = buildParityReport([]);
    expect(report.pairs).toBe(0);
    expect(report.agreementPct).toBe(0);
    expect(report.firstTimestamp).toBeNull();
  });

  it("pairs a legacy and a rules row from the same cycle/pool", () => {
    const report = buildParityReport([
      row({ engine: "legacy", action: "ENTER", confidence: 0.6 }),
      row({ engine: "rules", action: "ENTER", confidence: 0.7 }),
    ]);
    expect(report.pairs).toBe(1);
    expect(report.agreed).toBe(1);
    expect(report.agreementPct).toBe(100);
    expect(report.meanConfidenceDelta).toBeCloseTo(0.1, 6);
    expect(report.cells).toHaveLength(1);
  });

  it("counts a veto and the divergence cell in the direction it happened", () => {
    const report = buildParityReport([
      row({ engine: "legacy", action: "ENTER", cycleId: "c1" }),
      row({ engine: "rules", action: "HOLD", cycleId: "c1" }),
      row({ engine: "legacy", action: "HOLD", cycleId: "c2" }),
      row({ engine: "rules", action: "ENTER", cycleId: "c2" }),
    ]);
    expect(report.pairs).toBe(2);
    expect(report.agreed).toBe(0);
    expect(report.vetoed).toBe(1);
    expect(report.rulesEntries).toBe(1);
    expect(report.cells.map((c) => `${c.legacyAction}>${c.rulesAction}:${c.count}`)).toEqual(
      expect.arrayContaining(["ENTER>HOLD:1", "HOLD>ENTER:1"]),
    );
  });

  it("counts protective exits and rules rebalances separately", () => {
    const report = buildParityReport([
      row({ engine: "legacy", action: "HOLD", cycleId: "c1" }),
      row({ engine: "rules", action: "EXIT", cycleId: "c1" }),
      row({ engine: "legacy", action: "HOLD", cycleId: "c2" }),
      row({ engine: "rules", action: "REBALANCE", cycleId: "c2" }),
    ]);
    expect(report.upgradedToExit).toBe(1);
    expect(report.rulesRebalances).toBe(1);
    expect(report.vetoed).toBe(0);
  });

  it("does not pair rows from different pools or cycles", () => {
    const report = buildParityReport([
      row({ engine: "legacy", action: "HOLD", cycleId: "c1", poolAddress: "0xa" }),
      row({ engine: "rules", action: "HOLD", cycleId: "c1", poolAddress: "0xb" }),
      row({ engine: "legacy", action: "HOLD", cycleId: "c2", poolAddress: "0xa" }),
    ]);
    expect(report.pairs).toBe(0);
    expect(report.unpairedLegacy).toBe(2);
    expect(report.unpairedRules).toBe(1);
  });

  it("keeps the latest row when an evaluation was written twice", () => {
    const report = buildParityReport([
      row({ engine: "rules", action: "HOLD", timestamp: 1_000 }),
      row({ engine: "legacy", action: "ENTER", timestamp: 1_000 }),
      row({ engine: "rules", action: "ENTER", timestamp: 2_000 }),
    ]);
    expect(report.pairs).toBe(1);
    expect(report.agreed).toBe(1);
    expect(report.lastTimestamp).toBe(2_000);
  });

  it("formats a human-readable report with the adoption caveat", () => {
    const report = buildParityReport([
      row({ engine: "legacy", action: "ENTER", confidence: 0.6 }),
      row({ engine: "rules", action: "HOLD", confidence: 0.9 }),
    ]);
    const lines = formatParityReport(report, { windowLabel: "last 7d", truncated: false });
    const text = lines.join("\n");
    expect(text).toContain("Decision parity — last 7d");
    expect(text).toContain("agreement 0.0%");
    expect(text).toContain("legacy ENTER     → rules HOLD");
    expect(text).toContain("advisory");
  });

  it("tells the operator what to do when shadow has not run yet", () => {
    const lines = formatParityReport(buildParityReport([]), {
      windowLabel: "last 7d",
      truncated: false,
    });
    expect(lines.join("\n")).toContain("DECISION_ENGINE=shadow");
  });
});
