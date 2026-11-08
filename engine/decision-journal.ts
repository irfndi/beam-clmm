/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */
/**
 * decision-journal.ts — the honest record of why the engine did something.
 *
 * `audit` answers "what happened" and is an execution log: it is written from
 * the execution paths and a row can mean a proposal, a rejection or a real
 * transaction. That ambiguity is why the live DB holds 87k ENTER rows for 152
 * executions. This journal is different on purpose: one row per DECISION
 * EVALUATION, tagged with its kind (proposed / suppressed / executed / shadow),
 * the facts it saw, the rule traces that fired, and the EV it computed.
 *
 * The row is what makes rule attribution possible: join `position_id` and
 * timestamps to `position_events` and you can score each rule by the PnL of
 * the decisions it drove. Without it, "improve the strategy" is guesswork.
 *
 * Pure: this module builds and compares records, the DB layer stores them.
 */

/** Which decision implementation produced the row. */
export type DecisionEngine = "legacy" | "rules";

/**
 * - `proposed`   — evaluated and approved by risk, awaiting execution
 * - `suppressed` — evaluated but blocked by a gate (never reached the chain)
 * - `executed`   — an execution path actually ran
 * - `shadow`     — computed alongside the live path, never acted on
 */
export type DecisionJournalKind = "proposed" | "suppressed" | "executed" | "shadow";

export interface DecisionJournalRecord {
  readonly id: string;
  readonly timestamp: number;
  readonly cycleId: string;
  readonly poolAddress: string;
  readonly positionId: string | null;
  readonly engine: DecisionEngine;
  readonly kind: DecisionJournalKind;
  readonly action: string;
  readonly confidence: number;
  readonly reasoning: string;
  /** Net expected value of the decision, USD. Null when not computed. */
  readonly evUsd: number | null;
  /** Execution cost the EV was measured against, USD. Null when not computed. */
  readonly costUsd: number | null;
  /** Break-even position size for this pool/horizon, USD. Null when not computed. */
  readonly minSizeUsd: number | null;
  /** Classified market regime at decision time. Null when not classified. */
  readonly regime: string | null;
  /** Compact JSON digest of the facts the decision saw. */
  readonly factsJson: string | null;
  /** Compact JSON array of rule traces (id, kind, reason, score). */
  readonly signalsJson: string | null;
  /** Compact JSON of the full decision. Null for legacy rows. */
  readonly decisionJson: string | null;
}

export interface DecisionJournalInput {
  readonly id: string;
  readonly timestamp: number;
  readonly cycleId: string;
  readonly poolAddress: string;
  readonly positionId?: string | null;
  readonly engine: DecisionEngine;
  readonly kind: DecisionJournalKind;
  readonly action: string;
  readonly confidence: number;
  readonly reasoning: string;
  readonly evUsd?: number | null;
  readonly costUsd?: number | null;
  readonly minSizeUsd?: number | null;
  readonly regime?: string | null;
  readonly facts?: Readonly<Record<string, unknown>> | null;
  readonly signals?: ReadonlyArray<unknown> | null;
  readonly decision?: Readonly<Record<string, unknown>> | null;
}

/** JSON with a hard cap so a malformed facts object cannot bloat the DB. */
export function compactJson(value: unknown, maxChars = 4_000): string | null {
  if (value === undefined || value === null) return null;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return null;
    return json.length <= maxChars ? json : `${json.slice(0, maxChars)}…`;
  } catch {
    return null;
  }
}

/** Build a journal record, normalising optional fields to null. */
export function buildDecisionJournalRecord(input: DecisionJournalInput): DecisionJournalRecord {
  return {
    id: input.id,
    timestamp: input.timestamp,
    cycleId: input.cycleId,
    poolAddress: input.poolAddress,
    positionId: input.positionId ?? null,
    engine: input.engine,
    kind: input.kind,
    action: input.action,
    confidence: Number.isFinite(input.confidence) ? input.confidence : 0,
    reasoning: input.reasoning,
    evUsd: finiteOrNull(input.evUsd),
    costUsd: finiteOrNull(input.costUsd),
    minSizeUsd: finiteOrNull(input.minSizeUsd),
    regime: input.regime ?? null,
    factsJson: compactJson(input.facts),
    signalsJson: compactJson(input.signals),
    decisionJson: compactJson(input.decision),
  };
}

function finiteOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? value : null;
}

export interface DecisionComparison {
  readonly agree: boolean;
  readonly legacyAction: string;
  readonly rulesAction: string;
  readonly summary: string;
}

/**
 * Compare the live decision with the shadow decision. Agreement is action
 * equality plus confidence within 0.1 — a shadow that agrees on the verb but
 * disagrees wildly on conviction is still a behaviour change worth seeing.
 */
export function compareDecisions(
  legacy: { readonly action: string; readonly confidence: number },
  rules: { readonly action: string; readonly confidence: number },
): DecisionComparison {
  const agree =
    legacy.action === rules.action && Math.abs(legacy.confidence - rules.confidence) <= 0.1;
  return {
    agree,
    legacyAction: legacy.action,
    rulesAction: rules.action,
    summary: agree
      ? `agree on ${legacy.action}`
      : `legacy=${legacy.action} rules=${rules.action} (Δconfidence ${(
          rules.confidence - legacy.confidence
        ).toFixed(3)})`,
  };
}
