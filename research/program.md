# Beam Autoresearch Program

You are running **config-only** research on Beam's concentrated-liquidity strategy.
Do **not** edit engine/adapter/risk code. Only propose knob JSON under `research/candidates/`.

## Loop (Karpathy-style)

1. Read `research/baseline.json` (current champion knobs + score).
2. Hypothesize one small change to allowed knobs (`research/knobs.schema.json`).
3. Write `research/candidates/<trial-id>.json`.
4. Run: `bun run autoresearch -- --candidate research/candidates/<trial-id>.json`
5. Keep only if the trial **passes the win goal** and beats baseline (see below).
6. Append outcome is automatic in `research/results/log.jsonl`. If kept, baseline updates.
7. Repeat. Prefer 1–3 knob changes per trial.

## Win goal (v1 — small, update later)

Hard pass (all required):

- `netPnlUsd >= 5` over the trial window (default: **measured-tagged synthetic** 7d, $10k book)
- `maxDrawdownPct <= 0.05`
- `totalFeesUsd >= 5` (must actually earn, not idle-cash “pass”)
- `roundTrips >= 0` in v1 (holds that earn fees count; churn comes in a later goal)

Trials use `statsSource: "datapi"` on a **calm fee-farm** synthetic so gates can fire and the small goal is reachable.
This is a research harness, not a claim that synthetic fees are real — promote only after paper replay / live canary.

Keep vs baseline:

- If baseline has not yet passed the win goal: first passing trial becomes champion.
- If baseline already passes: keep only when `netPnlUsd >= baseline.netPnlUsd * 1.10`
  **and** DD / round-trip floors still hold.

## Allowed edits

Only keys in `research/knobs.schema.json`. Typical levers:

- `halfWidth`, `driftThreshold`, `minHoldTicks`, `minNetBenefitUsd`
- `maxRebalances`, `confidenceThreshold`, `minPoolTvlUsd`

## Forbidden

- Setting `PAPER_TRADING=false` from this loop
- Editing `engine/**`, `cli/**`, wallet keys, or live size caps
- Optimizing only trade count / throughput without the PnL + DD floors

## Kickoff prompt

```
Read research/program.md and research/baseline.json.
Propose one candidate, write it under research/candidates/, run bun run autoresearch,
and report keep/discard with the score line.
```
