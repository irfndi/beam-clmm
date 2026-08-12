import * as p from "@clack/prompts";
import fs from "fs";
import path from "path";

const isDirectSetupExecution =
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Env guard: probes the Bun global to decide whether this file is being run directly.
  typeof Bun !== "undefined" &&
  (Bun.main?.endsWith("ops/setup.ts") || Bun.main?.endsWith("ops/setup.js"));

if (isDirectSetupExecution && process.env.BEAM_ALLOW_DIRECT !== "true") {
  console.error("Error: Direct setup execution is not allowed.");
  console.error('Use "beam setup" instead.');
  process.exit(1);
}

async function main() {
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

      paperTrading: () =>
        p.confirm({
          message: "Enable paper trading mode (recommended for first run)?",
          initialValue: true,
        }),

      minTvl: () =>
        p.text({
          message: "Minimum pool TVL in USD",
          placeholder: "50000",
          initialValue: "50000",
          validate: (v) => (isNaN(Number(v)) ? "Must be a number" : undefined),
        }),

      watchlistPools: () =>
        p.text({
          message: "Comma-separated pool addresses to watch (leave blank to add later)",
          placeholder: "ABC123...,DEF456...",
          initialValue: "",
        }),
    },
    {
      onCancel: () => {
        p.cancel("Setup cancelled.");
        process.exit(0);
      },
    },
  );

  const rpcUrl = (answers.rpcUrl as string) || "";
  if (!rpcUrl.trim()) {
    throw new Error("A Robinhood Chain RPC URL is required");
  }

  const envContent = [
    "# RPC providers",
    `ROBINHOOD_RPC_URL=${rpcUrl}`,
    `ROBINHOOD_RPC_FALLBACK_URL=${(answers.rpcFallbackUrl as string) || ""}`,
    "",
    "# Strategy",
    `PAPER_TRADING=${String(answers.paperTrading)}`,
    "SCAN_INTERVAL_MS=600000",
    `MIN_POOL_TVL_USD=${answers.minTvl as string}`,
    "MIN_FEE_IL_RATIO=1.2",
    "TVL_DROP_EXIT_PCT=0.30",
    "VOLUME_AUTH_THRESHOLD=0.70",
    "MAX_OPEN_POSITIONS=3",
    "CONFIDENCE_THRESHOLD=0.65",
    "TRAILING_STOP_PCT=0.10",
    "",
    "# SQLite",
    "SQLITE_DB_PATH=./beam.db",
    "",
    "# Pools to watch (required for live trading; discovery is paper-only and opt-in)",
    `WATCHLIST_POOLS=${answers.watchlistPools as string}`,
    "ENABLE_POOL_DISCOVERY=false",
    "DISCOVERY_MIN_TVL_USD=1000000",
    "DISCOVERY_MIN_FEE_RATIO=1.5",
  ].join("\n");

  const envPath = path.resolve(".env");
  fs.writeFileSync(envPath, envContent, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);

  p.note(
    [
      "✓ .env created",
      "",
      "Next steps:",
      "  1. Run agent:     bun run dev",
      "  2. Run backtest:  bun run backtest",
    ].join("\n"),
    "Setup complete",
  );

  p.outro("Happy rebalancing!");
}

main().catch(console.error);
