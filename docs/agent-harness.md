# Agent Harness Integration

Beam is designed to be operated by AI agent harnesses (OpenClaw, Hermes, acpx, custom agents) as well as humans. The Cloudflare infrastructure is already deployed — agents only need to clone, register, and start the agent.

## Supported Agent Platforms

Every harness operates Beam through the `beam` CLI plus the auto-discovered skill
files. On top of that, harnesses that implement a supported runtime protocol can plug
into Beam's opt-in *decision overlay* (`AGENTIC_MODE=true`) to review decisions and
receive check-ins/alerts — see the
[README agent runtime overlay](../README.md#agent-runtime-overlay) for the env vars.

| Platform / runtime | Operating boundary | Decision review (`AGENTIC_MODE=true`) |
| ------------------ | ------------------ | ------------------------------------- |
| Hermes | CLI + `skills/beam-hermes/` | **ACP** (`AGENT_RUNTIME=hermes`, `hermes acp`) |
| OpenClaw | CLI + `skills/beam-openclaw/` | **Gateway WebSocket** (`AGENT_RUNTIME=openclaw`, gateway protocol v4 / OpenClaw >= 2026.7.1, token required) |
| Any [ACP](https://agentclientprotocol.com) agent (Claude Code, Codex CLI, Gemini CLI, OpenCode, …) | CLI | **ACP** via `AGENT_ACP_COMMAND` / `AGENT_ACP_ARGS` |
| acpx / custom | CLI wrapper / `skills/beam/` | ACP (above), or the local **MCP server** / HTTP pull interfaces |

Decision review is performed by the ACP runtime or the OpenClaw gateway. Independently,
the HTTP delivery transports — the OpenClaw webhook (`AGENT_OPENCLAW_WEBHOOK_URL`) and
the Hermes HTTP API (`AGENT_HERMES_API_URL`) — fan out **alerts and check-ins** when
configured; they do not review decisions.

## Skills (auto-discovered by agent harnesses)

Beam ships two kinds of skill files:

1. **Installation guide skills** — teach the agent harness how to install Beam. These live in [`marketplaces/`](../marketplaces/) and [`.agents/skills/`](../.agents/skills/).
2. **Runtime skills** — let the agent harness query and receive alerts from a running Beam instance. These live in [`skills/beam/`](../skills/beam/), [`skills/beam-openclaw/`](../skills/beam-openclaw/), and [`skills/beam-hermes/`](../skills/beam-hermes/).

### Installation guide skills

| Harness | Local install path | Skill file |
|---|---|---|
| OpenCode | `~/.config/opencode/skills/beam-install/SKILL.md` | [`marketplaces/opencode/SKILL.md`](../marketplaces/opencode/SKILL.md) |
| OpenClaw | `~/.openclaw/skills/beam-install/SKILL.md` | [`marketplaces/openclaw/SKILL.md`](../marketplaces/openclaw/SKILL.md) |
| Hermes | `~/.hermes/skills/software-development/beam-install/SKILL.md` | [`marketplaces/hermes/SKILL.md`](../marketplaces/hermes/SKILL.md) |
| acpx / custom | `~/.agents/skills/beam-install.md` | [`.agents/skills/beam-install.md`](../.agents/skills/beam-install.md) |

### Runtime skills

Place these in the harness's runtime skills directory after Beam is installed and configured:

| Skill | Runtime | Local install path | When to install |
|-------|---------|-------------------|-----------------|
| `skills/beam/` | Universal | `~/.agents/skills/beam` or `~/.hermes/skills/beam` | Works with any AgentSkills-compatible runtime |
| `skills/beam-openclaw/` | OpenClaw | `~/.agents/skills/beam-openclaw` | Best OpenClaw integration |
| `skills/beam-hermes/` | Hermes | `~/.hermes/skills/beam-hermes` | Enables hourly blueprint check-ins |

```bash
# OpenClaw runtime skill
ln -s $(pwd)/skills/beam-openclaw ~/.agents/skills/beam-openclaw

# Hermes runtime skill
ln -s $(pwd)/skills/beam-hermes ~/.hermes/skills/beam-hermes

# Universal runtime skill (fallback)
ln -s $(pwd)/skills/beam ~/.agents/skills/beam
```

For the full status of all 10 target marketplaces (including the 6 that still need code packages — MCP server, AutoGPT, LangChain, CrewAI, Dify, Flowise), see [`../marketplaces/README.md`](../marketplaces/README.md).

## Infrastructure (self-hosted)

Beam runs standalone. The hosted Beam Cloud control plane (Cloudflare Workers +
D1) was retired when the project moved to a self-hosted VPS, so **there is no
account layer**. Agents never register, log in, or hold an API key.

| Layer | Status |
| ----- | ------ |
| CLI / engine | Local, required. State in SQLite, operator surface is the local status server |
| Cloud API (accounts, keys, tiers) | Retired — removed with the control plane |
| Telegram bot | Retired with the API layer it used for auth |

Alerts are written to the audit log instead of being pushed to Telegram. Leave
`BEAM_CLOUD_ENABLED` unset; setting it to `true` opts back into a hosted control
plane and expects `BEAM_API_URL` to point at one you operate.

## Quick Start for Agents

```bash
# Install the compiled bundle for your platform (auto-installs Bun if needed)
curl -fsSL https://raw.githubusercontent.com/irfndi/beam-clmm/main/scripts/install.sh \
  | BEAM_SKIP_SETUP=1 bash
export PATH="$HOME/.local/bin:$PATH"

# Setup (writes .env). No account or registration step.
beam setup --non-interactive --rpc-url="$BEAM_BASE_RPC_URL"

# Start trading
beam dev
```

Validate: the agent starts scanning. Check `logs/audit-trail.jsonl` for decisions.

### Common Mistakes

1. **Inventing a registration step.** `beam register`, `beam login`,
   `beam whoami`, `beam link-telegram`, `beam subscription`, `beam referral`,
   `beam issue` and `beam support` were removed with the control plane. Do not
   script them; they fail with "command not found".
2. **Setting `BEAM_CLOUD_ENABLED=true` without a control plane.** Alerts, status
   reports and error telemetry then target a dead endpoint. Leave it unset.
3. **Bypassing the `beam` wrapper.** Invoke `beam` so the install root and config
   dirs resolve consistently. Developing on Beam itself? Use `bun run dev`.
4. **Editing `.env` by hand after `beam setup`.** Re-run setup instead.

### Agent-Driven Onboarding

There is one path now — install, setup, run:

```bash
curl -fsSL https://raw.githubusercontent.com/irfndi/beam-clmm/main/scripts/install.sh \
  | BEAM_SKIP_SETUP=1 bash
export PATH="$HOME/.local/bin:$PATH"
beam setup --non-interactive --rpc-url="$BEAM_BASE_RPC_URL"
beam dev &
beam status --message
```

No HTTP registration API exists to call. For programmatic access use the CLI
(`beam status`, `beam portfolio`, `beam config`) or the local status server
(`AGENT_HTTP_PORT`, bound to 127.0.0.1, gated by `AGENT_PROPOSAL_TOKEN`).


## Environment for Agents

Agents should set these env vars before running beam commands:

```bash
export ROBINHOOD_RPC_URL="https://rpc.mainnet.chain.robinhood.com"  # OPTIONAL with custom RPC
export ROBINHOOD_RPC_URL="https://your-paid-rpc.example.com"
export ROBINHOOD_RPC_FALLBACK_URL="https://your-second-rpc.example.com" # OPTIONAL
export WALLET_PRIVATE_KEY="..."                    # OPTIONAL (for live trading only)
```

Optional agent-runtime overlay (lets a local Hermes/OpenClaw/ACP harness review decisions):

```bash
export AGENTIC_MODE="true"
export AGENT_RUNTIME="auto"                      # auto | hermes | openclaw | none
# ACP runtime (any ACP agent: hermes, claude code, codex, gemini, opencode, ...)
export AGENT_ACP_COMMAND="hermes"
export AGENT_ACP_ARGS="acp"
# OpenClaw gateway (requires OpenClaw >= 2026.7.1, gateway protocol v4)
export AGENT_GATEWAY_URL="ws://127.0.0.1:18789"
export AGENT_GATEWAY_TOKEN=""                    # shared gateway token (required for the gateway transport)
# HTTP alert/check-in transports
export AGENT_OPENCLAW_WEBHOOK_URL=""             # OpenClaw webhook (POSTs to /hooks/agent)
export AGENT_OPENCLAW_WEBHOOK_TOKEN=""
export AGENT_HERMES_API_URL=""                   # Hermes OpenAI-compatible API base URL
export AGENT_HERMES_API_TOKEN=""                 # Hermes API_SERVER_KEY (Bearer)
export AGENT_PROMPT_TIMEOUT_MS="15000"
export AGENT_CHECKIN_INTERVAL_MS="3600000"
export AGENT_CHECKIN_ON_EVENTS="true"
export AGENT_CHECKIN_INCLUDE_HISTORY="true"
export AGENT_CHECKIN_MAX_POSITIONS="10"
export AGENT_HTTP_PORT="0"                      # local HTTP status API; non-zero enables, 0 disables
export AGENT_MCP_ENABLED="false"                # expose MCP tools to agent runtime; true enables
```

The overlay can only reduce confidence or change an action to `HOLD`. No remote LLM
API keys are used. The ACP runtime speaks canonical ACP v1; the OpenClaw gateway
transport speaks gateway protocol v4 — on loopback a valid shared token lets Beam's
`cli` client keep its scopes without device pairing.

## Agent Pull Interfaces (MCP + HTTP)

When `AGENTIC_MODE=true`, Beam exposes two pull interfaces so the agent runtime can query state on demand instead of waiting for push check-ins.

### MCP Server (stdio)

Disabled by default (`AGENT_MCP_ENABLED=false`). Beam implements a minimal MCP server over stdio with these tools:

| Tool | Input | Output |
|------|-------|--------|
| `beam_status` | `{}` | Uptime, scan count, portfolio summary |
| `beam_positions` | `{pool?: string}` | Open positions with deposited/current value and bin ranges |
| `beam_decisions` | `{limit?: number, pool?: string}` | Recent decision history |
| `beam_config` | `{}` | Sanitized config (no secrets) |

Both Hermes and OpenClaw can connect to Beam as an MCP client. When the agent runtime launches Beam via `beam dev`, the MCP server is available on the same stdio pipe.

### HTTP Fallback

Enabled when `AGENT_HTTP_PORT` is non-zero (default `0`, disabled). Runs on `127.0.0.1` only:

| Endpoint | Description |
|----------|-------------|
| `GET /health` | `{ok: true, uptimeMs, version}` |
| `GET /status` | Portfolio summary, scan count, uptime |
| `GET /positions?pool=...` | Open positions (optionally filtered by pool) |
| `GET /decisions?limit=...&pool=...` | Recent decisions |
| `GET /config` | Sanitized config (no secrets) |

Example:

```bash
curl http://127.0.0.1:18790/status | jq .
```

The HTTP server is a fallback for runtimes that do not yet support MCP. Runtimes that support MCP should prefer the MCP tools.

## Skills Matrix

Beam ships runtime skills for agent harnesses. See [Skills](#skills-auto-discovered-by-agent-harnesses) above for install paths.

| Skill | Runtime | Purpose |
|-------|---------|---------|
| `skills/beam/` | Universal | Works with any AgentSkills-compatible runtime |
| `skills/beam-openclaw/` | OpenClaw | OpenClaw-specific metadata and hourly check-in script |
| `skills/beam-hermes/` | Hermes | Hermes blueprint for hourly scheduled check-ins |

To publish to skills.sh, submit the `skills/beam/` directory (or the runtime-specific variants) following the [AgentSkills specification](https://agentskills.io).

## Scheduled check-ins (cron / blueprint)

Hermes users get hourly check-ins automatically via the `metadata.hermes.blueprint` schedule declared in `skills/beam-hermes/SKILL.md`.

OpenClaw and other runtimes can use a cron job or built-in scheduler to call:

```bash
beam status --message
```

This returns a short markdown summary suitable for Telegram, WhatsApp, Discord, Slack, or any messaging channel the runtime owns.

## acpx Integration

Beam works with the following OpenCode skills (for OpenCode-based agents):

| Skill               | Relevance | Use Case                             |
| ------------------- | --------- | ------------------------------------ |
| `git-master`        | 🔴 High   | Git operations on the repo           |
| `web-perf`          | 🟢 Low    | Performance analysis (rarely needed) |
| `security-research` | 🟢 Low    | Security audits (rarely needed)      |

Most Beam operations don't need special skills — the CLI is self-contained.

## acpx Integration

acpx (Agent Command Protocol eXtended) can wrap Beam CLI commands:

```yaml
# acpx.yaml
commands:
  beam-setup:
    cmd: beam setup --non-interactive --rpc-url={{rpc_url}} --rpc-fallback-url={{rpc_fallback_url}}
    description: Configure Beam with private RPC providers
    args:
      rpc_url:
        required: true
      rpc_fallback_url:
        required: false

  beam-dev:
    cmd: beam dev
    description: Start paper trading agent

  beam-whoami:
    cmd: beam whoami
    description: Get current user account info

  beam-update:
    cmd: beam update
    description: Check for and apply updates
```

## Operator Runbook (for human operators, not agents)

### Daily Checks

```bash
# Check agent status
beam whoami

# View recent decisions
tail -f logs/audit-trail.jsonl
```

### Weekly Tasks

```bash
# Update watchlist
beam setup --watchlist "new-pool-1,new-pool-2"

# Run backtest to verify strategy
bun run backtest --days 7
```

### Monthly Tasks

```bash
# Renew subscription if needed
beam subscription renew --tier pro

# Update to latest version
beam update
```

## Troubleshooting

| Symptom                             | Cause               | Fix                                                     |
| ----------------------------------- | ------------------- | ------------------------------------------------------- |
| "RPC error"                          | RPC down           | Re-run `beam setup` with correct RPC URL            |
| "No wallet configured"              | Missing private key | Add `WALLET_PRIVATE_KEY` to `.env` or use paper trading |
| "Pool not found"                    | Invalid watchlist   | Check pool addresses with `beam setup`                 |

## Reference

- Main README: [`../README.md`](../README.md)
- Install guide: [`install.md`](install.md)
- CLI reference: [`cli.md`](cli.md)
- Cron examples: [`cron-examples.md`](cron-examples.md)
- Deployment (pm2, operators only): [`../AGENTS.md`](../AGENTS.md) and `../pm2.ecosystem.config.cjs`
- AGENTS.md: [`../AGENTS.md`](../AGENTS.md)
