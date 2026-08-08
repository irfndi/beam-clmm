---
name: beam-openclaw
version: "0.0.31"
description: >
  Operate Beam, an autonomous Solana DLMM liquidity agent for Meteora pools,
  through the OpenClaw Gateway. Use when the user asks about "beam", "DLMM",
  "liquidity agent", "Meteora pools", "rebalance positions", "paper trade Solana",
  or wants the agent to check/trade/manage Beam positions.
license: MIT
author: irfndi
homepage: https://github.com/irfndi/beam-clmm
tags: [evm, defi, liquidity, uniswap-v3, uniswap-v4, trading-agent]
compatibility: Requires Bun 1.4+, the `beam` CLI, and a Helius RPC key.
user-invocable: true
metadata:
  openclaw:
    emoji: "🔺"
    requires:
      bins: ["beam"]
    os: ["darwin", "linux"]
    capabilities:
      - mcp
      - http
---

# Beam Liquidity Agent (OpenClaw)

Beam is an autonomous liquidity agent for Solana Meteora DLMM pools. This skill
lets OpenClaw query Beam, receive alerts, and remind the user to check positions.

## When to use

- User asks about liquidity pool management on Solana.
- User wants to start, stop, configure, or monitor the Beam trading agent.
- User says "check my Beam positions", "any alerts from Beam?", or "should I rebalance?"
- Beam sent an alert via the OpenClaw Gateway and the user replies for context.

## Quick start

```bash
# Configure (non-interactive)
beam setup --non-interactive --rpc-url=$ROBINHOOD_RPC_URL

# Start with OpenClaw overlay enabled
export AGENTIC_MODE=true
export AGENT_RUNTIME=openclaw
export AGENT_GATEWAY_URL=ws://127.0.0.1:18789
beam dev
```

## Regular checks

OpenClaw should remind the user every hour while Beam is running:

```bash
# Run from this skill's scripts folder
{baseDir}/scripts/beam-checkin.sh
```

This fetches a short markdown summary suitable for Telegram/Discord/Slack/WhatsApp.

## On-demand queries

| Query | Command |
|-------|---------|
| Full JSON status | `beam status --json` |
| Messaging summary | `{baseDir}/scripts/beam-checkin.sh` |
| Open positions | `curl -s http://127.0.0.1:18790/positions` |
| Recent decisions | `curl -s http://127.0.0.1:18790/decisions` |

## Decision flow

For each pool on each scan cycle:

1. Fetch pool state and bin array from Meteora via Helius RPC.
2. Compute metrics: fee/IL ratio, volume authenticity, bin utilization, TVL velocity.
3. Apply decision rules: EXIT → REBALANCE → HOLD → ENTER.
4. Run risk gates: confidence, max positions, allocation cap.
5. Execute in paper or live mode.

## Alert priorities

When Beam sends an alert through the Gateway, surface it according to priority:

- `critical` — immediate notification (TVL collapse, trailing stop, stop-loss).
- `warning` — batched or quiet notification (volume auth drop, fee/IL drop, large unrealized loss).
- `info` — included in the next hourly summary (ENTER, REBALANCE).

## Files

- [references/agent-runtime.md](../beam/references/agent-runtime.md) — Full setup guide.
- [references/decision-rules.md](../beam/references/decision-rules.md) — Decision logic.
- [references/env-vars.md](../beam/references/env-vars.md) — Environment variables.
- [scripts/beam-checkin.sh](scripts/beam-checkin.sh) — Messaging-friendly summary.
