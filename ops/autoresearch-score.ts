import type { BacktestResult } from "../engine/types.js";

export interface WinGoal {
  readonly minNetPnlUsd: number;
  readonly maxDrawdownPct: number;
  readonly minRoundTrips: number;
  readonly minFeesUsd: number;
  readonly relativeImproveIfPassed: number;
}

export interface TrialScore {
  readonly netPnlUsd: number;
  readonly maxDrawdownPct: number;
  readonly roundTrips: number;
  readonly totalFeesUsd: number;
  readonly winRate: number;
  readonly sharpeRatio: number;
}

export interface ScoreDecision {
  readonly passedWinGoal: boolean;
  readonly keep: boolean;
  readonly reason: string;
  readonly score: TrialScore;
}

export const DEFAULT_WIN_GOAL: WinGoal = {
  minNetPnlUsd: 5,
  maxDrawdownPct: 0.05,
  minRoundTrips: 0,
  minFeesUsd: 5,
  relativeImproveIfPassed: 1.1,
};

export function scoreFromResult(result: BacktestResult): TrialScore {
  return {
    netPnlUsd: result.netPnlUsd,
    maxDrawdownPct: result.maxDrawdownPct,
    roundTrips: result.roundTrips,
    totalFeesUsd: result.totalFeesUsd,
    winRate: result.winRate,
    sharpeRatio: result.sharpeRatio,
  };
}

export function passesWinGoal(score: TrialScore, goal: WinGoal = DEFAULT_WIN_GOAL): boolean {
  return (
    score.netPnlUsd >= goal.minNetPnlUsd &&
    score.maxDrawdownPct <= goal.maxDrawdownPct &&
    score.roundTrips >= goal.minRoundTrips &&
    score.totalFeesUsd >= goal.minFeesUsd
  );
}

/**
 * Keep/discard vs champion baseline.
 * - Baseline not yet at win goal: first passing trial becomes champion.
 * - Baseline already passing: require relative PnL improvement and floors.
 */
export function decideKeep(input: {
  readonly trial: TrialScore;
  readonly baseline: TrialScore;
  readonly baselinePassedWinGoal: boolean;
  readonly goal?: WinGoal;
}): ScoreDecision {
  const goal = input.goal ?? DEFAULT_WIN_GOAL;
  const passedWinGoal = passesWinGoal(input.trial, goal);
  if (!passedWinGoal) {
    const reasons: string[] = [];
    if (input.trial.netPnlUsd < goal.minNetPnlUsd) {
      reasons.push(`netPnl $${input.trial.netPnlUsd.toFixed(2)} < $${goal.minNetPnlUsd}`);
    }
    if (input.trial.maxDrawdownPct > goal.maxDrawdownPct) {
      reasons.push(
        `DD ${(input.trial.maxDrawdownPct * 100).toFixed(2)}% > ${(goal.maxDrawdownPct * 100).toFixed(0)}%`,
      );
    }
    if (input.trial.roundTrips < goal.minRoundTrips) {
      reasons.push(`roundTrips ${input.trial.roundTrips} < ${goal.minRoundTrips}`);
    }
    if (input.trial.totalFeesUsd < goal.minFeesUsd) {
      reasons.push(`fees $${input.trial.totalFeesUsd.toFixed(2)} < $${goal.minFeesUsd}`);
    }
    return {
      passedWinGoal: false,
      keep: false,
      reason: `discard: ${reasons.join("; ")}`,
      score: input.trial,
    };
  }

  if (!input.baselinePassedWinGoal) {
    return {
      passedWinGoal: true,
      keep: true,
      reason: "keep: first trial to pass win goal",
      score: input.trial,
    };
  }

  const need = input.baseline.netPnlUsd * goal.relativeImproveIfPassed;
  if (input.trial.netPnlUsd >= need) {
    return {
      passedWinGoal: true,
      keep: true,
      reason: `keep: netPnl $${input.trial.netPnlUsd.toFixed(2)} >= $${need.toFixed(2)} (+${((goal.relativeImproveIfPassed - 1) * 100).toFixed(0)}% vs baseline)`,
      score: input.trial,
    };
  }

  return {
    passedWinGoal: true,
    keep: false,
    reason: `discard: passed floors but netPnl $${input.trial.netPnlUsd.toFixed(2)} < $${need.toFixed(2)} vs baseline`,
    score: input.trial,
  };
}
