# Agent Runtime Setup Guide

This guide is for users who want Beam to communicate with a local agent runtime
(Hermes or OpenClaw) instead of using remote LLM APIs.

## What the overlay does

When `AGENTIC_MODE=true`, Beam asks the local agent runtime to review decisions
and sends proactive check-ins. The overlay is **safety-bounded**:

- It can only reduce confidence or change an action to `HOLD`.
- It can never increase confidence or promote a non-ENTER action to `ENTER`.

## Hermes (ACP over stdio)

1. Install Hermes from https://github.com/NousResearch/hermes-agent.
2. Ensure `hermes` is on your PATH.
3. Set in `.env`:

```bash
AGENTIC_MODE=true
AGENT_RUNTIME=hermes
AGENT_ACP_COMMAND=hermes
AGENT_ACP_ARGS=acp
```

4. Start Beam: `beam dev`

Beam spawns `hermes acp` as a child process and communicates via JSON-RPC over
stdin/stdout.

## OpenClaw (Gateway WebSocket)

1. Install OpenClaw from https://github.com/openclaw/openclaw.
2. Start the Gateway: `openclaw gateway`
3. Set in `.env`:

```bash
AGENTIC_MODE=true
AGENT_RUNTIME=openclaw
AGENT_GATEWAY_URL=ws://127.0.0.1:18789
AGENT_GATEWAY_TOKEN=your-token
```

4. Start Beam: `beam dev`

Beam connects to the OpenClaw Gateway WebSocket and sends prompts/check-ins.

## Messaging apps (Telegram, Discord, Slack, WhatsApp)

Beam does **not** send messages directly. The agent runtime (Hermes/OpenClaw)
owns the messaging channel configuration and forwards Beam check-ins/alerts to
the user's preferred app.

To receive alerts:

1. Configure the messaging channel in your agent runtime (e.g., Telegram bot
   token in OpenClaw `channels.telegram`).
2. Ensure `AGENT_CHECKIN_ON_EVENTS=true` in Beam `.env`.
3. The runtime will surface ENTER/EXIT/REBALANCE check-ins and periodic summaries.

## Webhook alerts (OpenClaw)

If you prefer HTTP webhooks, set:

```bash
AGENT_OPENCLAW_WEBHOOK_URL=http://127.0.0.1:18789/hooks/agent
AGENT_GATEWAY_TOKEN=your-token
```

Beam will POST structured alerts to that endpoint.

## Periodic check-ins

By default Beam sends a check-in every hour. Adjust with:

```bash
AGENT_CHECKIN_INTERVAL_MS=3600000
```

## Querying Beam from the agent

Agents can call:

```bash
beam status --json
```

This returns portfolio, positions, recent decisions, and agent runtime config.
