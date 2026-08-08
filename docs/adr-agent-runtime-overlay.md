# ADR: Agent Runtime Overlay Architecture

**Status**: Accepted — Phase 1 & 2 implemented
**Date**: 2026-07-03
**Deciders**: Beam core team
**Relates to**: `engine/agent-transport.ts`, `engine/acp-transport.ts`, `engine/gateway-transport.ts`, `engine/agent-service.ts`, `engine/mcp-server.ts`, `engine/http-status-server.ts`, `skills/beam/`

> **Implementation note**: Phase 1 (alerts, dual-runtime skill metadata, `beam status --json`) and the core of Phase 2 (MCP server, HTTP fallback API) are implemented and passing CI. Phase 3 items (A2A Agent Card, Skill Workshop integration, `beam_analyze`/`beam_simulate` tools) remain future work.

---

## TL;DR

Beam's current agent-runtime overlay is **architecturally correct but incomplete**. The transport abstraction, decision review, and check-in patterns are sound. What's missing is: (a) a standard discovery mechanism so agent runtimes can find Beam without config, (b) a local query API for the agent to pull status on demand, (c) a messaging adapter so Beam-initiated events reach users via whatever channel the agent runtime owns, and (d) proper skill packaging for Hermes and OpenClaw discovery.

We recommend a **3-phase incremental approach** that keeps the existing code, adds an MCP server for standard tool exposure, adds a thin local HTTP status API, and ships skill packages for both runtimes.

---

## Context

Beam is a deterministic rule-based CLMM trading agent (Uniswap v3/v4 on Robinhood Chain). When run standalone, it operates autonomously with no human-in-the-loop beyond initial configuration. When run under an agent runtime (Hermes, OpenClaw, or similar), we want a non-deterministic overlay that:

1. Lets the agent **review decisions** before execution (reduce confidence or veto to HOLD)
2. Provides **proactive check-ins** on schedule and on key events (ENTER/EXIT/REBALANCE)
3. Exposes Beam's **status and state** to the agent for on-demand queries
4. Lets the agent **notify the user** via whatever messaging channel it owns

### What already exists

| File | What it does | Status |
|------|-------------|--------|
| `engine/agent-transport.ts` | Transport interface (`AgentRuntimeTransport`), types for context/response/checkin/events | ✅ Sound abstraction |
| `engine/acp-transport.ts` | Hermes ACP stdio JSON-RPC 2.0 transport | ✅ Works, matches real ACP spec |
| `engine/gateway-transport.ts` | OpenClaw Gateway WebSocket transport | ✅ Works, matches real Gateway protocol |
| `engine/agent-service.ts` | Decision overlay + check-in dispatch, transport selection, response parsing/validation | ✅ Core logic correct |
| `engine/agent-detection.ts` | Auto-detect Hermes binary and OpenClaw Gateway | ✅ Works |
| `skills/beam/SKILL.md` | Skill package with frontmatter + references | ⚠️ Incomplete, missing runtime-specific metadata |

### Key research findings

**OpenClaw** (TypeScript daemon, ~380K GitHub stars):
- Gateway WebSocket on `127.0.0.1:18789` — text frames with JSON payloads
- Protocol: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
- Events: `{type:"event", event, payload}`
- Skills discovered from `~/.agents/skills/`, `<workspace>/skills/`, `<workspace>/.agents/skills/`
- `SKILL.md` with YAML frontmatter (`metadata.openclaw.requires.bins`, `os`, `env`)
- Has built-in messaging: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, etc.
- Also supports MCP servers (`mcp.servers` config) and ACP bridge (`openclaw acp`)

**Hermes** (Python agent, Nous Research):
- ACP over stdio (JSON-RPC 2.0, Agent Client Protocol by Zed/JetBrains)
- Methods: `initialize`, `session/new`, `session/prompt`, `session/update`, `session/cancel`
- Also supports MCP (client + server via `hermes mcp serve`)
- Skills from `~/.hermes/skills/`, Skills Hub (skills.sh), external dirs
- `SKILL.md` with `metadata.herms.tags`, `category`, `requires_toolsets`
- Built-in messaging: 20+ platforms from single gateway process

**MCP** (Model Context Protocol, Anthropic/Linux Foundation):
- JSON-RPC 2.0 over stdio or Streamable HTTP
- `tools/list` for discovery, `tools/call` for invocation
- Notifications: `notifications/tools/list_changed`, `notifications/cancelled`, `notifications/progress`
- Current stable: `2025-11-25`. RC `2026-07-28` shipping soon
- Becoming the universal "agent ↔ tools" protocol

**ACP** (Agent Client Protocol, Zed/JetBrains):
- JSON-RPC 2.0 over stdio (NDJSON)
- `initialize` → `session/new` → `session/prompt` → `session/update` (streaming)
- Used by `acpx` CLI and Hermes
- Designed for editor ↔ coding agent, but generalizable

**Protocol landscape**:
- **MCP**: Agent ↔ tools/data (what Beam should expose)
- **ACP (Zed)**: Client ↔ agent (how Hermes communicates with Beam currently)
- **A2A** (Google/LF): Agent ↔ agent (emerging, not needed yet for Beam)
- **ACP (IBM/BeeAI)**: Deprecated, merged into A2A

---

## Decision Questions

### Q1: Is the current transport design right?

**Decision: Keep the current transport abstraction. Add MCP as a third transport for "Beam as tool server".**

Rationale:
- The `AgentRuntimeTransport` interface is correctly abstracted. It models the bidirectional flow: Beam sends prompts/checkins to the agent, agent responds.
- The ACP transport correctly implements JSON-RPC 2.0 over stdio with `initialize` → `session/new` → `session/prompt` → `session/update` — matching the real Agent Client Protocol spec.
- The Gateway transport correctly implements OpenClaw's WebSocket protocol with request/response framing and auth.
- These are **push transports** (Beam → agent): Beam sends a decision review prompt, agent responds.

What's missing is the **pull direction** (agent → Beam): the agent needs to query Beam for status, positions, metrics on demand. Two options:

| Option | Protocol | Tradeoff |
|--------|----------|----------|
| **A: Add MCP server to Beam** | JSON-RPC 2.0 over stdio | Universal standard. Both OpenClaw and Hermes can connect as MCP clients. Beam exposes `tools/call` for `beam_status`, `beam_positions`, `beam_decisions`. Most future-proof. |
| **B: Add local HTTP API** | REST on `127.0.0.1:<port>` | Simpler to implement. Agent can `curl localhost:PORT/status`. But non-standard; each runtime needs custom integration. |
| **C: File-based IPC** | JSON files in shared directory | Simplest. Agent reads `~/.beam/status.json`. But polling-based, no push, stale data risk. |

**Recommendation**: Option A (MCP server) as the primary interface, with Option B (HTTP) as a lightweight fallback for runtimes that don't support MCP.

Tradeoffs:
- MCP server adds ~200 lines of code but gives universal discoverability
- HTTP fallback adds ~100 lines but covers edge cases
- File-based IPC is not recommended (stale data, race conditions)

### Q2: Messaging integration — Beam push or agent runtime handle?

**Decision: Beam does NOT push to messaging. Beam emits structured events; the agent runtime routes them.**

Rationale:
- OpenClaw already owns WhatsApp, Telegram, Discord, Slack, Signal, iMessage via its Gateway.
- Hermes already owns 20+ platforms via its gateway process.
- If Beam tried to send Telegram messages directly, it would conflict with the agent runtime's connection (two bots fighting for the same webhook).
- The correct boundary: Beam produces a structured event (`{type: "checkin", ...}` or `{type: "alert", ...}`), sends it to the agent via the transport, and the agent runtime decides how to deliver it (Telegram, Slack, voice, etc.).

This is exactly what the current `sendCheckin` method does. What's missing:

1. **Alert events** (not just check-ins): Beam should be able to send urgent alerts (e.g., "position down 12%, approaching stop-loss") that the agent can relay immediately.
2. **Structured response format**: The agent should be able to respond with a delivery directive (`{deliver_to: "telegram", priority: "high"}`) — but this is the agent's concern, not Beam's.

**Implementation**: Add an `AgentRuntimeAlert` type alongside `AgentRuntimeCheckin`. Alerts have priority levels (`info`, `warning`, `critical`). The transport sends them the same way as check-ins. The agent runtime handles delivery.

### Q3: Skills package structure

**Decision: Ship two skill packages — one for OpenClaw, one for Hermes — plus a universal fallback.**

Rationale:
- OpenClaw and Hermes use the same `SKILL.md` format but different metadata keys and discovery paths.
- OpenClaw looks for `metadata.openclaw.requires.bins`, `metadata.openclaw.os`.
- Hermes looks for `metadata.herms.tags`, `metadata.herms.category`, `metadata.herms.requires_toolsets`.
- A universal skill (without runtime-specific metadata) works for both but loses gating/filtering.

Structure:

```
skills/
├── beam/                          # Universal skill (works everywhere)
│   ├── SKILL.md                    # Runtime-agnostic frontmatter
│   ├── scripts/
│   │   ├── beam-status.sh         # Status query helper
│   │   └── beam-alert.sh          # Alert forwarding helper
│   └── references/
│       ├── decision-rules.md
│       └── uniswap-clmm.md
├── beam-openclaw/                 # OpenClaw-specific (optional)
│   └── SKILL.md                    # metadata.openclaw gating
└── beam-hermes/                   # Hermes-specific (optional)
    └── SKILL.md                    # metadata.herms gating
```

For Phase 1, the universal `skills/beam/SKILL.md` is sufficient. Runtime-specific variants are a Phase 2 optimization for better gating.

### Q4: Cron/reminder pattern

**Decision: Beam schedules its own check-ins. The agent runtime does NOT need to set reminders.**

Rationale:
- Beam already has `AGENT_CHECKIN_INTERVAL_MS` (default 1h) and `AGENT_CHECKIN_ON_EVENTS` (true).
- Beam owns the scan loop timing. It knows when cycles run, when events happen.
- Asking the agent runtime to set reminders would require Beam to expose a "set reminder" tool and the agent to understand Beam's scheduling semantics — unnecessary complexity.
- The agent runtime's cron is for user-facing tasks (daily summary, weekly report), not for Beam's internal loop.

**What to add**: Beam should expose a `beam_subscribe` MCP tool that lets the agent register for specific event types with optional filtering:

```json
{
  "tool": "beam_subscribe",
  "args": {
    "events": ["enter", "exit", "critical_alert"],
    "pools": ["pool_addr_1"],
    "min_confidence": 0.8
  }
}
```

This is a Phase 2 feature. Phase 1 uses the existing periodic + event-driven check-ins.

### Q5: Two-way communication

**Decision: Beam → agent via existing transport (push). Agent → Beam via MCP server (pull).**

The two directions use different protocols because they have different characteristics:

| Direction | Mechanism | Latency | Use case |
|-----------|-----------|---------|----------|
| **Beam → agent** (push) | ACP stdio / Gateway WS | Synchronous (15s timeout) | Decision review, check-ins, alerts |
| **Agent → Beam** (pull) | MCP server / HTTP API | On-demand | Status query, position list, metrics, config |

This asymmetry is correct because:
- Beam's push events are **infrequent** (every scan cycle, every ENTER/EXIT) and need the agent's attention immediately.
- Agent's pull queries are **on-demand** (when the user asks "how are my positions?") and can wait for a response.

### Q6: Local HTTP/WebSocket server

**Decision: Yes, add a minimal HTTP server on `127.0.0.1:18790` as a fallback for runtimes that don't support MCP.**

The MCP server (stdio) is the primary interface. The HTTP server is a lightweight fallback:

```
GET  /status          → portfolio summary
GET  /positions       → open positions
GET  /decisions       → recent decisions
GET  /config          → current config (sanitized)
POST /subscribe       → register for events (SSE stream)
```

The HTTP server is optional (enabled via `AGENT_HTTP_PORT`). It shares state with the MCP server. For runtimes that support MCP (both OpenClaw and Hermes do), the HTTP server is unnecessary.

### Q7: Minimal changes vs. ideal architecture

**Minimal (Phase 1) — ship in ~1 week**:
1. Add `AgentRuntimeAlert` type to `agent-transport.ts`
2. Add alert sending to `agent-service.ts` (alongside check-ins)
3. Wire alerts into `program.ts` on ENTER/EXIT/REBALANCE when confidence is low or action is EXIT
4. Update `skills/beam/SKILL.md` with correct metadata for both runtimes
5. Add a `beam status` CLI command that outputs JSON (for agent consumption)

**Ideal (Phase 3) — ship over 1-2 months**:
1. Full MCP server with `tools/list` and `tools/call`
2. Local HTTP fallback API
3. `beam_subscribe` with SSE event stream
4. Runtime-specific skill packages with proper gating
5. Agent-created skill proposals (OpenClaw Skill Workshop integration)
6. A2A Agent Card at `/.well-known/agent.json` for cross-agent discovery

---

## Architecture Diagram

```
                    ┌─────────────────────────────────────────┐
                    │           Beam Engine                   │
                    │  program.ts (scan loop)                  │
                    │  ┌─────────┐  ┌──────────┐              │
                    │  │ Decision │  │ Risk     │              │
                    │  │ Rules    │→ │ Gates    │→ Execute     │
                    │  └────┬────┘  └──────────┘              │
                    │       │                                   │
                    │  ┌────▼────────────────────────────┐     │
                    │  │     Agent Service                │     │
                    │  │  enhanceDecision() ──push──→ Agent   │
                    │  │  sendCheckin()     ──push──→ Agent   │
                    │  │  sendAlert()       ──push──→ Agent   │
                    │  └────┬────────────────────────────┘     │
                    │       │                                   │
                    │  ┌────▼──────────┐  ┌───────────────┐   │
                    │  │ MCP Server    │  │ HTTP API       │   │
                    │  │ (stdio)       │  │ (127.0.0.1)    │   │
                    │  │ tools/list    │  │ GET /status    │   │
                    │  │ tools/call    │  │ GET /positions │   │
                    │  │ ──pull──→     │  │ ──pull──→      │   │
                    │  └────┬──────────┘  └───────┬───────┘   │
                    │       │                      │            │
                    └───────┼──────────────────────┼────────────┘
                            │                      │
              ┌─────────────▼──────────────────────▼─────────────┐
              │              Agent Runtime                        │
              │                                                   │
              │  ┌──────────────────────────────────────────┐    │
              │  │  Transport Layer                          │    │
              │  │  ┌──────────┐  ┌────────────────────┐    │    │
              │  │  │ ACP      │  │ Gateway WebSocket   │    │    │
              │  │  │ (Hermes) │  │ (OpenClaw)          │    │    │
              │  │  └────┬─────┘  └────────┬───────────┘    │    │
              │  │       └──────────────────┘                │    │
              │  └──────────────────┬───────────────────────┘    │
              │                     │                              │
              │  ┌──────────────────▼───────────────────────┐    │
              │  │  Agent Loop (LLM reasoning)               │    │
              │  │  - Reviews Beam decisions                 │    │
              │  │  - Processes check-ins                     │    │
              │  │  - Queries Beam status via MCP            │    │
              │  │  - Relays alerts to user                   │    │
              │  └──────────────────┬───────────────────────┘    │
              │                     │                              │
              │  ┌──────────────────▼───────────────────────┐    │
              │  │  Messaging Layer (agent-owned)            │    │
              │  │  ┌─────────┐ ┌─────────┐ ┌──────────┐   │    │
              │  │  │Telegram │ │Discord  │ │WhatsApp  │...│    │
              │  │  └─────────┘ └─────────┘ └──────────┘   │    │
              │  └──────────────────────────────────────────┘    │
              └───────────────────────────────────────────────────┘
```

---

## Detailed Design

### 1. Transport Interface (existing, extend)

```typescript
// engine/agent-transport.ts — add these types

export interface AgentRuntimeAlert {
  readonly type: "alert";
  readonly priority: "info" | "warning" | "critical";
  readonly trigger: "enter" | "exit" | "rebalance" | "stop_loss" | "trailing_stop" | "tvl_drop";
  readonly timestamp: number;
  readonly pool: string;
  readonly message: string;
  readonly metrics: {
    readonly action: string;
    readonly confidence: number;
    readonly pnlUsd: number;
    readonly hoursHeld: number;
  };
}

// Extend AgentRuntimeTransport interface:
export interface AgentRuntimeTransport {
  // ... existing methods ...
  readonly sendAlert?: (alert: AgentRuntimeAlert) => Effect.Effect<void, unknown>;
}
```

### 2. MCP Server (Phase 2)

A minimal MCP server exposing Beam's state as tools. Runs as a stdio subprocess when `AGENTIC_MODE=true`.

**Tools exposed:**

| Tool | Input | Output |
|------|-------|--------|
| `beam_status` | `{}` | Portfolio summary (value, PnL, position count, uptime) |
| `beam_positions` | `{pool?: string}` | Open positions with metrics |
| `beam_decisions` | `{limit?: number, pool?: string}` | Recent decision history |
| `beam_pool_metrics` | `{pool: string}` | Current metrics for a specific pool |
| `beam_config` | `{}` | Sanitized config (no secrets) |
| `beam_subscribe` | `{events: string[]}` | Register for event notifications (returns subscription ID) |

**Implementation location**: `engine/mcp-server.ts`

**Startup**: When `AGENTIC_MODE=true`, `engine/index.ts` spawns the MCP server as a child process. The agent runtime connects to it via stdio.

### 3. Alert System (Phase 1)

Alerts fire on high-signal events:

| Event | Priority | Condition |
|-------|----------|-----------|
| Position ENTER | `info` | New position opened |
| Position EXIT | `warning` | Position closed (any reason) |
| REBALANCE | `info` | Range shifted |
| Approaching stop-loss | `warning` | PnL within 2% of `STOP_LOSS_PCT` |
| Stop-loss triggered | `critical` | Position closed by stop-loss |
| TVL collapse | `critical` | Pool TVL dropped > 30% |
| Volume auth collapse | `warning` | Volume authenticity fell below threshold |
| Agent override | `info` | Agent runtime changed decision |

Alerts are sent via the same transport as check-ins. The agent runtime decides delivery channel.

### 4. Skill Packages (Phase 1)

Update `skills/beam/SKILL.md` to include dual-runtime metadata:

```yaml
---
name: beam
description: >
  Autonomous liquidity agent for Uniswap v3/v4 on Robinhood Chain.
metadata:
  openclaw:
    requires:
      bins: ["beam"]
    os: ["darwin", "linux"]
  hermes:
    tags: [evm, defi, liquidity, trading]
    category: defi
    requires_toolsets: [terminal]
---
```

### 5. Local HTTP API (Phase 2)

Minimal REST server on `127.0.0.1:18790` (configurable via `AGENT_HTTP_PORT`):

```
GET  /health              → {ok: true, uptime, version}
GET  /status              → portfolio summary
GET  /positions           → open positions
GET  /positions/:pool     → specific position
GET  /decisions?limit=10  → recent decisions
GET  /metrics/:pool       → pool metrics
GET  /config              → sanitized config
GET  /events              → SSE stream of alerts/checkins
```

The SSE endpoint (`GET /events`) lets agents subscribe to real-time events without polling.

---

## Tradeoff Analysis

### Why not make Beam an MCP server only?

MCP servers are tool-oriented (request/response). Beam's push events (check-ins, alerts) don't fit the MCP model well — MCP notifications are fire-and-forget, not structured events with delivery guarantees. The push transport (ACP/Gateway) is the right channel for Beam-initiated events. MCP is the right channel for agent-initiated queries.

### Why not use A2A?

A2A is designed for agent-to-agent task delegation across organizations. Beam and its agent runtime are co-located on the same machine, share the same user, and have a client-server relationship (Beam is a tool, not a peer). A2A adds unnecessary complexity (Agent Cards, task lifecycle, discovery) for no benefit.

### Why not file-based IPC?

Files are simple but have real problems:
- **Stale data**: Agent reads `status.json` 5 seconds after a cycle — data is already old.
- **Race conditions**: Beam writes while agent reads — partial JSON possible.
- **No push**: Agent must poll to discover new events.
- **No auth**: Any process on the machine can read/write.

MCP and HTTP solve all of these.

### Why keep the existing push transport alongside MCP?

Because they serve different purposes:
- **Push** (ACP/Gateway): Beam initiates, agent responds. Used for decision review and check-ins. Timing is controlled by Beam's scan loop.
- **Pull** (MCP/HTTP): Agent initiates, Beam responds. Used for status queries. Timing is controlled by the agent.

These are complementary, not competing.

---

## Phased Implementation Plan

### Phase 1: Minimal viable overlay (1 week)

**Goal**: Beam sends alerts alongside check-ins. Skills package works for both runtimes.

| Task | File | Change |
|------|------|--------|
| Add `AgentRuntimeAlert` type | `engine/agent-transport.ts` | ~15 lines |
| Add `sendAlert` to transport interface | `engine/agent-transport.ts` | ~3 lines |
| Implement `sendAlert` in ACP transport | `engine/acp-transport.ts` | ~20 lines |
| Implement `sendAlert` in Gateway transport | `engine/gateway-transport.ts` | ~15 lines |
| Wire alert dispatch in agent service | `engine/agent-service.ts` | ~30 lines |
| Fire alerts in program.ts on key events | `engine/program.ts` | ~40 lines |
| Add `beam status` CLI command | `cli/status.ts` | ~50 lines |
| Update skill SKILL.md with dual metadata | `skills/beam/SKILL.md` | ~10 lines |
| Add `beam-status.sh` improvements | `skills/beam/scripts/beam-status.sh` | ~20 lines |

**Deliverables**:
- Alerts fire on ENTER, EXIT, REBALANCE, stop-loss, TVL drop
- `beam status --json` outputs portfolio summary
- Skill works in both OpenClaw and Hermes without changes

### Phase 2: Standard protocol exposure (2-3 weeks)

**Goal**: Agent can query Beam on demand via MCP. Local HTTP fallback for non-MCP runtimes.

| Task | File | Change |
|------|------|--------|
| MCP server implementation | `engine/mcp-server.ts` | ~300 lines |
| Wire MCP server startup | `engine/program.ts` | ~30 lines |
| Add MCP config to config-service | `engine/config-service.ts` | ~15 lines |
| Local HTTP API | `engine/http-status-server.ts` | ~200 lines |
| Wire HTTP server startup | `engine/program.ts` | ~20 lines |
| Shared agent state service | `engine/state-service.ts` | ~80 lines |
| Runtime-specific skill variants | `skills/beam-openclaw/SKILL.md`, `skills/beam-hermes/SKILL.md` | ~60 lines each |
| Messaging-friendly status output | `cli/status.ts --message` | ~40 lines |
| Hourly check-in helper scripts | `skills/beam/scripts/beam-checkin.sh`, `skills/beam-openclaw/scripts/beam-checkin.sh` | ~10 lines each |

**Deliverables**:
- Agent can call `beam_status`, `beam_positions`, `beam_decisions`, `beam_config` via MCP
- HTTP API available on `127.0.0.1:18790` with `/health`, `/status`, `/positions`, `/decisions`, `/config`
- Runtime-specific skills with proper gating for OpenClaw and Hermes
- `beam status --message` returns a markdown summary for Telegram/WhatsApp/Discord/Slack
- Hermes blueprint provides hourly scheduled check-ins

**Not implemented** (moved to Phase 3):
- SSE event stream for real-time subscriptions (`beam_subscribe`)
- Direct HTTP `POST /subscribe` endpoint

### Phase 3: Deep integration (1-2 months)

**Goal**: Beam is a first-class citizen in agent ecosystems.

| Task | Description |
|------|-------------|
| A2A Agent Card | `/.well-known/agent.json` for cross-agent discovery |
| Skill Workshop integration | Agent can create/update Beam skills via OpenClaw proposals |
| `beam_analyze` MCP tool | Agent asks Beam to analyze a pool not in watchlist |
| `beam_simulate` MCP tool | Agent asks "what if I enter pool X?" |
| Cross-runtime testing | CI tests with both Hermes and OpenClaw mock runtimes |
| Agent feedback loop | Agent's overrides are stored in memory for future cycles |

**Deliverables**:
- Beam appears in agent skill registries
- Agent can extend Beam's behavior via skill proposals
- Cross-agent interoperability via A2A

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| MCP spec changes (RC `2026-07-28`) | Breaking tool interface | Pin to `2025-11-25` stable. Upgrade when RC stabilizes. |
| OpenClaw/Hermes protocol drift | Transport breaks | Transport interface is thin (~100 lines each). Easy to update. |
| Agent runtime not installed | Overlay silently degrades | Current `AgentNoOp` fallback is correct. Log warning. |
| Alert flooding | Agent overwhelmed by notifications | Rate-limit alerts (max 1/minute per type). Batch during high volatility. |
| MCP server port conflict | HTTP API fails to bind | Configurable port. Auto-increment on conflict. |
| Skill metadata staleness | Wrong gating in runtime | Version field in SKILL.md frontmatter. Update on each release. |

---

## References

- [MCP Specification `2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25)
- [Agent Client Protocol](https://agentclientprotocol.com)
- [OpenClaw Gateway Protocol](https://docs2.openclaw.ai/gateway/protocol)
- [OpenClaw Skills](https://docs.openclaw.ai/tools/skills)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [A2A Protocol](https://a2a-protocol.org)
- [Beam AGENTS.md](../AGENTS.md) — known issues and architecture notes
