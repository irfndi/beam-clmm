# State machines

Every durable lifecycle in Beam, its states, invariants, and reachable
transitions. Findings marked **CONFIRMED** were reproduced by running code
(probe output quoted) or read from the production database; findings marked
**INSPECTION** were established by reading the write sites and are reachable but
were not executed.

Legend: ✅ transition exists · ⚠️ reachable but violates a stated invariant ·
🚫 modeled but unreachable (dead state) · ❌ missing transition (state is
absorbing when it should not be)

---

## 1. SettlementJob

`specifics: engine/types.ts` (`SettlementJobStatus`), `engine/autonomous-runtime.ts`
(`processSettlementJobs`, `retryableJob`, `reconciliationJob`, `sweepOrphanSettlements`),
`engine/db-service.ts` (`saveSettlementJob`, `finalizeSettlementGroup`),
schema `engine/db.ts` v20/v21/v23.

States: `pending` · `prepared` · `submitted` · `confirmed` · `retryable` · `terminal`

**Invariants the code assumes**

| # | Invariant | Enforced? |
|---|---|---|
| S1 | `confirmed` ⇒ `confirmedOutputAtomic`, `outputUsd`, `executionCostUsd` all non-null | ⚠️ by path, not by a constraint |
| S2 | `terminal` and `confirmed` are final; nothing re-arms them | ⚠️ the orphan sweep re-arms `terminal` |
| S3 | Only a `confirmed` job contributes to a position's realized PnL | ✅ |
| S4 | A position finalizes only when every job in its group is `confirmed` | ✅ (and this is the bug in §1.4) |
| S5 | `nextRetryAt === null` ⟺ the job needs no future work | ⚠️ `reconciliationJob` writes `nextRetryAt: null` on a non-final state |

**Transition table** (`live`/`canary` mode; `off`/`shadow` do nothing)

| From | Trigger | Guard | To | Site |
|---|---|---|---|---|
| `pending` | cycle tick | `nextRetryAt <= now` | `prepared` → `submitted` → `confirmed` | `autonomous-runtime.ts:540-600` |
| `pending`/`retryable` | quote/prepare/simulate/submit throws pre-broadcast | transient error | `retryable` | `:306` (`retryableJob`) |
| same | same | non-transient, `now < expiresAt` | `retryable` | `:306` |
| same | same | non-transient, `now >= expiresAt` **or** unrecoverable route | `terminal` | `:318` |
| `submitted` | broadcast throws after tx sent | — | `prepared`, `nextRetryAt: null` | `:326` (`reconciliationJob`) |
| `prepared` (with `txSignature`) | cycle tick | — | `confirmed` / `submitted` / `prepared` | `:373-455` |
| `submitted` | `getSwapStatus` → `not_found` | `now < expiresAt` | `submitted` (kept) | `:472` |
| `submitted` | `getSwapStatus` → `not_found` | `now >= expiresAt` | `terminal` | `:474` |
| `prepared` | cycle tick | **`txSignature === null`** | `retryable`/`terminal` via `retryableJob` | `:461-465` |
| `terminal` | orphan sweep, mint still held & priceable | no route-mint conflict | **`pending`** (attempts+1, `expiresAt` refreshed) | `:791` |
| `confirmed` | all group jobs confirmed + complete + position row exists | — | row `finalized_at`/`realized_pnl_usd` set | `:641-660` |

### 1.1 ⚠️ CONFIRMED — the settlement stablecoin is swept as an orphan

`engine/adapter-service.ts:3825` lowercases every wallet-holdings key
(`holdings.set(STABLECOIN_MINT.toLowerCase(), …)`, added in `044ad18`). The orphan
sweep's eligibility filter compares case-insensitively
(`engine/autonomous-runtime.ts:700-712`), but the **job-creation loop compares
case-sensitively**:

```
engine/autonomous-runtime.ts:776
  if (mint === NATIVE_MINT || mint === STABLECOIN_MINT || holding.amountAtomic <= 0n) continue;
```

`STABLECOIN_MINT` is the checksummed USDC address
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `engine/chain-registry.ts`), while
the holdings key is `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`. The guard never
matches, so the funding stablecoin becomes an orphan sell job and is swapped to
ETH — paying gas and slippage and removing the leg WETH/USDC-funded entries need.

Reproduced (`bun run`, live `sweepOrphanSettlements`, holdings = ETH + $50 USDC +
one stray token):

```
jobs: [ { mint: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amt: "50000000" } ]
USDC SWEPT? true
```

The comment directly above the filter states the intent the loop violates:
"Always keep the settlement stablecoin out of the orphan bucket"
(`:704-710`). Impact: **money** — irreversible conversion of the engine's
funding asset. Fixed in §6.1.

### 1.2 ⚠️ CONFIRMED — the orphan sweep undoes an operator terminalization

`terminal` is documented as final (`:187-190`: "`confirmed` and `terminal` are
final states"), and `sweepOrphanSettlements` revives only signature-less
terminal rows (`:747-760`) so a dead signature is not re-polled. But a
**deterministic** terminal row (unrecoverable route — the exact reason
`retryableJob` terminalized it) is revived just like an expired one. The
classifier for "no retry can fix this" already exists
(`isUnrecoverableSettlementError`, `:299`) and is not consulted by the sweep.

Reproduced (terminal job, error `quoteSwap: no direct v3 or registered v4 pool`,
mint still in the wallet):

```
revive stale terminal -> [ { st: "pending", at: 3, next: 1000, exp: 3601000, id: "old" } ]
```

Production evidence — `.data/multichain/base.db`, two mints cycling through
`terminal` with the same unrecoverable errors, including rows an operator had
already closed by hand:

```
0cc16a8b|terminal|4|…|manually terminalized: quoteSwap: no direct v3 or registered v4 pool
78fa91d3|terminal|4|…|manually terminalized: quoteSwap: no direct v3 or registered v4 pool
6aabecb2|terminal|4|…|manually terminalized: quoteSwap: Invariant failed: TICK
```

Impact: a doomed quote + RPC call every cycle forever, and the job counts as
*active*, which keeps the `settlement_overdue` pause armed (§5.1). Fixed in §6.2.

### 1.3 ⚠️ INSPECTION — a group finalizes on a partial job set

`processSettlementJobs` pushes a job into `processed` only when `saveSettlementJob`
succeeds (`:614-618`). Group finalization then walks `Map.groupBy(processed, …)`
(`:620`). A job whose write failed is therefore **absent from the group**, so if
its siblings are all `confirmed` the group finalizes with that leg's proceeds
missing from `realizedPnlUsd`, and `finalizeSettlementGroup` stamps `finalized_at`
on the surviving ids. The late-confirming leg then forms a group of one and
finalizes the position a second time with a different PnL.

Reachable on any transient SQLite failure (`SQLITE_BUSY`, disk full) between two
job writes. The existing test
(`bench/program-autonomous-token.test.ts:932`) covers the single-job case, where
there is nothing to finalize, so it does not exercise this. Fixed in §6.3.

### 1.4 ⚠️ CONFIRMED — one `terminal` sibling blocks the group forever

Invariant S4 is all-or-nothing. A position's group with any `terminal` leg can
never satisfy `jobs.some(job => job.status !== "confirmed") === false`, so
`finalizeSettlementGroup` never runs and the position keeps `realized_pnl_usd`
NULL permanently.

Reproduced (group of `confirmed` + `terminal`):

```
C confirmed+terminal group -> finalized: 0
```

Production evidence (`.data/multichain/base.db`):

```
select count(*) from positions where closed_at is not null and realized_pnl_usd is null;  -> 3
all three back onto settlement_jobs rows in status 'terminal'
```

Impact: accounting only (the NULL is the documented "no trusted value" path,
`program.ts:2762-2778`); it is recorded here as a design gap because the
operator surface reports these trades as zero PnL (`operator-status.ts:282`
sums `realizedPnlUsd ?? 0`). **Not fixed** — booking a partial PnL would claim
proceeds that are still sitting in the wallet (§1.2's revivable rows), which is
the failure mode the `terminal`-blocks-finalization rule exists to prevent.

### 1.5 Unreachable / dead transitions

- `prepared` written by `reconciliationJob` (`:326`) carries `nextRetryAt: null`,
  so invariant S5 is violated by construction. The loop re-enters it on the next
  cycle instead of after backoff — harmless, since the first thing the retry does
  is re-read `getSwapStatus`.
- `attempts` grows without bound on a permanently-`not_found` signature
  (`:472`); `nextSettlementRetryAt` clamps its exponent at 30 and its result at
  300 s, so backoff saturates. Production row: `attempts = 130`.

---

## 2. ExecutionOperation

`engine/types.ts` (`ExecutionOperationStatus`), writers all in `engine/program.ts`,
persistence `engine/db-service.ts:1366`.

States: `planned` · `prepared` · `submitted` · `confirmed` · `retryable` · `failed`

**Transition table**

| From | Trigger | To | Site |
|---|---|---|---|
| — | live ENTER planned | `planned` | `program.ts:1832` |
| — | live EXIT planned | `planned` | `program.ts:2223` |
| `planned` | mint/exit confirmed | `confirmed` | `:2104`, `:2348` |
| `planned` | gas gate / plan / mint / exit failure | `failed` | `:1737`, `:1806`, `:2008`, `:2314`, `:2395` |
| `planned` | process restart, `createdAt < processStartedAt` | `failed` ("abandoned planned operation") | `:1722-1748` |

**Invariants**

| # | Invariant | Enforced? |
|---|---|---|
| O1 | `confirmed` ⇒ `txSignature` non-empty | ⚠️ `syncExitOperationState` writes `""` for a mined-but-unprobed exit (`:2395`) |
| O2 | `failed` ⇒ no transaction landed | ⚠️ crash-recovery writes `failed` for an operation that may have broadcast |
| O3 | Every state in the union is reachable | 🚫 `prepared`, `submitted`, `retryable` are never written |

**Findings**

- 🚫 **Dead states (INSPECTION).** `grep 'status: "'` across `engine/` shows only
  `planned`, `confirmed`, `failed` are ever written. The DB `CHECK` constraint
  (`db.ts:850`) and the TypeScript union advertise three states no code produces.
- ⚠️ **A confirmed EXIT can be recorded as `failed`** (INSPECTION). The row is
  written `planned` before the broadcast (`:2223`). If the process dies between
  the broadcast and the status update, `recoverStaleExecutionOperations`
  (`:1722`) marks it `failed` with no chain probe. The position row is corrected
  by `reconcilePositions` (`:1027`) but the ledger is not. Impact: audit only.
- ⚠️ **`txSignature: ""` on a confirmed exit** (INSPECTION, `:2395`): the
  `probeMinedExit` recovery path (`:2250`) returns a synthetic result with an
  empty signature, which `syncExitOperationState` stores as `confirmed` + `""`.
  A `confirmed` row with no hash is not reconcilable later.

---

## 3. Position

`positions` table (`engine/db.ts` v1, v18 re-key, v22 fallen-angel fields),
writers in `engine/db-service.ts`, transitions driven by `engine/program.ts`
(`executePaperEnter/Exit`, `executeLiveEnterMint`, `closeExitedPosition`,
`settleUnresolvedExit`, `executeAtomicRebalance`, `reconcilePositions`).

State is **two nullable timestamps plus two identities**, not an enum:
`closed_at` (live close), `paper_exited_at` (paper close), `position_id`
(`paper-<pool>-<uuid>` for paper, on-chain key for live), `position_pubkey`.

| From | Trigger | To | Site |
|---|---|---|---|
| — | paper ENTER | open, `paper-` id, `pubkey = null` | `:1405` |
| — | live ENTER confirmed | open, on-chain id | `:2080` |
| — | live REBALANCE confirmed | open, range updated, `lastRebalanceAt` bumped | `:2959` |
| open | paper EXIT | `closed_at` + `paper_exited_at` set | `:1478-1494` |
| open | live EXIT, no settlements | `closed_at`, realized PnL | `:2750` |
| open | live EXIT with settlements | `closed_at`, **realized PnL NULL** until §1.4 completes | `:2560` |
| open | reconcile: on-chain gone | **row deleted** | `:1027` |
| open | reconcile: range drifted on-chain | range synced | `:1060` |
| closed | paper→live re-entry of the same pool | row re-keyed to the live pubkey | `:1358-1372` |

**Invariants**

| # | Invariant | Enforced? |
|---|---|---|
| P1 | `closed_at IS NOT NULL ⇒ realized_pnl_usd IS NOT NULL` | ⚠️ violated by §1.4 (3 rows in production) |
| P2 | `paper_exited_at IS NOT NULL ⇒ closed_at IS NOT NULL` | ✅ (paper EXIT writes both) |
| P3 | A `paper-` row never carries an on-chain pubkey | ✅ (`:1371`) |
| P4 | `paper-` rows are excluded from live accounting | ✅ `sweepOrphanSettlements:723`, `reconcilePositions:1046` |
| P5 | A pool may hold several positions; every consumer must filter by `position_id` | ⚠️ see below |

**Findings**

- ⚠️ **`positionsForPool` + `resolveTargetPosition` fall back to pool scope**
  (INSPECTION, `:910-919`): when a decision has no `positionId`, the target is
  the pool's *only* position and otherwise `undefined`. Multi-position pools are
  supported by the schema (v18) and by `program.ts:7717` (sorted iteration), so a
  `REBALANCE`/`EXIT` decision that loses its `positionId` becomes a silent no-op
  instead of touching the wrong row — fail-safe, documented here because the
  silent skip is indistinguishable from success in the audit log.
- ⚠️ **Paper and live rows share one table** (INSPECTION). Both identities use
  `position_id` keys in the same table; every live path filters `paper-*`
  explicitly (`:723`, `:1046`). A new query that forgets the filter
  double-counts. No confirmed occurrence.

---

## 4. TokenCandidate

`engine/types.ts` (`TokenCandidateState`), `engine/candidate-policy.ts`
(`transitionCandidate` and the pure helpers), persisted by
`db-service.ts:saveTokenCandidate`, advanced by
`candidate-discovery.ts:advanceScreenedCandidates`, with lifecycle events fired
from `program.ts` (`:4776`, `:6031`, `:11381`, `:11453`).

States: `discovered` · `observing` · `eligible` · `entered` · `cooling_down` · `rejected`

**Transition table** (from `transitionCandidate`)

| From | Event | Guard | To |
|---|---|---|---|
| `discovered`/`observing`/`eligible` | `scan`, healthy | `healthyScanCount < minHealthyScans` or age short | `observing`, count+1 |
| `discovered`/`observing`/`eligible` | `scan`, healthy | both gates met | `eligible`, `eligibleAt = lastSeenAt` |
| `discovered`/`observing`/`eligible` | `scan`, transient failure | — | `observing`, count = 0 |
| any | `scan`, hard safety failure | — | `rejected`, reason set |
| `eligible` | `entry_confirmed` | — | `entered`, `enteredAt` |
| `entered` | `cooldown_started` | — | `cooling_down`, `cooldownUntil` |
| `cooling_down` | `cooldown_elapsed` | `now >= cooldownUntil` | `discovered`, counters cleared |
| `entered`/`cooling_down`/`rejected` | `scan` (healthy or transient) | — | unchanged (timestamps only) |

**Invariants**

| # | Invariant | Enforced? |
|---|---|---|
| C1 | `eligible` ⇒ `healthyScanCount >= minHealthyScans` **and** `lastSeenAt - firstSeenAt >= minObservationMs` | ✅ |
| C2 | `firstSeenAt` is monotonic and never re-based | ⚠️ lost when the map entry is dropped (§4.2) |
| C3 | `entered` ⇒ an open position exists for the pool | ❌ not enforced (§4.1) |
| C4 | `cooling_down` is the only path back to `discovered` | ✅ |
| C5 | `hard_safety_failure` is reachable | 🚫 unreachable (§4.3) |

### 4.1 ❌ CONFIRMED (inspection) — `entered` is absorbing when the position disappears

`program.ts:11378` and `:11453` advance `eligible → entered` and
`entered → cooling_down` only from the tail of an **executed** decision. An
external close (or a reconcile delete, `:1027`) removes the position row without
any candidate event, so the candidate stays `entered`.

Consequence: `refreshAutonomousCandidates` rebuilds `autonomousCandidatePools`
from `advanced.eligiblePoolAddresses` **only** (`:4836-4839`), and
`recordScan` never leaves `entered` — so the pool stops being a candidate entry
target for the rest of the process lifetime. Only `loadPersistedCandidates`
(`:4200`) restores the pool set, i.e. a restart. Fixed in §6.4.

### 4.2 ⚠️ INSPECTION — the observation clock is process-local

`advanceScreenedCandidates` builds its `existingById` map from
`existingCandidates` (`:45`), which `program.ts:4805` passes from the in-memory
`autonomousCandidates`. `loadPersistedCandidates` only runs at startup
(`:4200`). A candidate created this process carries the correct `firstSeenAt`;
one persisted before a restart is re-read with its stored timestamps, so C2
holds. The gap is the reverse of §4.1: a candidate that is dropped from the map
is re-created by `createTokenCandidate` with `firstSeenAt = now`, restarting its
own observation window. No confirmed production occurrence.

### 4.3 🚫 INSPECTION — `rejected` cannot be reached, and would be absorbing

`advanceScreenedCandidates` hardcodes `safety: { kind: "safe" }`
(`candidate-discovery.ts:67`). It is the only production caller of
`transitionCandidate` with a `scan` event, so `recordScan`'s
`hard_safety_failure` branch (`candidate-policy.ts:205`) never fires. If it did,
`rejected` has no outgoing edge except timestamp updates — a permanently
blacklisted pool. Intentional fail-closed design; recorded because the state
machine documents a transition the app cannot reach.

---

## 5. WalletSafetyPause

`wallet_safety_pauses` PK `(wallet_address, agent_instance_id)` (`db.ts:887`),
one row per agent — **the reason is part of the row, not the key**.
Logic in `engine/autonomous-runtime.ts`, driving sites in `engine/program.ts`,
operator override in `cli/resume.ts:48-58`.

States: `none` (no row) · `armed` (`resolved_at IS NULL`) · `resolved` (`resolved_at` set)

Reasons: `daily_drawdown` · `core_data_unavailable` · `execution_failures` ·
`settlement_overdue` · `settlement_persistence_failed`

**Transition table**

| From | Trigger | To | Site |
|---|---|---|---|
| `none`/`resolved` | `shouldTriggerSafetyPause` returns a reason | armed, `triggered_at = now` | `:6747-6765` |
| `armed` (`daily_drawdown`) | `shouldAutoResolveDailyDrawdownPause` | resolved | `:8535-8546` |
| `armed` (`core_data_unavailable`) | `consecutiveCoreDataFailures < 2` | resolved | `:8550-8556` |
| `armed` (`execution_failures`) | counter below threshold | resolved | `:6346-6356` |
| `armed` (`settlement_overdue`) | every job `confirmed`/`terminal` | resolved | `:6316-6325` |
| `armed` (any) | `beam resume` | resolved | `cli/resume.ts:58` |
| — | exit settlement write fails | armed `settlement_persistence_failed` | `:2480-2490` |

Effect while armed: `ENTER`/`REBALANCE` refused, `EXIT`/`HOLD` allowed
(`autonomous-runtime.ts:24-47`), and the pause never blocks in `shadow` mode.

**Invariants**

| # | Invariant | Enforced? |
|---|---|---|
| W1 | Every armed reason has a resolver | ⚠️ `settlement_persistence_failed` has none |
| W2 | A new trigger does not overwrite a different still-active reason | ⚠️ the upsert rewrites `reason` unconditionally |
| W3 | The resolvers only clear a pause whose `reason` they own | ✅ (each branch checks `reason ===`) |
| W4 | An armed pause blocks new capital but never blocks de-risking | ✅ |

### 5.1 ⚠️ CONFIRMED — `settlement_overdue` latches with no way out

The resolver requires `processedJobs.every(job => confirmed || terminal)`
(`:6319-6321`). `retryableJob` keeps **transient** failures retryable forever by
design (`:307-315`: "the retry budget stays unbounded"). Those jobs never reach
`confirmed`/`terminal`, so the pause stays armed while the agent can no longer
ENTER or REBALANCE.

Production evidence (`.data/multichain/base.db`):

```
wallet_safety_pauses:  settlement_overdue | 1787318067482 | (resolved_at NULL)
                       settlement_overdue | 1788684037819 | (resolved_at NULL)
settlement_jobs:       retryable | attempts=130 | expires_at 1788687637819 | simulateSwap: RPC Request failed
                       retryable | attempts=5   | expires_at 1787321667482 | simulateSwap: RPC Request failed
```

Both pauses are past every `expires_at` and unresolved. Two rules contradict:
"retry transient failures forever" and "halt once a settlement is older than the
window". **Not fixed** — which rule should yield is an operator decision (relax
the pause to a warning, or bound transient retries by age). Documented so the
next reader does not treat the latch as a bug in the resolver.

### 5.2 ⚠️ CONFIRMED (inspection) — `settlement_persistence_failed` never resolves

Written at `program.ts:2483` when an exit's settlement job cannot be persisted.
It appears in **no** resolver, is absent from the `SafetyPauseReason` union
(`autonomous-runtime.ts:54`), and therefore blocks `ENTER`/`REBALANCE` until an
operator runs `beam resume`. The condition that raised it (a failed DB write) is
not re-evaluated, so nothing can clear it automatically.

### 5.3 ⚠️ INSPECTION — one row, five reasons

The PK is `(wallet, agent)`, and `saveSafetyPause` upserts `reason`,
`triggered_at`, `resolved_at` together (`db-service.ts:1510-1525`). Arming a new
reason while another is active replaces it, and the replaced reason's resolver
branch can no longer see it (`reason === …` guards, W3). Reachable when two
triggers fire in the same cycle: the per-pool `daily_drawdown` arm
(`:8566-8575`) runs after the end-of-cycle settlement arm (`:6305-6314`), so the
later writer wins.

---

## 6. AgentProposal

`engine/types.ts:402` (`status: "pending" | "approved" | "rejected" | "executed"`),
all state in `engine/state-service.ts` (in-memory, one mutable closure; **no
persistence**), consumed by `program.ts:7075-7103` and `:10083-10110`, HTTP
surface `http-status-server.ts:230-470`.

States: `pending` · `approved` · `rejected` · `executed`

| From | Trigger | Guard | To | Site |
|---|---|---|---|---|
| — | `enqueueProposal` | no approved row for the pool, queue not full | `pending` | `state-service.ts:143-178` |
| `pending` | same pool re-proposes | — | old row replaced | `:165-176` |
| `pending` | `/approve` | approval token | `approved` | `:199` |
| `pending`/`approved` | proposal validator rejects | — | `rejected` | `program.ts:10380` |
| `pending`/`approved` | executed, or applied as HOLD | `executed || action === "HOLD"` | dequeued (removed) | `program.ts:499-507` |
| any | `expiresAt < now` or status `rejected`/`executed` | — | pruned | `state-service.ts:126-136` |
| `approved` | re-propose for the same pool | — | **rejected**, `approved_exists` | `:154-159` |

**Invariants**

| # | Invariant | Enforced? |
|---|---|---|
| A1 | `status ∈ {"pending","approved"}` ⟺ the row is consumable | ✅ via `findPendingProposal` |
| A2 | An `approved` row survives until executed or expired | ⚠️ pruned by `expiresAt` like a pending one |
| A3 | `queue_full` counts only consumable rows | ✅ (`prune` runs first) |
| A4 | Proposals survive a restart | 🚫 not attempted (in-memory only) |

**Findings**

- ⚠️ **An approval can expire before it is used** (INSPECTION). `prune` drops
  any row with `expiresAt < now` regardless of status (`:126-136`), and
  `expiresAt = proposedAt + min(staleMs, 5 min)` (`proposal-schema.ts:11,122`).
  A human approval arriving near the TTL is silently discarded: `findPendingProposal`
  also skips stale rows (`program.ts:441`), so the approval simply never applies.
  Reachability depends on human latency vs. `AGENT_PROPOSAL_STALE_MS` (default
  300 s, floor 10 s).
- ⚠️ **`approved_exists` can pin a pool** (INSPECTION). While an `approved` row
  exists for a pool, `enqueueProposal` refuses every new proposal for it
  (`:154-159`). If that row's decision never executes (risk-denied without
  rejection, `continue` paths), the pool accepts no proposals until the TTL
  expires. Bounded by the TTL, so a delay not a deadlock.
- 🚫 **`executed` is never written** (INSPECTION): `grep '"executed"'` shows only
  the prune filter; execution is expressed by dequeuing (`:499`) and rejection by
  `rejectProposal`. Same class as §2's dead states.

---

## 7. Smaller timed states

| Machine | States | Stored in | Notes |
|---|---|---|---|
| **Pool cooldown** | none / cooling (`cooldownUntil`) | `pool_cooldowns` (`db.ts:622`) | Written on EXIT via `resolveExitCooldown` (`program.ts:8370`, persisted `:11004`); read at the ENTER gate (`:10743`). Escalates `consecutiveOorExits` until `maxOorCooldownExits`. Never cleared — an elapsed row stays with a stale `cooldownUntil`. |
| **Entry-failure backoff** | none / backed-off | in-memory `Map` (`program.ts:3946`) | `nextEntryFailureBackoff` doubles 30 min → 6 h (`entry-backoff.ts`). Resets on a successful ENTER; **lost on restart** by design (a fresh process retries once). |
| **Challenge loss cooldown** | none / barred | `metadata.challenge_loss_cooldowns` | Pruned to the future at write time (`:11497`). |
| **Pool first-seen** | unset / set | `metadata.challenge_pool_first_seen` | Persisted so a restart does not re-arm the 6 h age gate (`:7100-7112`). |
| **Rotation confirmations** | counter 0..required | `rotation_state` (`db.ts:1008`) | `observeRotationPair` caps at `max(required,1)`, resets to 0 on a not-superior observation (`rotation-controller.ts:120-131`); persisted at cycle end only when dirty (`program.ts:6540`, `:11660`). A crash between the observation and the persist loses one confirmation — safe direction. |
| **TP ladder / fallen angel** | `none` / `tp` / `invalidation` | `positions.tp_ladder_json`, `invalidation_stop_price` | `evaluateTpLadder` checks invalidation first, then the lowest reached rung (`tp-ladder.ts:120-140`). The scale-out is a full close-and-reopen; the reached-rung index is **not persisted**, so a rung re-fires every cycle until the position is closed and reopened smaller (`program.ts:9374-9392`). Documented, not fixed: the adapter has no partial-withdraw path (locked decision, `tp-ladder.ts:23-30`). |

---

## Findings → issues

| # | Finding | Class | Impact | Issue | Status |
|---|---|---|---|---|---|
| 1.1 | Settlement stablecoin swept as an orphan (case-sensitive guard) | confirmed | money | [#15](https://github.com/irfndi/beam-clmm/issues/15) | fixed §8.1 |
| 1.2 | Orphan sweep revives deterministic-unrecoverable terminal jobs | confirmed | stuck capital + pause | [#15](https://github.com/irfndi/beam-clmm/issues/15) | fixed §8.2 |
| 1.3 | Group finalizes on a partial job set after a failed write | inspection | wrong realized PnL | [#16](https://github.com/irfndi/beam-clmm/issues/16) | fixed §8.3 |
| 4.1 | `entered` candidate absorbing after an external close | inspection | pool never re-enters | [#17](https://github.com/irfndi/beam-clmm/issues/17) | fixed §8.4 |
| 1.4 | A `terminal` sibling blocks group finalization forever | confirmed | PnL reported as 0 | [#19](https://github.com/irfndi/beam-clmm/issues/19) | documented |
| 5.1 | `settlement_overdue` latches while transient retries continue | confirmed | halt | [#18](https://github.com/irfndi/beam-clmm/issues/18) | documented |
| 5.2 | `settlement_persistence_failed` has no resolver | inspection | halt until `beam resume` | [#18](https://github.com/irfndi/beam-clmm/issues/18) | documented |
| 5.3 | One pause row, five reasons; last writer wins | inspection | reason loss | [#18](https://github.com/irfndi/beam-clmm/issues/18) | documented |
| 2 | `prepared`/`submitted`/`retryable` execution-op states unreachable | inspection | misleading schema | [#19](https://github.com/irfndi/beam-clmm/issues/19) | documented |
| 2 | A landed EXIT can be ledgered `failed` by crash recovery | inspection | audit only | [#19](https://github.com/irfndi/beam-clmm/issues/19) | documented |
| 2 | `confirmed` exit with `txSignature: ""` | inspection | audit only | [#19](https://github.com/irfndi/beam-clmm/issues/19) | documented |
| 4.3 | `rejected` candidate unreachable (safety hardcoded `safe`) | inspection | dead state | [#19](https://github.com/irfndi/beam-clmm/issues/19) | documented |
| 6 | Approval can expire before use; `executed` never written | inspection | delayed action | [#19](https://github.com/irfndi/beam-clmm/issues/19) | documented |
| 7 | TP rung re-fires until close-and-reopen | inspection | extra churn | [#19](https://github.com/irfndi/beam-clmm/issues/19) | documented |

---

## 8. Fix log

Regression tests are named `state-machine-*.test.ts`; each one fails on the
pre-fix code.

### 8.1 Settlement assets are matched case-insensitively
`engine/autonomous-runtime.ts` — the sweep's job-creation loop now compares
lowercased mints for both the native and the settlement stablecoin, matching the
filter above it. A lowercased USDC holdings key (what the adapter emits) is no
longer an orphan.
Test: `bench/state-machine-settlement.test.ts` — "keeps a lowercased settlement
stablecoin out of the orphan bucket".

### 8.2 Deterministic terminal settlements are not revived
The sweep no longer revives a signature-less `terminal` row whose error
`isUnrecoverableSettlementError` matches — the same classifier that terminalized
it. Such a mint is skipped (it stays in the wallet, visible through `beam status`
stranding classification). Expired/transient terminal rows keep reviving.
Test: `bench/state-machine-settlement.test.ts` — "does not revive a terminal job
whose error is deterministic".

### 8.3 A position group never finalizes on a partial write
Job ids whose `saveSettlementJob` failed are collected, and any group containing
one is skipped for this cycle (the position stays open-with-NULL-PnL, which the
next cycle retries) instead of booking a realized PnL from a subset of legs.
Test: `bench/state-machine-settlement.test.ts` — "does not finalize a group whose
sibling write failed".

### 8.4 An `entered` candidate whose position is gone enters cooldown
`refreshAutonomousCandidates` now applies `cooldown_started` to an `entered`
candidate with no open position on its pool, reusing the existing event, so
`cooling_down → discovered` restores entry eligibility after `oorCooldownMs`
instead of only after a restart.
The event choice is a pure helper, `positionGoneEvent`
(`engine/candidate-policy.ts`), so it is testable without the decision loop.
Tests: `bench/state-machine-candidate.test.ts` — "an entered candidate with no
open position enters cooldown", "positionGoneEvent is null for every
non-entered state", "a scan alone leaves an entered candidate entered".
