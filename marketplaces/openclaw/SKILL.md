---
name: beam-install
description: Install and run Beam for automated Meteora DLMM rebalancing on Solana
---

# Beam Liquidity Agent

Install and run Beam for automated Meteora DLMM rebalancing on Solana.

## When This Skill Activates

- User wants to install a Solana liquidity trading agent
- User wants to automate Meteora DLMM pool rebalancing
- User wants to earn fees from concentrated-liquidity pools on Solana
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

```bash
beam setup --non-interactive --rpc-url="$SOLANA_RPC_URL" --rpc-fallback-url="${SOLANA_RPC_FALLBACK_URL:-}"
```

This writes `.env` with the RPC provider settings, an optional watchlist, and paper-trading defaults. The default mode is **paper trading** — no real funds are at risk.

## Start Trading

```bash
beam dev
```

Decisions are logged to `logs/audit-trail.jsonl`. To stop, send SIGINT (Ctrl+C).

## Available Commands

- `beam whoami` — Show current account
- `beam backtest` — Run backtest
- `beam update` — Check for updates
- `beam issue "<msg>"` — Store an issue in Beam Cloud D1
- `beam register` — Create the required cloud account
- `beam doctor [--fix]` — Validate registration, providers, and local state
- `beam wallet {generate,import,show}` — Manage the local Solana keypair
- `beam link-telegram` — Link to `@beam_agent_bot`

## Three Layers (CLI boundary plus required account)

The API account is required before `beam setup` and `beam dev` so telemetry,
errors, feedback, and usage have an owner. Telegram remains optional.

| Layer | Purpose | Required? |
|---|---|---|
| CLI (local) | Runs the trading engine | **Yes** |
| API (cloud) | Account, telemetry, errors, feedback, whoami, subscription | **Yes for agents** |
| Telegram (chat) | Monitor from `@beam_agent_bot` | No |

## Common Mistakes

1. Running `bun run dev` instead of `beam dev` — `beam dev` respects the install root.
2. Manually editing `.env` — use `beam setup`.
3. Skipping `beam register` — registration is required before setup and dev.
4. Setting `PAPER_TRADING=false` without a wallet — use `beam wallet generate` first.
5. Forgetting to export `PATH` after install.

## Troubleshooting

- `beam: command not found` → `export PATH="$HOME/.local/bin:$PATH"`
- `Bun not found` → installer auto-installs; check `$HOME/.bun/bin`
- `sqlite-vec` fails on Linux → engine falls back to system `libsqlite3.so` automatically
- `BigInt` serialization error → set `EMBEDDINGS_BACKEND=fallback` in `.env` (default)
- Helius 401/403 → re-run `beam setup` with a valid key
- Engine starts but makes no decisions → set `ENABLE_POOL_DISCOVERY=true` in `.env`

## Verify Installation

```bash
beam --version       # should print 0.0.8 or later
beam dev &           # start engine in background
sleep 30
tail -n 20 logs/audit-trail.jsonl
```

## Uninstall

```bash
rm -rf ~/.beam ~/.local/bin/beam ~/.config/beam/agent-id ~/.config/beam/install-id ~/.config/beam/credentials.json ~/.config/beam/wallet.json
```
