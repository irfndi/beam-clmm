# Beam CLI Reference

Beam runs fully standalone. The hosted Beam Cloud control plane (Cloudflare
Workers + D1) was retired when the project moved to a self-hosted VPS, so there
is no account to register, no API key to obtain, and no cloud login step. State
lives in local SQLite and the operator surface is the local status server.

## Commands

### `beam setup`

Configure the trading agent and write `.env` (a timestamped backup is created
if one already exists). Works offline — no account required.

```bash
# Interactive mode
beam setup

# Non-interactive (for agents/CI)
beam setup --non-interactive --rpc-url=https://mainnet.base.org
```

**Options:**

- `--rpc-url <url>` — Base RPC URL
- `--rpc-fallback-url <url>` — optional fallback RPC URL
- `--wallet-key-file <path>` — EVM wallet private key file (optional)
- `--watchlist <pools>` — Comma-separated pool addresses (optional)
- `--paper-trading` — Enable paper trading (default: true)
- `--non-interactive` — Accept defaults without prompting

### `beam dev`

Start the trading agent.

```bash
beam dev
beam dev --exit-live   # execute EXIT on-chain even in paper mode (needs wallet)
```

### Other commands

| Command | Purpose |
| ------- | ------- |
| `beam status` | Current agent status, for humans and agent runtimes |
| `beam portfolio` | Positions and P&L |
| `beam backtest` | Historical simulation |
| `beam resume` | Clear the active autonomous safety pause |
| `beam telemetry` | Inspect or control client error telemetry |
| `beam config` | Inspect or edit DB-backed config (env > DB > defaults) |
| `beam feedback` | Record feedback locally (cloud submission is opt-in) |
| `beam update` \| `beam upgrade` | Check for and apply updates |
| `beam version` | Show current version |

## Retired commands

`beam register`, `beam login`, `beam whoami`, `beam link-telegram`,
`beam subscription`, `beam referral`, `beam issue` and `beam support` were
removed with the Cloudflare control plane they talked to. They are not
reimplemented locally: there is no account, no tier, and no hosted support
queue any more.

## Development Commands

These are used when developing Beam itself:

```bash
bun run dev        # Start agent with hot reload
bun run test       # Run Vitest suite
bun run lint       # Run oxlint + tsc --noEmit
bun run format     # Run oxfmt
bun run build      # Build with tsdown
bun run backtest   # Historical simulation
```

## Environment Variables

Key env vars (set via `beam setup` or `.env`):

| Variable | Required | Default | Description |
| -------- | -------- | ------- | ----------- |
| `BEAM_CHAIN` | NO | `base` | Active chain (`base` \| `robinhood`) |
| `BEAM_BASE_RPC_URL` | NO | public mainnet | Base RPC URL |
| `RPC_FALLBACK_URLS` | NO | empty | Comma-separated fallback RPC endpoints |
| `WALLET_PRIVATE_KEY` | NO | empty | EVM wallet (live trading only) |
| `WATCHLIST_POOLS` | NO | empty | Comma-separated pool addresses |
| `PAPER_TRADING` | NO | `true` | Paper vs live trading |
| `SQLITE_DB_PATH` | NO | `./beam.db` | SQLite database file |
| `BEAM_CLOUD_ENABLED` | NO | `false` | Opt in to a hosted control plane. Leave unset when self-hosted |
| `BEAM_API_URL` | NO | — | Override the control-plane endpoint (only with `BEAM_CLOUD_ENABLED=true`) |

See [`config-service.ts`](../engine/config-service.ts) for the full list.
