# Beam Install Skill

Use this skill when an agent needs to install, configure, or run the Beam liquidity agent for automated Meteora DLMM rebalancing on Solana.

## When to Activate

- User asks to install a Solana liquidity agent, trading bot, or DLMM rebalancer
- User wants to automate Meteora DLMM pool positions
- User wants to earn fees from concentrated-liquidity pools without manual management
- User mentions `beam`, `beam-clmm`, or `@irfndi/beam-clmm`

## Three Layers (CLI boundary plus required account)

Beam is designed in three layers. The CLI is the operating boundary, and a
registered API account is required before setup or agent execution. Telegram is optional.

| Layer | Purpose | Required? |
|---|---|---|
| CLI (local) | Runs the trading engine, reads `.env`, persists positions to SQLite | **Yes** |
| API (cloud) | Account, telemetry, errors, feedback, whoami, subscription | **Yes for agents** |
| Telegram (chat) | Monitor and control the agent from `@beam_agent_bot` | No |

`beam register` must complete before `beam setup` or `beam dev` so usage and
error telemetry have an owner.

## Install

The one-liner installer handles Bun (installs if missing), detects your OS/architecture, downloads a compiled bundle from Cloudflare R2, verifies its SHA-256 checksum, extracts it to `~/.beam`, and writes a `beam` wrapper to `~/.local/bin/`.

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/beam-clmm/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

## Agent Operating Contract

Use the installed `beam` wrapper as the product boundary. It is the supported global install: the release installer writes a checksum-verified platform bundle under `~/.beam` and the wrapper under `~/.local/bin/beam`.

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

Use `beam update --check-only` and `beam update` for upgrades. Do not edit the Beam checkout, run `bun run dev`, or run `bun install` while operating an installed agent. Those commands are for Beam development only.

`bun add --global beam` is not supported because Beam is not published as an npm package named `beam`. `bun add --global github:irfndi/beam-clmm#<release-tag>` is a source fallback, not the production install path.

## Configure

Non-interactive (for agents and CI):

```bash
beam setup --non-interactive --rpc-url="$SOLANA_RPC_URL" --rpc-fallback-url="${SOLANA_RPC_FALLBACK_URL:-}"
```

If you don't know which pools to watch, also set `ENABLE_POOL_DISCOVERY=true` in `.env` so the agent can find candidates on its own.

Interactive (for humans):

```bash
beam setup
```

This writes `.env` with the RPC provider settings, an optional watchlist, and paper-trading defaults. The default mode is **paper trading** — no real funds are at risk.

## Start Trading

```bash
beam dev
```

This spawns the engine. Decisions are logged to `logs/audit-trail.jsonl`. To stop, send SIGINT (Ctrl+C).

## Common Commands

| Command | Purpose |
|---|---|
| `beam whoami` | Show cloud account info (requires `beam register`) |
| `beam register` | Create the required cloud account and store an API key |
| `beam doctor [--fix]` | Validate registration, providers, and local state |
| `beam setup` | Interactive `.env` wizard |
| `beam dev` | Start the trading engine |
| `beam backtest` | Run a historical simulation (synthetic or replay from snapshots) |
| `beam update` | Check for and apply updates from R2/GitHub releases |
| `beam wallet {generate,import,show}` | Manage the local Solana keypair (required for live trading) |
| `beam link-telegram` | Link the cloud account to `@beam_agent_bot` |

## Common Mistakes

1. **Running `bun run dev` instead of `beam dev`.** Both start the engine, but `beam dev` goes through the CLI wrapper that resolves the install root and respects config. `bun run dev` bypasses that and may write `.env` to the wrong directory.
2. **Manually editing `.env`.** Use `beam setup` to update config. Hand-edits work but skip validation.
3. **Skipping `beam register`.** Registration is required before setup and dev.
4. **Setting `PAPER_TRADING=false` without a wallet.** Live mode requires `WALLET_PRIVATE_KEY` in `.env`. Generate a keypair with `beam wallet generate` (saves to `~/.config/beam/wallet.json`) and copy the private key into `WALLET_PRIVATE_KEY=` in `.env`.
5. **Forgetting to export `PATH`.** After the one-liner install, `~/.local/bin` must be on `PATH` for the `beam` wrapper to be found.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `beam: command not found` | `~/.local/bin` not on PATH | `export PATH="$HOME/.local/bin:$PATH"` |
| `Bun not found` during install | Bun not installed | Installer auto-installs Bun; check `$HOME/.bun/bin` |
| `sqlite-vec` fails on Linux | Bundled SQLite lacks extensions | Engine falls back to system `libsqlite3.so` automatically (see `engine/db.ts`) |
| `BigInt` serialization error from embeddings | ONNX runtime issue in Node.js | Set `EMBEDDINGS_BACKEND=fallback` in `.env` (default) |
| Helius 401/403 | Invalid API key | Re-run `beam setup` with a valid key or custom RPC URL |
| Engine starts but makes no decisions | Empty watchlist and `ENABLE_POOL_DISCOVERY=false` | Set `ENABLE_POOL_DISCOVERY=true` in `.env` |

## Verify Installation

```bash
beam --version       # should print 0.0.8 or later
beam dev &           # start engine in background
sleep 30
tail -n 20 logs/audit-trail.jsonl   # should show scan cycle decisions
```

## When Done

Stop the engine with Ctrl+C (or `pkill -f "bun.*beam"`). The agent's install root is `~/.beam` by default. To uninstall:

```bash
rm -rf ~/.beam ~/.local/bin/beam ~/.config/beam/agent-id ~/.config/beam/install-id ~/.config/beam/credentials.json ~/.config/beam/wallet.json
```

## See Also

- `dlmm-rebalancer` skill — strategy-level reasoning (HOLD/REBALANCE/EXIT/ENTER)
- `beam-rebalance` skill (planned, in `marketplaces/`) — trading operations
- `docs/agent-harness.md` — full agent integration guide
- `AGENTS.md` — repo notes for AI agents
