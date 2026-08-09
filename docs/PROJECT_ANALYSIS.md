# PROJECT ANALYSIS — beam-clmm (2026-08-09)

Full multi-angle audit of the $10 → $1M concentrated-liquidity challenge agent on
Robinhood Chain (4663). Sources: 4 parallel subagent audits (ArchAudit,
LiveMoneyAudit, StrategyEcon, OpsStack) + codegraph MCP queries. Tests 1112/1112
green, lint clean, production stack deployed — none of that is in question here;
this report covers what would bite the GOAL.

---

## Verdict

**The code is not safe to fund yet.** 6 P1 findings are reachable on the FIRST
real broadcast (test-wallet run) — nonce race, wrong-chain accounting units,
funding-stablecoin sweep, a position mark that would lock the hard floor, and a
gas-reserve gate that blocks a $10-20 wallet outright. All fixable in ~2-3 hours
(Phase 0 below). After Phase 0, the test-wallet first broadcast is genuinely safe;
before it, the "fund $10-20 and go" plan fails on its own first transaction.

---

## 1. LIVE-MONEY READINESS (LiveMoneyAudit, 12 findings, 6 P1 — all reachable on first broadcast)

| # | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| 1 | **P1** | **Concurrent approval broadcasts race the nonce cache** — two allowances fired via Promise.all on a fresh wallet read the same pending count → identical nonce, second tx rejected/dropped. Hits the FIRST mint exactly. | adapter-service.ts:2046-2049 (cache 950-961) | Await allowances sequentially or mutex sendTx |
| 2 | **P1** | **Nonce cache never reconciled on receipt-wait timeout** — a dropped tx (fee spike, 2× baseFee, FCFS) bricks every later nonce until restart; no gas-bump replacement path, maxPriorityFee=0 | adapter-service.ts:1023-1032 | On timeout: re-read getTransactionCount(pending), reconcile; re-broadcast ×1.5 once |
| 3 | **P1** | **Orphan settlement sweep sells the funding stablecoin** — a fresh wallet's USDG is not "backed by a position" → sold to ETH (~50bps + gas) on boot → wallet unenterable (WETH ≠ native) | autonomous-runtime.ts:660-662 | Exclude STABLECOIN_MINT from sweep |
| 4 | **P1** | **9-decimal SOL pricing of 18-decimal ETH** corrupts settlement PnL (~1e9 inflation) on the first EXIT; v3 routes deliver WETH but measure native delta → stuck reconciliation | autonomous-runtime.ts:544-547 | Native decimals 18 (chain-aware); measure WETH delta on v3 |
| 5 | **P1** | **Position mark heuristic undervalues 18/6 pools ~20,000×** (liquidity/1e18 × price × 2 vs real amounts) → portfolio equity collapses after first ENTER → 50% hard floor locks all later entries + phantom drawdown → EXIT churn. The comment claims this was fixed; it wasn't on the live path (realMark wins whenever non-null) | adapter-service.ts:1964-1973; program.ts:5105-5107 | Real sqrt-price-bounded amount math, or prefer HODL-anchored mark |
| 6 | **P1** | **0.05 ETH entry-gate reserve** (~$150-200) blocks a $10-20 wallet; top-up drain cap (20%) can't bridge it; error says "Insufficient SOL" with lamports math | constants.ts:12-17 | Set MIN_NATIVE_FOR_ENTRY_WEI=0.005 ETH for test (env override exists) |
| 7 | P2 | 300s tx deadlines vs no-replacement gas strategy → reverts + burned gas under spikes | adapter-service.ts:2025 | 15-30min deadlines for position txs, 5min only swaps |
| 8 | P2 | v4 pools with native as currency1 unsupported (useNative only when c0 native) → opaque dry-run revert | adapter-service.ts:725-727 | useNative for either leg |
| 9 | P2 | Permit2 allowance check ignores expiry (unreachable today — MAX_UINT48) | adapter-service.ts:1095 | Compare p2[1] expiry |
| 10 | P2 | Malformed WALLET_PRIVATE_KEY → account=null → silent paper-mode with no boot signal | adapter-service.ts:918-926 | Fail boot loudly when key configured but unparseable |
| 11 | P2 | Challenge loss cooldown lives in a session Map → restart re-enters crashing pools | program.ts:7389-7394 | Persist via db metadata |
| 12 | P2 | EXIT receipt-wait timeout after mining → PnL never booked, row silently deleted, peak equity stale | program.ts:1585-1592 | Probe tx receipt before reconcile-delete |

Verified sound (not re-audited): chain-identity guard, key never logged, risk-gate
structure (50% floor, 6h cooldown, min(40%/10%) cap, halve→EXIT).

## 2. ARCHITECTURE (ArchAudit)

- **God module**: program.ts 7,876 lines; nested program effect captures ~50
  mutable locals; evaluatePool ≈2,910 lines (complexity 700 — codegraph);
  runScanCycle 107. Velocity blocker #1.
- **services.ts hub** (1,505 lines): ~25 tags, 9 type-only import cycles back to
  implementations — refactor hazard, un-splittable as-is.
- **P1 contract divergence**: AdapterApi promises measured bin-holdings marks;
  adapter delivers the liquidity heuristic (see LiveMoneyAudit #5) — the doc lies.
- **Dead SOL-era surface still shipping**: MeteoraDatapiService/MeteoraPoolStats,
  swapUSDCForToken/quoteSwapUSDCForToken (no callers), claimRewards stub with a
  live call site (always-skip), entry-sol-budget identity function + SOL naming
  ("Insufficient SOL", lamports) in money code.
- **Backtest drifted**: ops/backtest.ts replays cycle/evaluate-pool.ts, a
  simplified decision chain — not the live 10-branch EXIT / mega ENTER gate.
- Serial per-pool scan scales linearly.

## 3. STRATEGY ECONOMICS (StrategyEcon)

- **Scoring mis-ranks the book**: `(1 + dd/100)` drawdown penalty too weak → top
  of the harvest book prefers high-yield/high-drawdown memes over the verified
  zero-IL ETH/USDG anchors. halve is dead nomenclature (halve and exit both → EXIT).
- **Sizing wall at defaults**: MAX_ENTRY_SIZE_USD 500 × MAX_OPEN_POSITIONS 4 caps
  the book at $2-8k — the doc's $148k capacity ladder unreachable; $96 gas
  reserve blocks a live $10 account (see LiveMoneyAudit #6).
- **Paper validation measures nothing**: fee accrual gated to statsSource
  "datapi"; running paper on Krystal books $0 fees forever.
- **The math stands**: $10→$1M = 100,000×. Honest band: 4%/d → 294d, 3%/d →
  389d; capacity-decaying rates make constant-rate tables optimistic past ~$150k.
- **Missing**: stable-anchor sleeve ("not lose any money" has no code path),
  book-level de-risk, compounding flags off by default.

## 4. OPERATOR STACK (OpsStack)

- **P0: No remote kill switch.** Loopback /propose + /approve only; no pause/halt
  endpoint on the API; all safety halts are local latches with no Telegram push.
- **P1 (root-caused)**: revenue-config-service calls `prism-api.irfndi.workers.dev`
  (LEGACY worker) every cycle → the recurring warning; cache never populated →
  re-fetch every 15s. Correct host: beam-api.irfndi.workers.dev/v1/config.
- **P1: D1 flood** — 1 snapshot + up to 6 decisions per 15s cycle, INSERT OR
  REPLACE, no retention/pruning → free-tier quota.
- **P1: silent events** — crash, liveness loss, hard-floor halt, safety pause all
  produce no Telegram notification.
- P2: exit alerts omit P&L; /link says "6-character code" but codes are 16 hex;
  alert delivery depends on an external GitHub Actions cron with no watchdog.

## 5. CODEGRAPH EMPIRICAL DATA

- Index: 308 files, 1123 functions, 65 classes, 235 modules; maintainability 45/100.
- Complexity top: evaluatePool 700, executeLive 173, evaluateAgentProposal 109,
  runIdleRedeployPass 108, runScanCycle 107, runBacktestFromTicks 105.
- Coupling: engine instability 0.45 (balanced), cli 0.91 (leaf), cloudflare 0.375.
- **Graph limitation, measured**: found 4 of 14 real `sendTx` call sites (misses
  closure-scoped calls). find_dead_code = all false positives (misses cross-file
  imports). Use for complexity/coupling only; `lsp references` for call sites.

---

## ROADMAP

### Phase 0 — make the first broadcast safe (≈2-3h, do BEFORE funding)
1. LiveMoneyAudit #6: MIN_NATIVE_FOR_ENTRY_WEI → 0.005 ETH (test config) + SOL→ETH messaging
2. #1: serialize allowance broadcasts (first-mint nonce race)
3. #3: exclude USDG from orphan settlement sweep
4. #5: position mark — real amount math or HODL-anchor preference (unblocks hard floor + kills churn)
5. #2: nonce-cache reconcile on timeout + one gas-bump re-broadcast
6. #4: 18-decimal native pricing in settlements + WETH delta on v3
7. OpsStack: fix revenue-config host (stops the cycle noise) + exit alert P&L

### Phase 1 — test-wallet live validation (after Phase 0)
- Fund $10-20 → first real mint → read-back → fees → collect → exit
- Then: kill switch (API /v1/control/pause + Telegram /pause), halt notifications

### Phase 2 — strategy hardening (toward the $1M curve)
- Fix scoring dd penalty / re-rank anchors; delete halve nomenclature
- Raise sizing caps to unlock the capacity ladder ($500→, 4→ positions)
- Paper fee accrual on Krystal stats (make paper measure something)
- Stable-anchor sleeve (the "not lose money" requirement)
- Persist challenge loss cooldown (P2 #11)

### Phase 3 — architecture (velocity)
- Extract evaluatePool/runScanCycle decision core to pure functions (program.ts 7.9k lines)
- Delete dead SOL-era surface (MeteoraDatapi, swapUSDCForToken, claimRewards stub, entry-sol-budget)
- Untangle services.ts hub; parallelize read phase of scan loop
- D1 retention/pruning for engine-state; backtest re-sync to live decision chain

---

*Sources: agent://ArchAudit, agent://LiveMoneyAudit, agent://StrategyEcon, agent://OpsStack; codegraph metrics. Severity = agent-assigned. Confidence: LiveMoneyAudit 0.82 overall, per-finding 0.7-0.95.*
