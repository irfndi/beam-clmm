/**
 * Config-only autoresearch runner (Karpathy-style).
 *
 *   bun run autoresearch
 *   bun run autoresearch -- --candidate research/candidates/trial-1.json
 *   bun run autoresearch -- --days 7 --pool synthetic-demo
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateMockHistory, runBacktestFromTicks, type BacktestConfig } from "./backtest.js";
import {
  DEFAULT_WIN_GOAL,
  decideKeep,
  scoreFromResult,
  type TrialScore,
  type WinGoal,
} from "./autoresearch-score.js";

interface Knobs extends BacktestConfig {
  confidenceThreshold: number;
  minPoolTvlUsd: number;
}

interface BaselineFile {
  version: number;
  updatedAt: string | null;
  passedWinGoal: boolean;
  score: TrialScore;
  knobs: Knobs;
  winGoal: WinGoal;
}

function parseArgs(argv: ReadonlyArray<string>): {
  candidatePath: string | null;
  days: number;
  pool: string;
  startTvl: number;
  updateBaseline: boolean;
} {
  let candidatePath: string | null = null;
  let days = 7;
  let pool = "autoresearch-synthetic";
  let startTvl = 200_000;
  let updateBaseline = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--candidate" && argv[i + 1]) {
      candidatePath = argv[++i]!;
    } else if (a === "--days" && argv[i + 1]) {
      days = Number(argv[++i]);
    } else if (a === "--pool" && argv[i + 1]) {
      pool = argv[++i]!;
    } else if (a === "--start-tvl" && argv[i + 1]) {
      startTvl = Number(argv[++i]);
    } else if (a === "--no-update-baseline") {
      updateBaseline = false;
    }
  }
  if (!Number.isFinite(days) || days <= 0) throw new Error("Invalid --days");
  if (!Number.isFinite(startTvl) || startTvl <= 0) throw new Error("Invalid --start-tvl");
  return { candidatePath, days, pool, startTvl, updateBaseline };
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function assertKnobs(raw: unknown): Knobs {
  if (raw === null || typeof raw !== "object") throw new Error("knobs must be an object");
  const o = raw as Record<string, unknown>;
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error(`knob ${k} must be a finite number`);
    return v;
  };
  return {
    halfWidth: num("halfWidth"),
    driftThreshold: num("driftThreshold"),
    minHoldTicks: num("minHoldTicks"),
    minNetBenefitUsd: num("minNetBenefitUsd"),
    maxRebalances: num("maxRebalances"),
    maxPositionsPerPool: num("maxPositionsPerPool"),
    confidenceThreshold: num("confidenceThreshold"),
    minPoolTvlUsd: num("minPoolTvlUsd"),
  };
}

function main(): void {
  const root = resolve(import.meta.dir, "..");
  const baselinePath = resolve(root, "research/baseline.json");
  const resultsDir = resolve(root, "research/results");
  const logPath = resolve(resultsDir, "log.jsonl");
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(resolve(root, "research/candidates"), { recursive: true });

  const args = parseArgs(process.argv.slice(2));
  const baseline = loadJson<BaselineFile>(baselinePath);
  const goal = baseline.winGoal ?? DEFAULT_WIN_GOAL;

  const knobs = args.candidatePath
    ? assertKnobs(loadJson<unknown>(resolve(args.candidatePath)))
    : assertKnobs(baseline.knobs);

  const ticks = generateMockHistory(args.pool, args.days, args.startTvl, {
    // Autoresearch needs ENTER gates to be exercisable; tag as measured.
    statsSource: "datapi",
  });
  const result = runBacktestFromTicks(ticks, {
    ...knobs,
    confidenceThreshold: knobs.confidenceThreshold,
    minPoolTvlUsd: knobs.minPoolTvlUsd,
  });
  const trial = scoreFromResult(result);
  const decision = decideKeep({
    trial,
    baseline: baseline.score,
    baselinePassedWinGoal: baseline.passedWinGoal,
    goal,
  });

  const trialId = `trial-${new Date().toISOString().replaceAll(":", "").replace(/\..+$/, "Z")}`;
  const record = {
    trialId,
    at: new Date().toISOString(),
    pool: args.pool,
    days: args.days,
    candidate: args.candidatePath,
    knobs,
    score: trial,
    decision: {
      keep: decision.keep,
      passedWinGoal: decision.passedWinGoal,
      reason: decision.reason,
    },
  };
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        trialId,
        keep: decision.keep,
        passedWinGoal: decision.passedWinGoal,
        reason: decision.reason,
        score: trial,
      },
      null,
      2,
    ),
  );

  if (decision.keep && args.updateBaseline) {
    const next: BaselineFile = {
      ...baseline,
      updatedAt: new Date().toISOString(),
      passedWinGoal: true,
      score: trial,
      knobs,
      winGoal: goal,
    };
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    const champPath = resolve(root, "research/candidates", `${trialId}-champion.json`);
    if (!existsSync(dirname(champPath))) mkdirSync(dirname(champPath), { recursive: true });
    writeFileSync(champPath, `${JSON.stringify(knobs, null, 2)}\n`, "utf8");
    console.log(`baseline updated → ${baselinePath}`);
  }

  if (!decision.keep && !decision.passedWinGoal) {
    process.exitCode = 2;
  }
}

main();
