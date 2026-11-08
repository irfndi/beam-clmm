/**
 * decision-adoption.ts — what `DECISION_ENGINE=rules` is allowed to change.
 *
 * The rule core returns an action plus the facts and rule traces behind it.
 * Two of its actions can be dispatched from the live cycle without inventing
 * inputs the core does not produce:
 *
 *   - HOLD  → a veto. Cancels a legacy ENTER or REBALANCE.
 *   - EXIT  → a protective close. Needs only the position identity.
 *
 * ENTER is adopted only when the caller supplies an `entry` plan: a size that
 * already passed `engine/entry-gates.ts` plus the caller's I/O gates (token
 * risk, cooldown, wallet state). Without a plan it stays advisory, because
 * dispatching around those gates is how a dead pool gets funded. REBALANCE has
 * no such path — the core produces no range params — so it is always advisory
 * and journaled as a divergence (see `engine/decision-parity.ts`).
 *
 * One asymmetry is deliberate: rules cannot cancel a legacy EXIT. A legacy
 * EXIT is stop-loss / out-of-range / depeg protection, and a rule core that
 * has not seen the same protective facts must never hold a losing position
 * open to win an argument about expected value.
 */

import type { EngineDecision } from "./core/decide.js";
import type { ActionType, AgentDecision } from "./types.js";

export type AdoptionVerdict =
  | "agreed"
  | "vetoed"
  | "exit-upgraded"
  | "protected-exit"
  | "entered-through-gates"
  | "enter-needs-gates"
  | "rebalance-needs-params"
  | "exit-without-position";

export interface AdoptionInput {
  readonly legacy: AgentDecision;
  readonly engine: EngineDecision;
  /**
   * Open position this decision may close. Null when the pool holds none, or
   * holds several and the decision targets none — an ambiguous EXIT would
   * close the wrong row, so it is refused.
   */
  readonly targetPositionId: string | null;
  /**
   * A fully gated entry plan (size in USD) from `evaluateEntryGates` plus the
   * caller's I/O gates. Absent/null means no plan exists and a rules ENTER
   * stays advisory.
   */
  readonly entry?: { readonly positionSizeUsd: number } | null;
}

export interface AdoptionResult {
  readonly decision: AgentDecision;
  readonly adopted: boolean;
  readonly verdict: AdoptionVerdict;
  /** Human-readable reason, safe to log and to show in the journal. */
  readonly detail: string;
}

/**
 * Rebuild the decision with a new verb. `rebalanceParams` and
 * `positionSizeUsd` belong to the verb they were computed for, so they are
 * dropped: an EXIT carrying a stale deposit size is a lie in the audit log.
 */
function rebuild(
  legacy: AgentDecision,
  action: ActionType,
  confidence: number,
  reasoning: string,
  positionId?: string,
  positionSizeUsd?: number,
): AgentDecision {
  return {
    action,
    poolAddress: legacy.poolAddress,
    confidence,
    reasoning,
    ...(positionId !== undefined && { positionId }),
    ...(positionSizeUsd !== undefined && positionSizeUsd > 0 && { positionSizeUsd }),
    ...(legacy.positionMode !== undefined && { positionMode: legacy.positionMode }),
    ...(legacy.tpLadderJson !== undefined && { tpLadderJson: legacy.tpLadderJson }),
    ...(legacy.invalidationStopPrice !== undefined && {
      invalidationStopPrice: legacy.invalidationStopPrice,
    }),
  };
}

/** Decide whether the rule core's action replaces the legacy one. */
export function adoptRuleDecision(input: AdoptionInput): AdoptionResult {
  const { legacy, engine } = input;

  if (engine.action === legacy.action) {
    return {
      decision: legacy,
      adopted: false,
      verdict: "agreed",
      detail: `rule core agrees on ${engine.action}`,
    };
  }

  if (legacy.action === "EXIT") {
    return {
      decision: legacy,
      adopted: false,
      verdict: "protected-exit",
      detail: "legacy EXIT is protective — rules cannot cancel it",
    };
  }

  if (engine.action === "ENTER") {
    const plan = input.entry ?? null;
    if (plan === null || plan.positionSizeUsd <= 0) {
      return {
        decision: legacy,
        adopted: false,
        verdict: "enter-needs-gates",
        detail: "rules ENTER not dispatched — no entry plan cleared the size/risk gates",
      };
    }
    return {
      decision: rebuild(
        legacy,
        "ENTER",
        engine.confidence,
        `[rules] ${engine.reasoning}`,
        undefined,
        plan.positionSizeUsd,
      ),
      adopted: true,
      verdict: "entered-through-gates",
      detail: `rules ENTER $${plan.positionSizeUsd.toFixed(
        0,
      )} dispatched — entry gates and risk tail still run`,
    };
  }

  if (engine.action === "REBALANCE") {
    return {
      decision: legacy,
      adopted: false,
      verdict: "rebalance-needs-params",
      detail: "rules REBALANCE not dispatched — the rule core does not produce range params",
    };
  }

  if (engine.action === "EXIT") {
    if (input.targetPositionId === null) {
      return {
        decision: legacy,
        adopted: false,
        verdict: "exit-without-position",
        detail: "rules EXIT skipped — no unambiguous open position to close",
      };
    }
    return {
      decision: rebuild(
        legacy,
        "EXIT",
        engine.confidence,
        `[rules] ${engine.reasoning}`,
        input.targetPositionId,
      ),
      adopted: true,
      verdict: "exit-upgraded",
      detail: `rules EXIT overrides legacy ${legacy.action}`,
    };
  }

  // Only HOLD remains: every other ActionType returned above.
  return {
    decision: rebuild(legacy, "HOLD", engine.confidence, `[rules] ${engine.reasoning}`),
    adopted: true,
    verdict: "vetoed",
    detail: `rules HOLD suppresses legacy ${legacy.action}`,
  };
}
