# Autoresearch + Tiny Canary — Design

## Status

Approved via user "ok do it all" (2026-09-06). Small win goal locked; iterate from there.

## Context

- Cloud (`beam.pryx.dev`) is already production.
- Trading agent is paper-only, stopped; configured `base.db` missing; CLI broken on broken `viem` link.
- Karpathy `autoresearch` pattern: frozen harness + editable surface + fixed budget + one comparable metric + keep/discard.

## Small win goal (v1 — achievable)

**Paper, 7-day replay (or synthetic if replay sparse):**

| Metric | Target |
|--------|--------|
| Primary | Net PnL ≥ **+$5** over the window |
| Floor | Max drawdown ≤ **5%** of peak equity |
| Floor | Fees earned ≥ **$5** (not idle cash) |
| Soft | Round-trips recorded (informational in v1) |

If the baseline already beats +$5, the first autoresearch keep requires **≥ +10% relative improvement** on net PnL without violating DD / fee floors.

**Live canary (only after paper goal passes once):**

| Cap | Value |
|-----|-------|
| Mode | `PAPER_TRADING=false`, `AUTONOMOUS_TOKEN_MODE=canary` |
| Max open positions | 1 |
| Max entry size | **$15** |
| Max portfolio at risk | **~$50** wallet already observed |
| Kill | any day with realized loss ≥ **$10** → flip back to paper |

## Architecture (config-search only)

```text
research/
  program.md           # human-owned agent instructions
  baseline.json        # frozen knobs + last known score
  candidates/          # trial knob files
  results/             # append-only experiment log
ops/autoresearch.ts    # run one trial: apply knobs → backtest → score → keep/discard
```

- **Frozen:** backtest harness, risk invariants, adapter, execution.
- **Editable by research agent:** only keys listed in `research/knobs.schema.json` (thresholds, weights, scan/size soft knobs).
- **Metric:** `score = netPnlUsd` with hard rejects on DD / min round-trips.
- **No live trading from the research loop.** Promotion is a separate explicit step.

## Non-goals (v1)

- Editing `engine/*.ts` from the research agent
- Multi-objective Pareto search
- Overnight LLM swarm (single `program.md` + CLI is enough)

## Deliverables this pass

1. Fix install/CLI; restore `base.db` from paper-verification backup.
2. Scaffold `research/` + `ops/autoresearch.ts` + baseline score.
3. Paper verification path documented; tiny live canary env snippet ready but **not** auto-enabled until paper goal is met.
