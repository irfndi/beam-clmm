# Architecture

## Component Map

```text
engine/
├── index.ts             22-line bootstrap: Effect.runPromise(program)
├── program.ts           Loop bootstrap + per-pool decision logic (~11.3k lines)
├── scan-cycle.ts        Per-cycle orchestration (hydration → scan → decay → report)
├── fee-execution.ts     Periodic fee/reward claim, convert, compound path
├── operator-status.ts   Canonical status read model (HTTP, CLI, cloud report)
├── services.ts          Context.Service definitions (one per service)
├── config-service.ts    Env loader (Effect Config.String/Number/Boolean)
├── adapter-service.ts   Uniswap v3/v4 EVM adapter (viem + Robinhood Chain RPC)
├── strategy-service.ts  Pure strategy math (fee/IL, vol auth, range util)
├── cost-model.ts        ONE USD cost model (gas, L1 data fee, swap fee, slippage)
├── unit-economics.ts    Expected fees / IL / break-even size / net EV
├── decision-journal.ts  Per-decision record (facts, signals, EV, outcome join)
├── decision-shadow.ts   Runs the rule core beside the legacy path (pure)
├── core/                Decision core: facts → rules → resolver → decide
│   ├── facts.ts         Immutable fact set for one evaluation
│   ├── regime.ts        calm / trending / volatile / degraded classifier
│   ├── policy.ts        Versioned thresholds + per-regime profiles
│   ├── rule.ts          Rule + Signal contract
│   ├── rules.ts         The rule set (guards, exits, rebalance, entry)
│   ├── resolver.ts      Directives → vetoes → votes → one decision
│   └── decide.ts        decide(facts, policy) → EngineDecision
├── risk-service.ts      Pre-execution gates with early return
├── memory-service.ts    Thin wrapper over db-service for memory ops
├── db-service.ts        SQLite queries (positions, audit, memory, snapshots)
├── db.ts                Schema + sqlite-vec vec0 table, auto-migration
├── audit-service.ts     JSONL audit logger
├── blacklist-service.ts Deployer/token blacklist checks
├── embeddings.ts        Hash fallback, or ONNX opt-in (@huggingface/transformers)
├── logger.ts            createLogger(component) -> console + jsonl
├── update-utils.ts      Semver, GitHub API helpers
├── feedback-service.ts  Agent feedback, dedup, rate-limit, GitHub Issues
├── bigint-json.ts       BigInt-safe JSON serializer
├── error-reporter.ts    Privacy-first error telemetry (sanitizes secrets)
├── errors.ts            Shared error types
├── version.ts           Read version from package.json
├── types.ts             Shared interfaces
└── data/                deployer-blacklist.json, token-blacklist.json
```

Most engine files are flat in `engine/`; the decision core is the one subdirectory (`engine/core/`) because a rule set scales by adding rules, not by growing a file.

## Agent Loop (per cycle, per pool)

```text
SCAN (every SCAN_INTERVAL_MS, default 10 min)
  For each pool in WATCHLIST_POOLS:
    1. adapter.getPoolState + tick-range fetch      ← on-chain (viem)
    2. [optional] db.saveSnapshot                   ← if ENABLE_SNAPSHOT_CAPTURE
    3. blacklist.checkPool                          ← token blacklist (errors swallowed)
    4. strategy.computeMetrics                      ← fee/IL, vol auth, range util
    5. Pre-filter: TVL < minTvl OR volAuth < threshold OR rangeUtil < threshold → skip
    6. memory.getRelevantContext                    ← recent warnings (errors swallowed)
    7. Decision (legacy branch table, first match):
       a. TVL drop > exitPct → EXIT
       b. Volume authenticity < threshold → EXIT
       c. Fee/IL ratio < 0.5 → EXIT
       d. Trailing stop triggered → EXIT
       e. Range drift > 60% OR OOR grace expired → REBALANCE
       f. Existing position → HOLD
       g. Passes strict ENTER thresholds → ENTER
    8. rule core (DECISION_ENGINE=rules only)       ← adopt veto / protective EXIT
    9. risk.evaluate                                ← 7 gates, early return
   10. decision telemetry                           ← facts + EV + rule shadow
   11. unit-economics gate                          ← EV ≤ 0 → suppress
   12. audit.recordDecision                         ← JSONL log
   13. Execute: paper (Map.set/delete) or live (adapter.enterPosition etc.)
```

## Decision Core (rules, parallel evaluation, regimes)

The legacy branch table is a first-match chain: later rules are unreachable,
nothing records which branch won, and a strategy change is a code change.
The decision core replaces it with three pure layers, enabled by
`DECISION_ENGINE=shadow|rules`:

```text
facts      immutable snapshot per evaluation (no I/O, no clock reads)
  ↓
rules[]    every rule runs, every cycle; each emits signals
  ↓
signals    directive (capital protection) | veto (blocks an action) | vote (weight)
  ↓
resolver   highest-severity directive → vetoes → weighted votes → one decision
```

- **Parallel by construction.** Rules are pure and independent, so they can be
evaluated together, in any order, in parallel. The resolver is deterministic,
so parallel and sequential evaluation produce the same decision. The real
parallelism win is across pools and RPC, not rule math.
- **Policy as data.** `engine/core/policy.ts` holds a versioned
  `DecisionPolicy`; regime profiles (`calm` / `trending` / `volatile` /
  `degraded`) scale its thresholds. Every journal row stamps the regime and
  policy version, so a losing rule can be traced to the exact configuration.
- **Shadow before cutover.** `decision-shadow.ts` runs the rule core against
the live decision, journals both rows and logs agreement/disagreement. It is
pure and never executes. `DECISION_ENGINE=legacy` skips the shadow row;
`shadow` records it; `rules` dispatches it.
- **Cutover is bounded by what the core can execute.** In `rules` mode the core
runs BEFORE the risk gates and `decision-adoption.ts` adopts its action only
where no input is missing: a HOLD veto (cancels ENTER/REBALANCE), a protective
EXIT, and an ENTER that cleared `engine/entry-gates.ts` (size, fee/IL floor,
round-trip gas floor, measured candidate conditions, weighted score, allocation
cap) plus the caller's I/O gates (token risk, cooldown, wallet read/refresh,
backoff, v4 and funding exclusions). The live branch calls the SAME gate
functions, so the two paths cannot drift. A rules REBALANCE has no range
params, so it stays advisory. Challenge mode is refused outright: fee
persistence, exit-route proofs and pool-age gates are not modelled there. A
legacy EXIT is never cancelled — protection outranks expected value. `beam
decisions parity` aggregates the journal by direction (vetoes, protective
exits, rules entries): read it before changing the mode.
- **Unit economics first.** A decision must clear
  `expectedFees − expectedIL − roundTripCost > 0` and repay its round trip
  within `MAX_BREAK_EVEN_HOLD_DAYS`. `engine/cost-model.ts` is the only place
  that prices gas, swap fee and slippage.

Rules live in `engine/core/rules.ts`; adding a rule is one object plus one unit
test in `bench/decision-core.test.ts`.

## Effect Idioms

Every service is a `Context.Service` class with a `Layer`, declared in
`engine/services.ts`; side effects live in the service, `Effect.gen` sequences
them, and `Effect.catch` / `catchTag` / `orElseSucceed` handle recovery.

`bun run lint` enforces Effect's own recommended `@effect/tsgo` rule set
(`effecttsgo/*` in `.oxlintrc.json`) as errors, so the mechanical idioms stay
uniform: `catchIf` for selective recovery, `orElseSucceed`/`ignore` for
recovery that discards the error, `timeoutOrElse` instead of racing a manual
sleep, `forEach` instead of `all(map)`, and no `try`/`catch` inside
`Effect.gen`. Three rules are deliberately off — `lazy-effect` (the service
APIs expose `() => Effect<…>` on purpose) and the two
`global-error-in-effect-*` rules (the adapter and db layers surface `Error`;
tagged errors are a separate domain migration).

`bun run typecheck:fast` runs `tsrs` (the Rust port of the TypeScript 7
native compiler) for a sub-second local check; `bun run lint` and `pretest`
keep the authoritative `tsc`.

## Memory TTL Policy

| Category | TTL |
|----------|-----|
| `pattern` | 90 days |
| `warning` | 60 days |
| `outcome` | 180 days |

sqlite-vec stores embeddings in a `vec0` virtual table. Queries return rows by cosine distance (`distance` column). Ranking blends similarity (70%) with recency decay (30%, 30-day half-life).

## Risk Gates (in order, early return)

1. Confidence < `CONFIDENCE_THRESHOLD` → reject
2. Max concurrent positions reached → reject ENTER
   → Duplicate pool guard → reject ENTER if same pool held
3. EXIT → always approved (capital protection)
4. Portfolio drawdown > 10% → pause new entries
5. Stop-loss triggered (`STOP_LOSS_PCT` exceeded) → reject HOLD/REBALANCE
6. Position size > 30% portfolio → cap and allow
7. Rebalance range invalid or exceeds `MAX_REBALANCE_RANGE_BINS` → reject REBALANCE

## Snapshot Capture & Replay

Set `ENABLE_SNAPSHOT_CAPTURE=true` (paper trading only). Every cycle dumps pool state + tick range into the `pool_snapshots` table (migration v4). BigInt-safe JSON serialization preserves fidelity.

Replay via `bun run backtest --source replay --db ./beam.db --days 7 --pools <addr>`. Reads snapshots from SQLite and runs them through the same strategy loop as synthetic data.
