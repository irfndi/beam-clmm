import { Command } from "commander";
import { Effect } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import { getBeamDbPath } from "../engine/paths.js";
import { buildParityReport, formatParityReport } from "../engine/decision-parity.js";

/**
 * `beam decisions` — read the decision journal.
 *
 * `parity` pairs every legacy row with the rule-core row for the same
 * cycle/pool and reports where they disagree. That number is the gate for
 * changing `DECISION_ENGINE`: `shadow` records, `rules` adopts vetoes and
 * protective exits. Read-only.
 */

const DAY_MS = 86_400_000;

function buildLayer() {
  return DbLive(process.env.SQLITE_DB_PATH ?? getBeamDbPath());
}

interface ParityOptions {
  readonly days?: string;
  readonly limit?: string;
  readonly json?: boolean;
}

function positiveInteger(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

const parityCommand = new Command("parity")
  .description("Compare the legacy branch table with the rule core over the decision journal")
  .option("--days <n>", "only rows newer than this many days (default 7)", "7")
  .option("--limit <n>", "rows to read, newest first (default 20000)", "20000")
  .option("--json", "print the report as JSON")
  .action((options: ParityOptions) => {
    const days = Number(options.days ?? 7);
    const limit = positiveInteger(options.limit, 20_000);
    if (!Number.isFinite(days) || days <= 0 || limit === null) {
      console.error("Invalid --days/--limit: both must be positive numbers.");
      process.exitCode = 1;
      return;
    }

    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService;
        const rows = yield* db.getRecentDecisionJournal(limit).pipe(Effect.orElseSucceed(() => []));
        const since = Date.now() - days * DAY_MS;
        const report = buildParityReport(rows.filter((row) => row.timestamp >= since));
        if (options.json === true) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        for (const line of formatParityReport(report, {
          windowLabel: `last ${days}d`,
          truncated: rows.length >= limit,
        })) {
          console.log(line);
        }
      }).pipe(Effect.provide(buildLayer())),
    ).catch((err) => {
      console.error(
        `Failed to read decision journal: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    });
  });

export const decisionsCommand = new Command("decisions")
  .description("Inspect decision-journal parity between the legacy engine and the rule core")
  .addCommand(parityCommand);
