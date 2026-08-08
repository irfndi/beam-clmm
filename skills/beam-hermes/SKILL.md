---
name: beam-hermes
version: "0.0.31"
description: >
  Operate Beam, an autonomous Solana DLMM liquidity agent for Meteora pools,
  through Hermes ACP. Use when the user asks about "beam", "DLMM", "liquidity
  agent", "Meteora pools", "rebalance positions", "paper trade Solana", or wants
  the agent to check/trade/manage Beam positions.
license: MIT
author: irfndi
homepage: https://github.com/irfndi/beam-clmm
platforms: [macos, linux]
metadata:
  hermes:
    tags: [evm, defi, liquidity, trading]
    category: defi
    requires_toolsets: [terminal]
    blueprint:
      schedule: "0 * * * *"
      deliver: origin
      prompt: "Check Beam status and alert the user to any important positions, decisions, or risks. Use `beam status --message` and summarize in 3-5 bullets."
      no_agent: false
---

# Beam Liquidity Agent (Hermes)

Beam is an autonomous liquidity agent for Solana Meteora DLMM pools. This skill
teaches Hermes how to query Beam, receive ACP check-ins, and remind the user to
review positions on a schedule.

## When to use

- User asks about liquidity pool management on Solana.
- User wants to start, stop, configure, or monitor the Beam trading agent.
- User says "check my Beam positions", "any alerts from Beam?", or "should I rebalance?"
- Beam sent a check-in or alert via ACP and the user replies for context.

## Quick start

```bash
# Configure (non-interactive)
beam setup --non-interactive --rpc-url=$ROBINHOOD_RPC_URL

# Start with Hermes overlay enabled
export AGENTIC_MODE=true
export AGENT_RUNTIME=hermes
export AGENT_ACP_COMMAND=hermes
export AGENT_ACP_ARGS=acp
beam dev
```

## Scheduled check-ins

This skill declares a Hermes blueprint that runs every hour. It should:

1. Call `beam status --message` for a messaging-friendly summary.
2. Summarize the result in 3-5 bullets.
3. Highlight any critical or warning alerts first.
4. Ask the user if they want to review positions in detail.

## On-demand queries

| Query | Command |
|-------|---------|
| Full JSON status | `beam status --json` |
| Messaging summary | `beam status --message` |
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

When Beam sends an alert through ACP, surface it according to priority:

- `critical` — immediate notification (TVL collapse, trailing stop, stop-loss).
- `warning` — batched or quiet notification (volume auth drop, fee/IL drop, large unrealized loss).
- `info` — included in the next hourly summary (ENTER, REBALANCE).

## Files

- [references/agent-runtime.md](../beam/references/agent-runtime.md) — Full setup guide.
- [references/decision-rules.md](../beam/references/decision-rules.md) — Decision logic.
- [references/env-vars.md](../beam/references/env-vars.md) — Environment variables.
