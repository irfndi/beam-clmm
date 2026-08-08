import { Command } from "commander";
import * as p from "@clack/prompts";
import fs from "fs";
import { pingInstall, requireRegistered, type BeamCredentials } from "./api.js";
import { ensureBeamConfigDir, getBeamEnvPath, getBeamDbPath } from "../engine/paths.js";
import { mergeEnvContent } from "./env-merge.js";

export const setupCommand = new Command("setup")
  .description("Configure Beam trading agent")
  .option("--non-interactive", "Run without prompts (for agents/CI)")
  .option("--rpc-url <url>", "Robinhood Chain RPC URL (default: public mainnet)")
  .option("--rpc-fallback-url <url>", "Optional fallback RPC URL")
  .option("--wallet-key-file <path>", "Path to EVM wallet private key file (optional)")
  .option("--watchlist <pools>", "Comma-separated pool addresses")
  .option("--paper-trading", "Enable paper trading (default: true)")
  .action(async (options) => {
    const isNonInteractive = options.nonInteractive;
    let credentials: BeamCredentials;
    try {
      credentials = await requireRegistered(true);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    let walletKey: string;
    let watchlistPools: string;
    let paperTrading: boolean;
    let rpcUrl: string;
    let rpcFallbackUrl: string;

    if (isNonInteractive) {
      rpcUrl =
        options.rpcUrl ||
        process.env.ROBINHOOD_RPC_URL ||
        "https://rpc.mainnet.chain.robinhood.com";
      rpcFallbackUrl = options.rpcFallbackUrl || process.env.ROBINHOOD_RPC_FALLBACK_URL || "";
      // Read wallet key from file if provided, otherwise from env
      if (options.walletKeyFile) {
        try {
          walletKey = fs.readFileSync(options.walletKeyFile, "utf-8").trim();
        } catch (err) {
          console.error(`Error: Could not read wallet key file: ${options.walletKeyFile}`);
          process.exit(1);
        }
      } else {
        walletKey = process.env.WALLET_PRIVATE_KEY || "";
      }
      watchlistPools = options.watchlist || "";
      paperTrading = options.paperTrading !== false;

      // Validate: live trading requires wallet key
      if (!paperTrading && !walletKey.trim()) {
        console.error("Error: Wallet private key is required when paper trading is disabled.");
        console.error("Provide via --wallet-key-file or WALLET_PRIVATE_KEY env var.");
        process.exit(1);
      }
    } else {
      // Interactive mode
      console.clear();
      p.intro("  Beam Setup  ");

      const answers = await p.group(
        {
          rpcUrl: () =>
            p.text({
              message: "Robinhood Chain RPC URL",
              placeholder: "https://rpc.mainnet.chain.robinhood.com",
              initialValue:
                process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
            }),

          rpcFallbackUrl: () =>
            p.text({
              message: "Fallback RPC URL (optional)",
              placeholder: "https://...",
              initialValue: process.env.ROBINHOOD_RPC_FALLBACK_URL ?? "",
            }),

          walletKey: () =>
            p.text({
              message: "Wallet private key (optional, for live trading)",
              placeholder: "leave blank for paper trading",
              initialValue: "",
            }),

          watchlistPools: () =>
            p.text({
              message: "Watchlist pools (comma-separated, leave blank for pool discovery)",
              placeholder: "ABC123...,DEF456...",
              initialValue: "",
            }),

          paperTrading: () =>
            p.confirm({
              message: "Enable paper trading?",
              initialValue: true,
            }),
        },
        {
          onCancel: () => {
            p.cancel("Setup cancelled.");
            process.exit(0);
          },
        },
      );

      rpcUrl = (answers.rpcUrl as string) || "";
      rpcFallbackUrl = (answers.rpcFallbackUrl as string) || "";
      if (!rpcUrl.trim()) {
        p.cancel("A Robinhood Chain RPC URL is required.");
        process.exit(1);
      }
      walletKey = (answers.walletKey as string) || "";
      watchlistPools = (answers.watchlistPools as string) || "";
      paperTrading = answers.paperTrading as boolean;

      // Validate: live trading requires wallet key
      if (!paperTrading && !walletKey.trim()) {
        p.cancel("Wallet private key is required when paper trading is disabled.");
        process.exit(1);
      }
    }

    // Escape values to prevent .env injection
    function escapeEnv(value: string): string {
      if (value.includes("\n") || value.includes("\r")) {
        throw new Error("Environment values cannot contain newlines");
      }
      return value;
    }

    const envContent = [
      "# RPC providers",
      `ROBINHOOD_RPC_URL=${escapeEnv(rpcUrl)}`,
      `ROBINHOOD_RPC_FALLBACK_URL=${escapeEnv(rpcFallbackUrl)}`,
      "",
      "# Wallet (optional — leave empty for paper trading)",
      `WALLET_PRIVATE_KEY=${escapeEnv(walletKey)}`,
      "",
      "# Trading mode",
      `PAPER_TRADING=${String(paperTrading)}`,
      "SCAN_INTERVAL_MS=600000",
      "MIN_POOL_TVL_USD=50000",
      "MIN_FEE_IL_RATIO=1.2",
      "TVL_DROP_EXIT_PCT=0.30",
      "VOLUME_AUTH_THRESHOLD=0.70",
      "MAX_OPEN_POSITIONS=3",
      "CONFIDENCE_THRESHOLD=0.65",
      "TRAILING_STOP_PCT=0.10",
      "",
      "# SQLite",
      `SQLITE_DB_PATH=${escapeEnv(getBeamDbPath())}`,
      "",
      "# Pools",
      `WATCHLIST_POOLS=${escapeEnv(watchlistPools)}`,
    ].join("\n");

    ensureBeamConfigDir();
    const envPath = getBeamEnvPath();
    const existingEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : null;
    if (existingEnv !== null) {
      const backupPath = `${envPath}.backup.${Date.now()}`;
      // Backup may contain WALLET_PRIVATE_KEY: write with 0o600 and never
      // clobber an existing destination (exclusive create).
      fs.writeFileSync(backupPath, existingEnv, { mode: 0o600, flag: "wx" });
      console.warn(`⚠ Existing .env found. Backup created at: ${backupPath}`);
    }
    // MERGE, never replace: unknown user keys (WATCHLIST_POOLS, MARKET_SCAN_*,
    // AGENTIC_MODE, custom comments) survive a re-run; managed keys get the
    // fresh wizard values; new defaults are appended. An empty wizard value
    // never wipes a non-empty existing value.
    const mergedEnv = existingEnv === null ? envContent : mergeEnvContent(existingEnv, envContent);
    fs.writeFileSync(envPath, mergedEnv, { mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
    await pingInstall("setup", { userId: credentials.userId });

    if (!isNonInteractive) {
      p.note(
        [
          "✓ .env created",
          "",
          "Next steps:",
          "  1. Run agent:     beam dev",
          "  2. Run backtest:  beam backtest",
        ].join("\n"),
        "Setup complete",
      );
      p.outro("Happy rebalancing!");
    } else {
      console.log("✓ .env created");
    }
  });
