# Beam

![License](https://img.shields.io/badge/license-MIT-blue)
![Runtime](https://img.shields.io/badge/runtime-Bun_1.4-black)
![Chain](https://img.shields.io/badge/chain-Robinhood_Chain_EVM-0070F3)

An autonomous liquidity agent that watches Uniswap v3 & v4 concentrated-liquidity pools on Robinhood Chain (EVM, chain id 4663), reasons over live on-chain data, and rebalances positions before they bleed.

## What it does

Concentrated liquidity earns fees only when the active price sits inside your range. When the market drifts, your position silently collects impermanent loss instead. Most LPs either do not notice or react too late.

Beam fixes this with a rule-based agent that runs every 10 minutes, checks every pool in your watchlist, and either **holds**, **shifts the range**, **pulls liquidity entirely**, or **enters new pools**.

Every cycle follows the same sequence:

```
1. recall     -> query memory for past patterns on this pool
2. observe    -> fetch pool state, tick array, volume authenticity
3. reason     -> compute fee/IL ratio, tick drift, TVL velocity
4. simulate   -> if REBALANCE, estimate IL cost before committing
5. record     -> write new observations back to memory
6. decide     -> HOLD | REBALANCE | EXIT | ENTER
```

The decision is intercepted by a risk gate before anything happens on-chain. Confidence below threshold, drawdown above limit, or a position cap breach -- any of these blocks execution and logs a warning to memory so future cycles are aware.

## Memory

The agent remembers. Every outcome -- fee earned, IL incurred, bad pool flagged -- gets stored in an SQLite vector table (`sqlite-vec`) and retrieved by cosine similarity on the next relevant cycle. Entries expire automatically (90 days for patterns, 60 for warnings, 180 for outcomes).

This is what makes it self-improving: it gets slower to enter pools it has been burned by before, and faster to recognize patterns it has profited from.

## Volume authenticity

Before any decision, the agent scores each pool's volume on a 0-1 scale. Volume/TVL ratio above 10x, fee rate outside the 0.02%-2% band, or low TVL with outsized volume all push the score down. Pools below 0.70 are skipped entirely. This alone filters most of the wash-traded noise on Uniswap pools.

## Pool stats sources

Volume, TVL and fees come from the first source that answers, and the pool is tagged with where they came from:

1. **Robinhood Chain RPC** — real on-chain state (reserves, fee tier, ticks) read via viem from `ROBINHOOD_RPC_URL` (defaults to the public mainnet RPC).
2. **USD price feeds** — optional oracle feeds (Pyth Hermes poller, see `.env.example`) for USD pricing.
3. **Heuristic** — on-chain reserves × a modeled turnover. The last-resort safety net for a total API outage; it fabricates volume/fees.

Fabricated (heuristic) stats never pass a gate: when only the heuristic is available, the volume-authenticity and fee/IL gates are skipped rather than acting on made-up numbers, so a pool is held (not entered or force-exited) until real data returns.

## Quickstart

**One-liner install — latest stable bundle** (recommended for most users; installs Bun if needed, downloads a compiled bundle for your platform, and drops a `beam` wrapper on your PATH):

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/beam-clmm/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"   # if not already on PATH
beam register
beam setup --non-interactive --rpc-url=https://rpc.mainnet.chain.robinhood.com
beam dev                               # paper trading by default
```

> **Security note:** the `main` branch URL is mutable. For reproducible installs, use the pinned release version below (which runs the installer from a tagged release) or download the installer and verify its SHA-256 against the release notes before executing it.

**One-liner install — pinned release version** (reproducible; no git required):

```bash
# Replace 1.2.3 with the released version you want (omit BEAM_VERSION for latest)
curl -fsSL https://raw.githubusercontent.com/irfndi/beam-clmm/main/scripts/install.sh \
  | BEAM_VERSION=1.2.3 bash
export PATH="$HOME/.local/bin:$PATH"
beam register
beam setup --non-interactive --rpc-url=https://rpc.mainnet.chain.robinhood.com
beam dev
```

Use the pinned form when you need a specific release version (CI, reproducible deploys, air-gapped networks without git). The `beam update` command will still pull newer release bundles for you.

**Manual install from source** (only if you're working ON Beam itself — contributors, CI):

```bash
git clone https://github.com/irfndi/beam-clmm
cd beam-clmm
bun install
bun run dev          # during development; uses the local source, no wrapper needed
```

The bundle-install paths (one-liner and pinned release) create a `beam` wrapper on `PATH`. The wrapper is a thin shim that sets `BEAM_INSTALL_DIR` and `BEAM_VEC0_PATH`, then runs the compiled bundle with `bun`, so the install root and config are resolved consistently regardless of where you invoke it from. The source workflow runs `bun run dev` directly and does not create `~/.local/bin/beam`.

### Agent operating contract

Agents operating Beam should use the installed `beam` wrapper as the product boundary. The installer is the supported global install: it places a verified platform bundle under `~/.beam` and the command under `~/.local/bin/beam`.

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/beam-clmm/main/scripts/install.sh \
  | BEAM_SKIP_SETUP=1 bash
export PATH="$HOME/.local/bin:$PATH"
beam register
beam version
beam setup --non-interactive --rpc-url=https://rpc.mainnet.chain.robinhood.com
beam dev
```

Use `beam update --check-only` and `beam update` for upgrades. Do not edit the checkout, run `bun run dev`, or run `bun install` while operating an installed agent. `bun install` and source edits are for Beam development only.

`bun add --global beam` is not a supported command because this project is not published as an npm package named `beam`. A GitHub global install such as `bun add --global github:irfndi/beam-clmm#<release-tag>` is a source fallback, not the production path; it does not provide the platform bundle or the release installer's checksum guarantee.

### Canary builds

Every merge to `main` that passes CI publishes a canary build -- the latest code, rebuilt and uploaded to R2 automatically, like Bun's own canary channel. A canary is versioned `<next patch>-canary.<UTC timestamp>` and the `releases/channel/canary.json` pointer always tracks the newest one.

```bash
beam update --canary       # move to the latest canary build
```

Canary builds are not for production. They run exactly what is on `main` right now, with no tag, no GitHub Release, and no GPG signature -- only the SHA-256 checks the updater always performs. Use them to test an unreleased fix or feature before it ships.

To go back, run plain `beam update`: the next stable release supersedes the canary version and pulls you back onto the stable channel.

### For AI Agents (OpenClaw, Hermes, acpx, custom agents)

Beam is agent-friendly by design. The CLI is the operating boundary; registration is required before setup/dev so usage, errors, and feedback are tied to the agent account. Telegram remains optional.

```bash
# Pinned release — reproducible, no git, fastest for agents
# Replace 1.2.3 with the released version you want
curl -fsSL https://raw.githubusercontent.com/irfndi/beam-clmm/main/scripts/install.sh \
  | BEAM_VERSION=1.2.3 bash
export PATH="$HOME/.local/bin:$PATH"

# Or latest stable bundle
curl -fsSL https://raw.githubusercontent.com/irfndi/beam-clmm/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"

beam register                                    # required — creates the agent account
beam setup --non-interactive --rpc-url="$ROBINHOOD_RPC_URL"
beam dev                                         # start paper trading
```

If `beam` is not on `PATH` after the one-liner install, invoke the CLI directly:

```bash
beam register
beam setup --non-interactive --rpc-url="$ROBINHOOD_RPC_URL"
beam dev
```

Common agent commands:

| Command                                                          | Purpose                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `beam setup` / `beam setup --non-interactive --rpc-url=...` | Write `.env` (RPC provider, watchlist, optional API key)       |
| `beam register`                                                 | Create the required cloud account and store its API key          |
| `beam login <key>`                                              | Validate an existing API key and store it locally                 |
| `beam whoami`                                                   | Show current user / API key info (requires `register`)            |
| `beam dev`                                                      | Start the registered trading agent (paper by default)             |
| `beam backtest --days 7`                                        | Run a historical simulation against synthetic data                |
| `beam backtest --source replay --days 7 --pools <addr>`         | Replay live on-chain snapshots through the strategy               |
| `beam status --message`                                         | Chat-ready summary for agent runtimes                             |
| `beam version`                                                  | Show the current version                                          |
| `beam update`                                                   | Self-update from R2/GitHub releases (with smoke tests + rollback) |
| `beam feedback "..."`                                          | Store structured feedback in Beam Cloud D1                      |
| `beam issue "..."`                                             | Store an issue in Beam Cloud D1                                  |
| `beam link-telegram`                                            | Issue a `LINK-<16 hex>` code to link `@beam_agent_bot` (optional)  |
| `beam telemetry`                                                | Inspect or control client error telemetry                         |
| `beam config`                                                   | Inspect or edit DB-backed config (env > DB > defaults)            |

For the bundle-install paths (one-liner and pinned release), do NOT manually edit `.env` or bypass the `beam` wrapper — always invoke `beam` so the install root and config directories are resolved consistently. If you are developing on Beam from source, use `bun run dev` directly instead; the source workflow does not create `~/.local/bin/beam` or run `install.sh`. See [docs/agent-harness.md](docs/agent-harness.md) for the full agent guide and common anti-patterns.

To run the historical simulation:

```bash
bun run backtest                              # synthetic, 7 days
bun run backtest --days 30 --pools <addr>    # custom range
```

### Replay backtest from live snapshots

Set `ENABLE_SNAPSHOT_CAPTURE=true` while the agent runs in paper mode. Every cycle dumps the full pool state + tick array into `pool_snapshots` in SQLite. Later, replay that real on-chain data through the strategy:

```bash
bun run backtest --source replay --db ./beam.db --days 7 --pools <addr>
```

## Telemetry

The first `bun install` (postinstall) sends a single anonymous install ping — install id, platform, and package version — to
`https://beam-api.irfndi.workers.dev/v1/installs/ping`. The ping is **opt-out**:

- Set `BEAM_FEEDBACK_OPT_OUT=true` (or `1`/`true`/`yes`/`on`) in the environment **or** in `.env` to skip it entirely. The opt-out is read on every install run, so it also works retroactively.

Feedback and issue submissions (`beam feedback` / `beam issue`) use the registered Beam account and are not telemetry. Client error
reporting is enabled by default for registered clients (`BEAM_ERROR_REPORTING=true`) and can be pointed at a private endpoint via
`BEAM_ERROR_ENDPOINT`; `beam telemetry` inspects or controls it. Telegram alerts are a user-requested utility, not telemetry —
`BEAM_FEEDBACK_OPT_OUT` does not affect them.

## Configuration

Key `.env` variables:

| Variable                  | Default      | Description                              |
| ------------------------- | ------------ | ---------------------------------------- |
| `WATCHLIST_POOLS`         | --           | Comma-separated Uniswap v3 pool addresses / v4 pool ids |
| `ENABLE_POOL_DISCOVERY`   | `false`      | Opt-in automatic discovery; live mode should use approved watchlist pools |
| `DISCOVERY_MIN_TVL_USD`    | `1000000`    | Minimum TVL for automatic discovery     |
| `PAPER_TRADING`           | `true`       | Disable to execute on-chain              |
| `MIN_POOL_TVL_USD`        | `50000`      | Skip pools below this TVL                |
| `VOLUME_AUTH_THRESHOLD`   | `0.70`       | Skip pools below this authenticity score |
| `SCAN_INTERVAL_MS`        | `600000`     | Scan frequency (default 10 min)          |
| `CONFIDENCE_THRESHOLD`    | `0.65`       | Minimum agent confidence to act          |
| `TRAILING_STOP_PCT`       | `0.10`       | Drawdown from peak that triggers EXIT    |
| `SQLITE_DB_PATH`          | `./beam.db` | SQLite database file path                |
| `ENABLE_SNAPSHOT_CAPTURE` | `false`      | Dump pool snapshots to DB (paper only)   |
| `MAX_POSITIONS_PER_POOL`  | `2`          | Concurrent positions per pool            |
| `ENTRY_STRATEGY_TYPE`     | `spot`       | Deposit shape: spot\|curve\|bidask\|auto |
| `VOLATILITY_ADAPTIVE_RANGES` | `true`    | Scale range width by realized volatility (set false for static widths) |
| `FARM_REWARDS_ENABLED`    | `true`       | Claim and compound position fees periodically |
| `FEE_DESTINATION`         | `compound`   | Fee routing: compound\|accumulate-quote\|accumulate-eth |
| `ALERTS_ENABLED`          | `true`       | Proactive Telegram alert delivery        |
| `COPY_SIGNALS_ENABLED`    | `false`      | Opt-in copy-trading signal boost         |
| `STABLECOIN_MINTS`        | `USDC/USDT/PYUSD` | Trusted stablecoin tokens exempt from depeg screening (allowlist); empty disables |
| `IL_PROTECTION_ENABLED`   | `true`       | IL gates: entry fee/IL floor + IL-dominance EXIT |
| `MIN_FEE_IL_RATIO`        | `1.2`        | Min fee/IL to hold; ENTER floor when IL protection is on |
| `IL_DOMINANCE_EXIT_FACTOR` | `2`         | IL (USD) over fees × this triggers EXIT when out of range |
| `IL_DOMINANCE_MIN_USD`    | `5`          | Minimum IL (USD) before the IL-dominance EXIT |
| `ROBINHOOD_RPC_URL`       | (public mainnet RPC) | Robinhood Chain EVM RPC endpoint; empty uses the public default |

Live entries that fail because the wallet lacks a pool token are backed off
exponentially for that pool, starting at 30 minutes and capped at 6 hours.
RPC requests are paced, wallet balances are cached briefly within the adapter,
and scan logs report decided, executed, and failed pools separately.
`failed` counts processing or execution failures; risk and backoff gates are
rejected decisions recorded in the audit trail, not execution failures.

## Agent runtime overlay

Beam integrates with agent harnesses at two layers:

1. **Operating boundary (always on)** — a harness drives Beam through the `beam` CLI
   and the auto-discovered skill files (`skills/`, `marketplaces/`), e.g.
   `beam status --message` for a chat-ready summary. See
   [docs/agent-harness.md](docs/agent-harness.md).
2. **Decision overlay (opt-in)** — set `AGENTIC_MODE=true` and Beam connects *back* to
   a local agent harness so it can **review each decision and receive proactive
   check-ins/alerts**. No remote LLM API keys are used. The overlay can only reduce
   confidence or change an action to `HOLD`; it can never raise confidence, promote to
   `ENTER`, or force an `EXIT`.

### Decision-review runtimes (the overlay)

These review each decision (`sendPrompt` -> a JSON override that can only lower
confidence or switch to `HOLD`). `AGENT_RUNTIME` (`auto` by default) selects one:

| Runtime | Transport | Config | Notes |
| ------- | --------- | ------ | ----- |
| Any [ACP](https://agentclientprotocol.com) agent | stdio JSON-RPC | `AGENT_RUNTIME=hermes` (default), `AGENT_ACP_COMMAND`, `AGENT_ACP_ARGS` | Hermes (`hermes acp`), Claude Code, Codex CLI, Gemini CLI, OpenCode, or any ACP-compatible agent. Beam speaks canonical ACP v1 (`initialize` / `session/new` / `session/prompt`, reply streamed via `session/update`). Point `AGENT_ACP_COMMAND`/`AGENT_ACP_ARGS` at any ACP agent (e.g. `npx -y @agentclientprotocol/codex-acp`). |
| OpenClaw | Gateway WebSocket | `AGENT_RUNTIME=openclaw`, `AGENT_GATEWAY_URL`, `AGENT_GATEWAY_TOKEN` | Requires **OpenClaw >= 2026.7.1** (gateway protocol v4). `AGENT_GATEWAY_TOKEN` is required: on loopback a valid shared token lets Beam's `cli` client keep its scopes without device pairing. Beam reviews decisions via `chat.send`. |

### Delivery transports (alerts + check-ins)

These fan out **alerts and check-ins** when configured. They do **not** review
decisions — decision review uses one of the runtimes above — and they run
independently and additively alongside it.

| Transport | Config | Notes |
| --------- | ------ | ----- |
| OpenClaw webhook | `AGENT_OPENCLAW_WEBHOOK_URL`, `AGENT_OPENCLAW_WEBHOOK_TOKEN` | POSTs alerts + check-ins to the webhook; use when a persistent WebSocket is not desired. |
| Hermes HTTP API | `AGENT_HERMES_API_URL`, `AGENT_HERMES_API_TOKEN` | POSTs alerts + check-ins as user messages to `{base}/v1/chat/completions` (model `hermes-agent`); the Bearer token is Hermes' `API_SERVER_KEY`. |


Beam also exposes pull interfaces for agent runtimes to query state on demand:

- **MCP server** (stdio): tools `beam_status`, `beam_positions`, `beam_decisions`, `beam_config`. Enable with `AGENT_MCP_ENABLED=true` (disabled by default).
- **HTTP fallback** on `127.0.0.1:AGENT_HTTP_PORT` (default `0`, disabled): `GET /status`, `/positions`, `/decisions`, `/config`, `/health`. Set `AGENT_HTTP_PORT` to a non-zero port to enable.

| Variable                        | Default                    | Description                                          |
| ------------------------------- | -------------------------- | ---------------------------------------------------- |
| `AGENTIC_MODE`                 | `false`                    | Enable the decision overlay                          |
| `AGENT_RUNTIME`                 | `auto`                     | `auto`, `hermes` (ACP), `openclaw` (gateway), or `none` |
| `AGENT_ACP_COMMAND`             | `hermes`                   | Executable for the ACP runtime (any ACP agent)       |
| `AGENT_ACP_ARGS`                | `acp`                      | Arguments passed to the ACP command                  |
| `AGENT_GATEWAY_URL`             | `ws://127.0.0.1:18789`     | OpenClaw Gateway WebSocket URL                       |
| `AGENT_GATEWAY_TOKEN`           | ``                         | OpenClaw shared gateway token (required for the gateway transport) |
| `AGENT_OPENCLAW_WEBHOOK_URL`    | ``                         | OpenClaw webhook URL for alert/check-in delivery      |
| `AGENT_OPENCLAW_WEBHOOK_TOKEN`  | ``                         | Bearer token for the OpenClaw webhook                |
| `AGENT_HERMES_API_URL`          | ``                         | Hermes HTTP API base URL (OpenAI-compatible)         |
| `AGENT_HERMES_API_TOKEN`        | ``                         | Bearer token (Hermes `API_SERVER_KEY`) for the Hermes HTTP API |
| `AGENT_PROMPT_TIMEOUT_MS`       | `60000`                    | Prompt/check-in timeout (slow-model first-token latency can exceed 15s) |
| `AGENT_VETO_TIMEOUT_MS`         | `AGENT_PROMPT_TIMEOUT_MS`  | Inline veto-review timeout; clamp [1s, 5min]               |
| `AGENT_CHECKIN_INTERVAL_MS`     | `3600000`                  | Periodic check-in interval                           |
| `AGENT_CHECKIN_ON_EVENTS`       | `true`                     | Check-in on ENTER/EXIT/REBALANCE                     |
| `AGENT_CHECKIN_INCLUDE_HISTORY` | `true`                     | Include recent decisions/warnings                    |
| `AGENT_CHECKIN_MAX_POSITIONS`   | `10`                       | Max positions in check-in summary                    |
| `AGENT_HTTP_PORT`               | `0`                        | Local HTTP status API port (`0` disables)            |
| `AGENT_MCP_ENABLED`             | `false`                    | Expose MCP tools over stdio                          |

## Messaging summary

When Beam runs under an agent runtime that owns messaging channels (Telegram, WhatsApp, Discord, Slack, etc.), the runtime can call:

```bash
beam status --message
```

This returns a short markdown summary with emojis and bullets, formatted for chat apps. Beam never sends messages directly; the agent runtime forwards summaries and alerts to the user's preferred channel.

## Risk gates

Decisions pass through checks in order before any on-chain action:

1. EXIT -> always approved (capital protection beats the confidence gate)
2. Confidence below `CONFIDENCE_THRESHOLD` -> reject
3. Max concurrent positions reached -> reject ENTER
   - Multiple positions per pool are allowed; `MAX_POSITIONS_PER_POOL` and
     `MAX_PER_POOL_ALLOCATION_PCT` cap same-pool exposure and aggregate allocation.
4. Portfolio drawdown > 10% -> pause new entries
5. Stop-loss triggered (`STOP_LOSS_PCT` exceeded) -> reject HOLD/REBALANCE
6. Position size > `MAX_PER_POOL_ALLOCATION_PCT` (default 40%) of portfolio -> cap and allow
7. Rebalance range > `MAX_REBALANCE_RANGE_BINS` -> reject REBALANCE

HOLD executes nothing, so it skips risk evaluation entirely. Deterministic EXIT conditions only fire for pools with a tracked position.

### Entry and IL-protection gates (run inside the decision loop)

- **Entry fee/IL floor** (`IL_PROTECTION_ENABLED` + `MIN_FEE_IL_RATIO`): when IL protection is on, ENTER is rejected when the pool's fee/IL ratio is below the minimum — entry fees must beat estimated IL. The ratio is never unknown, so this fails closed on 0.
- **Depeg / liquidity-drain gate**: a position leg that depegs from its stablecoin peg (`DEPEG_ABSOLUTE_USD` / `DEPEG_RELATIVE_PCT`) or whose pool liquidity drains (`LIQUIDITY_DRAIN_PCT`) triggers an exit. Stablecoin tokens on `STABLECOIN_MINTS` are exempt from depeg screening (allowlist); unknown signals fail closed.
- **IL-dominance EXIT**: while a position is out of range, if its impermanent loss (USD) exceeds cumulative claimed fees × `IL_DOMINANCE_EXIT_FACTOR` and `IL_DOMINANCE_MIN_USD`, the position exits immediately.

### Rebalance-specific gates (run inside the decision loop, not at execution)

- **Gas-aware** (`GAS_AWARE_MIN_DAYS_OF_FEES_PAID_AHEAD`): skip REBALANCE when the on-chain gas cost would not be repaid by N days of position fees (default 3 days)
- **Volatility-adjusted sizing** (`VOLATILITY_EXIT_STDDEV`): if recent active-tick stddev exceeds the threshold AND drift > 60%, EXIT to wallet instead of REBALANCE
- **OOR recovery prediction** (`OOR_RECOVERY_HOLD_THRESHOLD`): if mean-reversion probability > threshold, HOLD and wait for the price to come back; below `OOR_RECOVERY_FORCE_REBALANCE_THRESHOLD`, REBALANCE regardless
- **Multi-pool allocation** (`MAX_PER_POOL_ALLOCATION_PCT`): ENTER is capped so a single pool cannot exceed this percentage of the portfolio.
- **Open-positions concurrency** (`MAX_OPEN_POSITIONS`): ENTER is rejected when this many positions are already open.
- **Same-pool exposure** (`MAX_POSITIONS_PER_POOL` and `MAX_PER_POOL_ALLOCATION_PCT`): multiple positions in one pool are allowed up to the configured count and aggregate allocation cap.

### Live-trading gate

- **Paper-trading validation** (`PAPER_VALIDATION_MIN_DAYS` × `PAPER_VALIDATION_ENFORCE`): when `enforce=true`, live ENTER is blocked until the engine has accumulated N days of paper trading. Day count persists in the metadata table across restarts.

## Stack

- **Runtime**: Bun 1.4.0
- **Strategy**: Rule-based engine over Uniswap v3/v4 tick ranges
- **Memory**: SQLite + sqlite-vec vector memory with automatic expiry
- **On-chain**: viem + `@uniswap/v3-sdk` + `@uniswap/v4-sdk`, Robinhood Chain RPC
- **Config**: Effect-TS Config module with `orElseSucceed` fallbacks; every value has a sensible default and test mode auto-injects dummy API keys

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full component map and agent loop.
