---
name: beam-install
description: Install, configure, and run the Beam liquidity agent for automated Meteora DLMM rebalancing on Solana
---

# Beam Install

Use this skill when an agent needs to set up or operate the Beam liquidity agent for automated Meteora DLMM rebalancing on Solana.

## When to Use

- User asks to install a Solana liquidity agent, trading bot, or DLMM rebalancer
- User wants to automate Meteora DLMM pool positions
- User wants to earn fees from concentrated-liquidity pools without manual management
- User mentions `beam`, `beam-clmm`, or `@irfndi/beam-clmm`

## Installation

The one-liner installer handles Bun (installs if missing), detects your OS/architecture, downloads a compiled bundle from Cloudflare R2, verifies its SHA-256 checksum, extracts it to `~/.beam`, and writes a `beam` wrapper to `~/.local/bin/`.

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/beam-clmm/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

## Agent Operating Contract

Use the installed `beam` wrapper as the product boundary. The release installer provides the checksum-verified platform bundle under `~/.beam` and the global command under `~/.local/bin/beam`.

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/beam-clmm/main/scripts/install.sh \
  | BEAM_SKIP_SETUP=1 bash
export PATH="$HOME/.local/bin:$PATH"
beam register
beam version
beam doctor
beam setup --non-interactive --rpc-url="$SOLANA_RPC_URL"
beam dev
```

Upgrade with `beam update --check-only` and `beam update`. Do not edit the Beam checkout, run `bun run dev`, or run `bun install` during agent operations; those commands are for Beam development. `bun add --global beam` is unsupported because no npm package with that name is published.

## Configuration

Non-interactive (for agents):

```bash
beam setup --non-interactive --rpc-url="$SOLANA_RPC_URL" --rpc-fallback-url="${SOLANA_RPC_FALLBACK_URL:-}"
```

Interactive (for humans):

```bash
beam setup
```

This writes `.env` with the RPC provider settings, an optional watchlist, and paper-trading defaults. The default mode is **paper trading** — no real funds are at risk.

If you don't know which pools to watch, also set `ENABLE_POOL_DISCOVERY=true` in `.env` so the agent can find candidates on its own.

## Start Trading

```bash
beam dev
```

Decisions are logged to `logs/audit-trail.jsonl`. To stop, send SIGINT (Ctrl+C).

## Available Commands

| Command                               | Purpose                                             |
| ------------------------------------- | --------------------------------------------------- |
| `beam dev`                           | Start the trading engine                            |
| `beam setup`                         | Interactive `.env` wizard                           |
| `beam register`                      | Create the required cloud account                   |
| `beam doctor [--fix]`                | Validate registration, providers, and local state   |
| `beam whoami`                        | Show cloud account info (requires `beam register`) |
| `beam backtest`                      | Run a historical simulation                         |
| `beam update`                        | Check for and apply updates                         |
| `beam issue "<msg>"`                 | Store an issue in Beam Cloud D1                    |
| `beam wallet {generate,import,show}` | Manage the local Solana keypair                     |
| `beam link-telegram`                 | Link the cloud account to `@beam_agent_bot`        |

## Three Layers (CLI boundary plus required account)

The API account is required before `beam setup` and `beam dev` so telemetry,
errors, feedback, and usage have an owner. Telegram remains optional.

| Layer           | Purpose                                                    | Required?          |
| --------------- | ---------------------------------------------------------- | ------------------ |
| CLI (local)     | Runs the trading engine, persists positions to SQLite      | **Yes**            |
| API (cloud)     | Account, telemetry, errors, feedback, whoami, subscription | **Yes for agents** |
| Telegram (chat) | Monitor and control the agent from `@beam_agent_bot`      | No                 |

## Common Mistakes

1. **Running `bun run dev` instead of `beam dev`.** `beam dev` goes through the CLI wrapper that resolves the install root and respects config. `bun run dev` bypasses that.
2. **Manually editing `.env`.** Use `beam setup` to update config.
3. **Skipping `beam register`.** Registration is required before setup and dev.
4. **Setting `PAPER_TRADING=false` without a wallet.** Live mode requires `WALLET_PRIVATE_KEY`. Use `beam wallet generate` to create one.
5. **Forgetting to export `PATH`.** After the one-liner install, `~/.local/bin` must be on `PATH`.

## Troubleshooting

| Symptom                                      | Cause                                             | Fix                                                       |
| -------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| `beam: command not found`                   | `~/.local/bin` not on PATH                        | `export PATH="$HOME/.local/bin:$PATH"`                    |
| `Bun not found` during install               | Bun not installed                                 | Installer auto-installs Bun; check `$HOME/.bun/bin`       |
| `sqlite-vec` fails on Linux                  | Bundled SQLite lacks extensions                   | Engine falls back to system `libsqlite3.so` automatically |
| `BigInt` serialization error from embeddings | ONNX runtime issue in Node.js                     | Set `EMBEDDINGS_BACKEND=fallback` in `.env` (default)     |
| Helius 401/403                               | Invalid API key                                   | Re-run `beam setup` with a valid key or custom RPC URL   |
| Engine starts but makes no decisions         | Empty watchlist and `ENABLE_POOL_DISCOVERY=false` | Set `ENABLE_POOL_DISCOVERY=true` in `.env`                |

## Verify Installation

```bash
beam --version       # should print 0.0.8 or later
beam dev &           # start engine in background
sleep 30
tail -n 20 logs/audit-trail.jsonl   # should show scan cycle decisions
```

## Uninstall

```bash
rm -rf ~/.beam ~/.local/bin/beam ~/.config/beam/agent-id ~/.config/beam/install-id ~/.config/beam/credentials.json ~/.config/beam/wallet.json
```
