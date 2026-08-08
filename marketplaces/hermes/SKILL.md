---
name: beam-install
description: Install and configure Beam liquidity agent for Meteora DLMM pools
version: 1.0.0
author: irfndi
license: MIT
metadata:
  hermes:
    tags: [defi, solana, trading, liquidity, meteora, dlmm]
    related_skills: [beam-rebalance, beam-backtest]
    category: software-development
---

# Beam Install

Use this skill when the user wants to install Beam for automated liquidity management on Solana.

## When to Use

- User asks to install a trading bot or liquidity agent
- User wants to automate Meteora DLMM positions
- User wants to earn fees from Solana DeFi pools
- User mentions `beam`, `beam-clmm`, or `@irfndi/beam-clmm`

## Prerequisites

- Bun 1.4.0+ (auto-installed if missing)
- A private Solana RPC URL; Helius is optional when another provider is configured

## Installation Steps

### 1. Install Beam

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

### 2. Configure

```bash
beam setup --non-interactive --rpc-url="$SOLANA_RPC_URL" --rpc-fallback-url="${SOLANA_RPC_FALLBACK_URL:-}"
```

This writes `.env` with the RPC provider settings, an optional watchlist, and paper-trading defaults. The default mode is **paper trading** — no real funds are at risk.

If you don't know which pools to watch, also set `ENABLE_POOL_DISCOVERY=true` in `.env` so the agent can find candidates on its own.

### 3. Start

```bash
beam dev
```

Decisions are logged to `logs/audit-trail.jsonl`. To stop, send SIGINT (Ctrl+C).

## Three Layers (CLI boundary plus required account)

The API account is required before `beam setup` and `beam dev` so telemetry,
errors, feedback, and usage have an owner. Telegram remains optional.

| Layer | Purpose | Required? |
|---|---|---|
| CLI (local) | Runs the trading engine, persists positions to SQLite | **Yes** |
| API (cloud) | Account, telemetry, errors, feedback, whoami, subscription | **Yes for agents** |
| Telegram (chat) | Monitor and control the agent from `@beam_agent_bot` | No |

## Available Commands

| Command | Purpose |
|---|---|
| `beam dev` | Start the trading engine |
| `beam setup` | Interactive `.env` wizard |
| `beam register` | Create the required cloud account |
| `beam doctor [--fix]` | Validate registration, providers, and local state |
| `beam whoami` | Show cloud account info (requires `beam register`) |
| `beam backtest` | Run a historical simulation |
| `beam update` | Check for and apply updates |
| `beam issue "<msg>"` | Store an issue in Beam Cloud D1 |
| `beam wallet {generate,import,show}` | Manage the local Solana keypair |
| `beam link-telegram` | Link the cloud account to `@beam_agent_bot` |

## Common Mistakes

1. **Running `bun run dev` instead of `beam dev`.** `beam dev` goes through the CLI wrapper that resolves the install root and respects config. `bun run dev` bypasses that and may write `.env` to the wrong directory.
2. **Manually editing `.env`.** Use `beam setup` to update config. Hand-edits work but skip validation.
3. **Skipping `beam register`.** Registration is required before setup and dev.
4. **Setting `PAPER_TRADING=false` without a wallet.** Live mode requires `WALLET_PRIVATE_KEY` in `.env`. Use `beam wallet generate` to create one.
5. **Forgetting to export `PATH`.** After the one-liner install, `~/.local/bin` must be on `PATH` for the `beam` wrapper to be found.

## Troubleshooting

- If Bun not found: `curl -fsSL https://bun.sh/install | bash`
- If sqlite-vec fails: Engine uses system SQLite automatically
- If ONNX error: Fallback embeddings enabled (`EMBEDDINGS_BACKEND=fallback` is the default)
- If `beam: command not found`: `export PATH="$HOME/.local/bin:$PATH"`
- If Helius 401/403: Re-run `beam setup` with a valid key or custom RPC URL
- If engine starts but makes no decisions: Set `ENABLE_POOL_DISCOVERY=true` in `.env`

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
