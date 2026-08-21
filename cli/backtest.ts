import { Command } from "commander";
import { createLogger } from "../engine/logger.js";
import { runBacktest } from "../ops/backtest.js";

const logger = createLogger("backtest");

export const backtestCommand = new Command("backtest")
  .description("Run historical simulation")
  .option("-d, --days <number>", "Simulation duration in days", "7")
  .option("-p, --pools <addresses>", "Comma-separated pool addresses")
  .option("-s, --source <type>", 'Data source: "synthetic" or "replay"', "synthetic")
  .option("--db <path>", "SQLite database path for replay source", "./beam.db")
  .option("--min-tvl <usd>", "Replay pre-filter TVL floor in USD", "50000")
  .option("--challenge", "Replay challenge-mode score and pool-age gates")
  .option("--challenge-min-score <score>", "Challenge replay score floor", "4")
  .option("--gas-usd <usd>", "Round-trip gas cost assumption for replay entries", "0")
  .option("--min-7d-fee-over-gas <multiple>", "Minimum expected 7d fees / gas multiple", "1")
  .action(async () => {
    logger.info("Starting backtest...");
    // Filter out the subcommand name so the underlying backtest parser sees only
    // its own flags (e.g. --days, --pools).
    const args = process.argv.slice(2).filter((a) => a !== "backtest");
    try {
      await runBacktest(args);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });
