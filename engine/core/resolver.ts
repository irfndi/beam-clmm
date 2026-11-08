/**
 * resolver.ts — deterministic arbitration of rule signals.
 *
 * Precedence is deliberate and boring on purpose:
 *   1. directives  — capital protection; the highest-severity one wins (EXIT
 *                    beats REBALANCE beats HOLD/ENTER). A rule bug cannot
 *                    override an exit.
 *   2. vetoes      — remove an action from consideration (an entry block).
 *   3. votes       — weighted preference; highest total wins, HOLD on a tie.
 *
 * The resolver never mutates a signal and never depends on evaluation order
 * for the winner, so parallel evaluation produces exactly the same decision
 * as sequential evaluation.
 */

import type { ActionType } from "../types.js";
import { RULES } from "./rules.js";
import type { RuleSignal, RuleStage, RuleTrace } from "./rule.js";

const ACTION_ORDER: ReadonlyArray<ActionType> = ["ENTER", "REBALANCE", "HOLD", "EXIT"];

const DIRECTIVE_SEVERITY: Readonly<Record<ActionType, number>> = {
  EXIT: 3,
  REBALANCE: 2,
  HOLD: 1,
  ENTER: 0,
};

const STAGE_BY_RULE: ReadonlyMap<string, RuleStage> = new Map(
  RULES.map((rule) => [rule.id, rule.stage]),
);

export interface ResolvedDecision {
  readonly action: ActionType;
  readonly confidence: number;
  readonly reasons: ReadonlyArray<RuleTrace>;
  readonly vetoes: ReadonlyArray<RuleSignal>;
  readonly scores: Readonly<Record<ActionType, number>>;
}

function severity(sig: RuleSignal): number {
  return DIRECTIVE_SEVERITY[sig.action] * 10 + sig.confidence;
}

/** Pick the highest-severity directive; null when the rule set emitted none. */
export function selectDirective(signals: ReadonlyArray<RuleSignal>): RuleSignal | null {
  let best: RuleSignal | null = null;
  for (const sig of signals) {
    if (sig.strength !== "directive") continue;
    if (best === null) {
      best = sig;
      continue;
    }
    const delta = severity(sig) - severity(best);
    if (delta > 0 || (delta === 0 && sig.ruleId < best.ruleId)) best = sig;
  }
  return best;
}

export function resolveDecision(signals: ReadonlyArray<RuleSignal>): ResolvedDecision {
  const directive = selectDirective(signals);
  const vetoes = signals.filter((sig) => sig.strength === "veto");
  const blocked = new Set<ActionType>(vetoes.map((sig) => sig.action));

  const scores: Record<ActionType, number> = { ENTER: 0, REBALANCE: 0, HOLD: 0, EXIT: 0 };
  for (const sig of signals) {
    if (sig.strength !== "vote") continue;
    if (blocked.has(sig.action)) continue;
    scores[sig.action] += sig.score;
  }

  let action: ActionType;
  let confidence: number;
  if (directive !== null) {
    action = directive.action;
    confidence = directive.confidence;
  } else {
    action = "HOLD";
    confidence = 0.4;
    let bestScore = 0;
    for (const candidate of ACTION_ORDER) {
      if (blocked.has(candidate)) continue;
      const score = scores[candidate];
      if (score > bestScore) {
        bestScore = score;
        action = candidate;
      }
    }
    if (bestScore > 0) {
      const totalVote = ACTION_ORDER.reduce((sum, a) => sum + scores[a], 0);
      confidence = Math.min(0.9, 0.5 + (bestScore / Math.max(totalVote, 1e-9)) * 0.4);
    }
  }

  const reasons: ReadonlyArray<RuleTrace> = signals.map((sig) => {
    const decisive =
      directive !== null
        ? sig === directive || (sig.strength === "veto" && sig.action === action)
        : sig.strength === "vote"
          ? sig.action === action
          : sig.strength === "veto" && sig.action !== action
            ? false
            : false;
    return {
      ruleId: sig.ruleId,
      stage: STAGE_BY_RULE.get(sig.ruleId) ?? "guard",
      strength: sig.strength,
      action: sig.action,
      reason: sig.reason,
      decisive,
    };
  });

  return { action, confidence, reasons, vetoes, scores };
}

/** One-line explanation of a resolved decision, for logs and journal rows. */
export function describeDecision(decision: ResolvedDecision): string {
  const decisive = decision.reasons.filter((r) => r.decisive);
  if (decisive.length === 0) return `${decision.action} (no decisive signal)`;
  return `${decision.action} ← ${decisive.map((r) => `${r.ruleId}: ${r.reason}`).join("; ")}`;
}
