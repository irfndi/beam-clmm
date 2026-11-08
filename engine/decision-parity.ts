/**
 * decision-parity.ts — measure the rule core against the legacy branch table.
 *
 * The decision journal stores one row per engine per evaluation, keyed by
 * cycle and pool. Pairing those rows answers the only question that matters
 * before `DECISION_ENGINE` changes: where do the two implementations disagree,
 * and in which direction?
 *
 * Direction is the whole point. "agrees 87%" is reassuring; "rules wanted to
 * ENTER 83 pools the legacy gates refused" and "rules wanted to EXIT 12
 * positions the branch table held" are the numbers that decide whether the
 * rule core is ready. This module is pure — the CLI reads rows and prints.
 */

import type { DecisionJournalRecord } from "./decision-journal.js";

export interface ParityCell {
  readonly legacyAction: string;
  readonly rulesAction: string;
  readonly count: number;
  /** Mean (rules − legacy) confidence across the cell's evaluations. */
  readonly meanConfidenceDelta: number;
}

export interface DecisionParityReport {
  readonly pairs: number;
  readonly agreed: number;
  readonly agreementPct: number;
  readonly meanConfidenceDelta: number;
  /** Action pairs, highest count first. */
  readonly cells: ReadonlyArray<ParityCell>;
  /** Rules HOLD against a legacy ENTER/REBALANCE — the vetoes. */
  readonly vetoed: number;
  /** Rules EXIT where legacy would have kept the position. */
  readonly upgradedToExit: number;
  /** Rules ENTER the legacy path never took (advisory, never dispatched). */
  readonly rulesEntries: number;
  /** Rules REBALANCE the legacy path never took (advisory, never dispatched). */
  readonly rulesRebalances: number;
  /** Evaluations with only a legacy row. */
  readonly unpairedLegacy: number;
  /** Evaluations with only a rules row. */
  readonly unpairedRules: number;
  readonly firstTimestamp: number | null;
  readonly lastTimestamp: number | null;
}

interface Group {
  legacy?: DecisionJournalRecord;
  rules?: DecisionJournalRecord;
}

const groupKey = (row: DecisionJournalRecord): string => `${row.cycleId}\u0000${row.poolAddress}`;

/** Latest row wins when an evaluation was written more than once. */
function newer(
  candidate: DecisionJournalRecord,
  current: DecisionJournalRecord | undefined,
): boolean {
  return current === undefined || candidate.timestamp >= current.timestamp;
}

interface Pairing {
  readonly groups: Map<string, Group>;
  readonly firstTimestamp: number | null;
  readonly lastTimestamp: number | null;
}

/** Bucket rows by evaluation; the latest write wins per engine. */
function pairEvaluations(rows: ReadonlyArray<DecisionJournalRecord>): Pairing {
  const groups = new Map<string, Group>();
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const row of rows) {
    if (firstTimestamp === null || row.timestamp < firstTimestamp) firstTimestamp = row.timestamp;
    if (lastTimestamp === null || row.timestamp > lastTimestamp) lastTimestamp = row.timestamp;
    const key = groupKey(row);
    const group = groups.get(key) ?? {};
    if (row.engine === "legacy") {
      if (newer(row, group.legacy)) group.legacy = row;
    } else if (newer(row, group.rules)) {
      group.rules = row;
    }
    groups.set(key, group);
  }
  return { groups, firstTimestamp, lastTimestamp };
}

interface CellAccumulator {
  count: number;
  deltaSum: number;
  readonly legacy: string;
  readonly rules: string;
}

interface Tally {
  pairs: number;
  agreed: number;
  deltaSum: number;
  vetoed: number;
  upgradedToExit: number;
  rulesEntries: number;
  rulesRebalances: number;
  unpairedLegacy: number;
  unpairedRules: number;
  readonly cells: Map<string, CellAccumulator>;
}

/** Count divergences by direction, the numbers that gate a mode switch. */
function countDirection(tally: Tally, legacyAction: string, rulesAction: string): void {
  if (rulesAction === "HOLD" && legacyAction !== "HOLD") tally.vetoed++;
  if (rulesAction === "EXIT" && legacyAction !== "EXIT") tally.upgradedToExit++;
  if (rulesAction === "ENTER" && legacyAction !== "ENTER") tally.rulesEntries++;
  if (rulesAction === "REBALANCE" && legacyAction !== "REBALANCE") tally.rulesRebalances++;
}

function tallyPairs(groups: Map<string, Group>): Tally {
  const cells = new Map<string, CellAccumulator>();
  const tally: Tally = {
    pairs: 0,
    agreed: 0,
    deltaSum: 0,
    vetoed: 0,
    upgradedToExit: 0,
    rulesEntries: 0,
    rulesRebalances: 0,
    unpairedLegacy: 0,
    unpairedRules: 0,
    cells,
  };

  for (const group of groups.values()) {
    const { legacy, rules } = group;
    if (legacy === undefined || rules === undefined) {
      if (legacy !== undefined) tally.unpairedLegacy++;
      if (rules !== undefined) tally.unpairedRules++;
      continue;
    }
    tally.pairs++;
    const delta = rules.confidence - legacy.confidence;
    tally.deltaSum += delta;
    if (rules.action === legacy.action) tally.agreed++;
    countDirection(tally, legacy.action, rules.action);

    const key = `${legacy.action}\u0000${rules.action}`;
    const cell = cells.get(key) ?? {
      count: 0,
      deltaSum: 0,
      legacy: legacy.action,
      rules: rules.action,
    };
    cell.count++;
    cell.deltaSum += delta;
    cells.set(key, cell);
  }
  return tally;
}

export function buildParityReport(
  rows: ReadonlyArray<DecisionJournalRecord>,
): DecisionParityReport {
  const { groups, firstTimestamp, lastTimestamp } = pairEvaluations(rows);
  const tally = tallyPairs(groups);
  const { pairs } = tally;

  return {
    pairs,
    agreed: tally.agreed,
    agreementPct: pairs === 0 ? 0 : (tally.agreed / pairs) * 100,
    meanConfidenceDelta: pairs === 0 ? 0 : tally.deltaSum / pairs,
    cells: [...tally.cells.values()]
      .map((cell) => ({
        legacyAction: cell.legacy,
        rulesAction: cell.rules,
        count: cell.count,
        meanConfidenceDelta: cell.deltaSum / cell.count,
      }))
      .sort((a, b) => b.count - a.count),
    vetoed: tally.vetoed,
    upgradedToExit: tally.upgradedToExit,
    rulesEntries: tally.rulesEntries,
    rulesRebalances: tally.rulesRebalances,
    unpairedLegacy: tally.unpairedLegacy,
    unpairedRules: tally.unpairedRules,
    firstTimestamp,
    lastTimestamp,
  };
}

const signed = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;

/** Render the report as operator-facing lines (no ANSI, no I/O). */
export function formatParityReport(
  report: DecisionParityReport,
  options: { readonly windowLabel: string; readonly truncated: boolean },
): ReadonlyArray<string> {
  const lines: string[] = [];
  lines.push(
    `Decision parity — ${options.windowLabel} (${report.pairs.toLocaleString()} paired evaluations)`,
  );
  if (report.pairs === 0) {
    lines.push(
      "  No paired evaluations yet. Set DECISION_ENGINE=shadow and let the engine run a cycle.",
    );
    return lines;
  }
  lines.push(
    `  agreement ${report.agreementPct.toFixed(1)}%  (${report.agreed.toLocaleString()} / ${report.pairs.toLocaleString()})`,
  );
  lines.push(`  confidence Δ rules − legacy: ${signed(report.meanConfidenceDelta)}`);
  lines.push("  divergences:");
  const divergent = report.cells.filter((cell) => cell.legacyAction !== cell.rulesAction);
  if (divergent.length === 0) {
    lines.push("    none — every paired evaluation agreed on the verb");
  }
  for (const cell of divergent) {
    lines.push(
      `    legacy ${cell.legacyAction.padEnd(9)} → rules ${cell.rulesAction.padEnd(9)} ` +
        `${cell.count.toLocaleString().padStart(6)}  (Δconfidence ${signed(cell.meanConfidenceDelta)})`,
    );
  }
  lines.push(
    `  vetoes ${report.vetoed} · protective exits ${report.upgradedToExit} · ` +
      `rules entries ${report.rulesEntries} · rules rebalances ${report.rulesRebalances}`,
  );
  lines.push("  DECISION_ENGINE=rules dispatches vetoes (HOLD) and protective exits only;");
  lines.push("  rules entries and rebalances are advisory (gates/params live in the legacy path).");
  if (report.unpairedLegacy > 0 || report.unpairedRules > 0) {
    lines.push(
      `  unpaired: ${report.unpairedLegacy} legacy-only, ${report.unpairedRules} rules-only`,
    );
  }
  if (options.truncated) {
    lines.push("  (row limit reached — raise --limit for a wider window)");
  }
  return lines;
}
