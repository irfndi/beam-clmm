# Autoresearch Canary Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox syntax.

**Goal:** Restore runnable paper book, ship config-only autoresearch with a +$5 / 7d win goal, prepare tiny live canary (not auto-armed).

**Architecture:** Karpathy-style loop — frozen backtest harness, editable knob JSON, fixed score with DD/round-trip floors. Live canary is a separate explicit config snippet.

**Tech Stack:** Bun, existing `ops/backtest.ts`, SQLite, JSON results log.

**Spec:** `docs/superpowers/specs/2026-09-06-autoresearch-canary-design.md`

## Global Constraints

- Do not edit engine decision/risk code from the research loop.
- Do not set `PAPER_TRADING=false` in committed defaults or pm2 ecosystem.
- Win goal v1: net PnL ≥ +$5 / 7d, max DD ≤ 5%, fees ≥ $5.

---

### Task 1: Restore runtime

- [x] `bun install` (fix broken viem link)
- [ ] Restore `.data/multichain/base.db` from paper-verification backup
- [ ] Confirm `bun cli/index.ts portfolio summary` works

### Task 2: Research scaffold

- [ ] Add `research/program.md`, `research/knobs.schema.json`, `research/baseline.json`
- [ ] Add `ops/autoresearch.ts` — one trial: load knobs → run backtest → score → keep/discard → append `research/results/log.jsonl`
- [ ] Wire `bun run autoresearch` script in `package.json`

### Task 3: Baseline score

- [ ] Run one autoresearch baseline trial; write score into `research/baseline.json`

### Task 4: Live canary prep (safe)

- [ ] Add `research/live-canary.env.example` with $15 max entry / 1 position / kill switch notes
- [ ] Do **not** enable live in `.env` or pm2 until paper goal met

### Task 5: Verify

- [ ] CLI portfolio + one autoresearch run succeed
