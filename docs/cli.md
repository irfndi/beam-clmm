# Beam CLI Reference

## Global Commands

### `beam register`

Register with Beam's Cloudflare Worker and get an API key.

```bash
beam register
# Output: API key saved to ~/.config/beam/credentials.json
```

### `beam login <key>`

Validate an existing API key.

```bash
beam login sk-beam-xxxxxxxx
# Output: Login successful — user_id: abc123
```

### `beam setup`

Interactive wizard to configure the trading agent. Run `beam register` first;
setup validates the stored account and writes a timestamped `.env` backup.

```bash
# Interactive mode
beam setup

# Non-interactive (for agents/CI)
beam setup --non-interactive --rpc-url=https://rpc.mainnet.chain.robinhood.com --rpc-fallback-url=https://second-rpc.example.com
```


telemetry. `--fix` creates missing directories and repairs permissions without

```bash
```

**Options:**
- `--rpc-url <url>` — Robinhood Chain RPC URL
- `--rpc-fallback-url <url>` — optional fallback RPC URL
- `--jupiter-api-key <key>` — optional Jupiter Price API v3 key
- `--wallet-key-file <path>` — EVM wallet private key file (optional)
- `--watchlist <pools>` — Comma-separated pool addresses (optional)
- `--paper-trading` — Enable paper trading (default: true)

### `beam whoami`

Show current user info.

```bash
beam whoami
# Output:
# User ID: abc123
# Tier: free
# Wallet: 7xKx...3f2a (pubkey)
# Telegram: linked (@username)
# API Key: sk-beam-xxxxxxxx (last 4)
```

## Telegram Commands

### `beam link-telegram`

Generate a one-time code to link your Telegram account.

```bash
beam link-telegram
# Output: Link code: LINK-AB12CD (expires in 10 minutes)
# Send this code to @beam_agent_bot
```

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
|----------|----------|---------|-------------|
| `ROBINHOOD_RPC_URL` | NO | public mainnet | Robinhood Chain RPC URL |
| `ROBINHOOD_RPC_FALLBACK_URL` | NO | empty | Fallback RPC URL |
| `ROBINHOOD_RPC_FALLBACK_URL` | NO | empty | Separate RPC endpoint used after primary rate-limit/network failures |
| `JUPITER_API_KEY` | NO | empty | Jupiter Price API v3 key |
| `COINGECKO_API_KEY` | NO | empty | CoinGecko Pro API key |
| `WALLET_PRIVATE_KEY` | NO | empty | EVM wallet (live trading only) |
| `WATCHLIST_POOLS` | NO | empty | Comma-separated pool addresses |
| `PAPER_TRADING` | NO | `true` | Paper vs live trading |
| `SQLITE_DB_PATH` | NO | `./beam.db` | SQLite database file |

`beam setup`, `beam dev`, `beam feedback`, and `beam issue` require a valid
registered account. Feedback and issues are stored in the Beam Cloud D1 store;
local storage is only an outage fallback.

See [`config-service.ts`](../engine/config-service.ts) for the full list.
