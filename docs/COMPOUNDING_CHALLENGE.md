# Beam Compounding Challenge — End-to-End Research

**Goal:** $10 → $1M compounding via autonomous Uniswap v3/v4 concentrated-liquidity
fee harvesting on Robinhood Chain. Reference claim: "$100 → $2M in 112 days".
**Snapshot:** 2026-08-09. Sources: 5 parallel research agents (landscape, fee math,
chain inventory, engine throughput, ops/risk) + live API data (GeckoTerminal,
Blockscout, RPC).

---

## 1. The challenge math — what the claim actually requires

| Target | Days | Required net daily rate | Doubling time | Doublings |
|---|---|---|---|---|
| $100 → $2M | 112 | **9.245%/day** | 7.84d | 14.29 |
| $10 → $1M | 112 | **10.826%/day** | 6.74d | 16.61 |
| $100 → $100k | 112 | 6.362%/day | 11.2d | 9.97 |

**112-day multiples at sustained rates:** 1%/d → 3.0x · 2%/d → 9.2x · 3%/d → 27.4x ·
4%/d → 80.9x · 5%/d → 236x · 9.25%/d → 20,100x.

**The claim is unverifiable folklore** — no indexed example of "$100→$2M in 112 days"
has an on-chain ledger; every public "$10 to $1M" is a memecoin/copy-trading marketing
funnel. But the math is real and must be taken apart.

## 2. Strategy taxonomy — what people actually run, and the verdict

| Strategy | Mechanics | Verdict for an autonomous agent |
|---|---|---|
| **(a) Organic fee harvesting** | LP a range on high-volume pools, collect third-party fees, compound (Revert Compoundor pattern) | **Primary path.** Honest 1–4%/day on in-range capital in the hottest pools. The engine's scan/gate/decision loop already matches it. |
| **(b) Self-trading / volume farming** | Round-trip swaps against your own liquidity to manufacture volume and harvest fees. Net per round trip ≈ 2f·share − 2·(size/depth) − gas; at f=1%, ~1.0–1.6%/trip → **6–9 trips/day closes the 9.25%/day math — the only mechanical way small capital does it** | **DO NOT SHIP.** Wash trading: prohibited by Uniswap Labs ToS (rev 2026-02-02), Robinhood Crypto Customer Code of Conduct, SEC enforcement (2024-166), DOJ (CLS Global guilty plea). Also eaten by MEV/sandwich in practice. |
| **(c) Token speculation via LP** | Tight one-sided range on a token you're bullish on (LP as leveraged long) | Highest variance, survivorship-biased lottery. Only as a bounded gated sleeve (≤10%, hard stops). |
| **(d) Arb / JIT / MEV** | Cross-pool arb, just-in-time liquidity, sandwiches | Professional searcher business; JIT ROI ~0.007%/event, <1% of volume. Not a $10 path. |
| **(e) Airdrop/points farming** | Volume farming for token incentives | No points program identified on Robinhood Chain. N/A. |

**The share constraint (why small capital fails at pool-level yields):**
`your return/day = pool yield on active liquidity × your share of active liquidity`.
Live example: PEPE/WETH 0.25% pays 8.02%/day of its $106k TVL — $100 there earns
~0.08%/day (1.1x over 112 days); $10k (10% of pool) earns ~8%/day (5,655x). **Small
capital only earns pool-level yields when it IS the liquidity (a fresh pool you are
~100% of) — or via wash volume.**

## 3. Robinhood Chain opportunity — live inventory (2026-08-09)

Gas: base fee **0.0297 gwei** (~0.00003 ETH ≈ $0.06 per 1M-gas tx); blocks ~101ms
(~9.9 blocks/s); 11.48M txs/day; ETH $1,914.

**Top pools by 24h volume (GeckoTerminal live):**

| Pool | 24h vol | Reserve | Turnover | Fee APR |
|---|---|---|---|---|
| USDG/WETH 0.01% v3 (anchor) | $34.9M | $6.66M | 5.2×/d | 19.1% |
| WETH/USDG v4 4%* (6-pool cluster) | ~$39.6M | ~$3.0M | 13.2×/d | **~53%/day pool-wide** |
| CASHCAT/WETH 1% | $5.17M | $5.19M | 1.0×/d | 363% |
| PEPE/WETH 0.25% | $3.39M | $106k | 32.1×/d | 2,930% |
| BLINK/WETH 1% (3h old) | $2.98M | $321k | 9.3×/d | 3,390% |
| MANCER 1% | — | — | — | 1,200% |
| MOG/WETH 1% | $747k | $26k | 28.6×/d | 10,424% |

*[INFERENCE] v4 fee tier (gecko returns null; repo convention 39999≈4%). If 0.046% instead, the anchor cluster is ~1,620% APR (still top).

**Meme-pool dispersion (hot pools, <24h old):** median ~1.06%/day (387% APR), best
8–9.3%/day (PEPE/BLINK), max:min ≈ 70:1. **Caveat:** 24h price moves −29% to −36%
on the best pools — full-range LP is IL-swamped; the fee APR is only capturable with
tight ranges + fast rebalance, and most meme volume is launch-window churn that dies
in hours-to-days (98% of tokens dead in 3 months; 0.0045% ever >$1M cap).

**Per-capital daily fees (proportional share, today):**

| Pool | $10 | $100 | $1k | $10k |
|---|---|---|---|---|
| v3 0.01% anchor | $0.005 | $0.052 | $0.52 | $5.23 |
| v4 4% cluster (if 4% holds) | up to $38/d | $386/d | $3,865/d | — |
| CASHCAT 1% | $0.10 | $1.00 | $9.96 | $99.6 |
| PEPE 0.25% | $0.80 | $8.03 | $80.3 | $803 |

**Gas verdict:** sub-cent txs; hourly recompound costs $1.79–7.76/d — only pays at
$500+ in ≥100%-APR pools. At $10–100: recompound ≤ daily.

## 4. Fee-harvesting math (the operating regime)

**Concentration factor:** a range [pₐ, pᵦ] concentrates capital relative to
full-range. At the geometric-mean price, liquidity multiplier
`M = 1/(1 − α^{−1/4})` where `α = pₐ/pᵦ` (range ratio). Worked: 50% wide range
(α = 1.5) → M ≈ 6.1×; 20% (α = 1.2) → M ≈ 17×; 10% (α = 1.1) → M ≈ 39×.
**Fees scale with M while in range; out-of-range you earn nothing and hold one-sided.**

**Optimal range width vs volatility:** the known tension (Gamma/Charm active-liquidity
literature + Uniswap v3 book): range half-width should cover ~1–2σ of the daily
volatility to stay in range >80% of the time. Live measured: CASHCAT ~7.3%/day price
volatility → a ±15–20% range keeps you in-range ~85–95% of a day. Rebalance when price
drifts to the range edge (or OOR grace expires) — the engine's existing
REBALANCE/OOR logic already models this.

**IL vs fees breakeven (why meme-pool tight-range harvesting is a short-vol bet):**
Loesch et al. 2021: 49.5% of v3 LPs underperform HODL; IL > fees in >80% of pools.
Fritsch & Canidio 2024: fees ≈ 80% of arbitrage losses in the largest pools.
For a volatile pair, LP payoff ≈ fee income − IL; tight ranges increase BOTH. The
breakeven daily volume needed to cover a price move σ is roughly
`V_breakeven ≈ IL(σ) / (f × M × share)`. A token doing −36%/day (PEPE's 24h move)
needs enormous fee income to cover the IL — this is why full-range meme LP is a
disguised short-volatility bet and the dominant loss term is token decay, not fees.

**Compounding frequency:** daily vs weekly at 100% APR: 2.714x vs 2.685x (~1%
difference); at 2,000% APR: 5.37x vs 4.74x (~13% difference). With gas at ~$0.075
per full cycle, the rule is: recompound when `accrued fees > 10× gas cost` (so gas
< 10% of fees). Hourly (24×/d) is only rational at $500+ in ≥100%-APR pools.

**Self-trading quantified (for the record, NOT recommended):** round-trip net ≈
2f·share − 2·(size/depth) − gas; at f=1%, trades at 0.2–0.5% of depth, 100% LP
share → net 1.0–1.6% per trip → 6–9 trips/day = 9.25%/day. This is mechanically
how the challenge numbers close, and it is wash trading with real enforcement
precedent. The agent will NOT do this.

## 5. Engine architecture for high throughput (from code audit)

**Current per-pool cycle cost: 13–14 eth_calls + 1 serial gecko HTTP (2.1s, no cache)
+ ~7 SQL ops; sequential pool loop; cycle ≥ 2.1s × N pools.**

**Bottleneck ranking + fixes (ordered):**

1. **Gecko stats cache (Critical)** — 2.1s serial fetch per pool per cycle, no TTL.
   Fix: module Map TTL cache (5–15 min; 24h volume barely moves), same pattern as
   gecko-ohlcv. N pools → 0–1 fetches/cycle. Effort S.
2. **Multicall3 batching (High)** — batch the 5 state reads + 3 TickLens words into
   ~2 eth_calls/pool; drop duplicate slot0/tickSpacing reads. Effort M.
3. **Parallel pool evaluation (High)** — `Effect.all(evaluatePool, { concurrency: 4–8 })`.
   Effort M.
4. **Fix `getPositionValueUsd` (High, live blocker)** — calls `priceUsd(poolAddress)`;
   a pool address is not a mint → $0 marks → dust-exit/trailing-stop churn. Hoist
   owner positions to cycle top (fixes O(B²) NPM reads too). Effort S.
5. **Hoist `getClosedPositions()`** to cycle top (re-read per pool today). Effort S.
6. **Snapshot writes** — write on tick-change or 5-min bucket, not every pool every
   cycle (60 pools × 10s = 518k rows/day today). Effort S/M.
7. **Fast lane** — SCAN_INTERVAL_MS floor 10s; add a short-tick lane for pools with
   open positions + full-universe rotation (marketScan top-K pattern exists).
   Effort M.
8. **Simulate-rebalance** — currently returns zeros; live REBALANCE can never pass
   the net-benefit gate. Rides the tx layer. Effort M.

**Live-tx pipeline (the only path to real fees — build order):**
- **v3 first** (plain ERC20 approvals, no Permit2 needed): NPM `0x73991a25…`
  mint/decreaseLiquidity/collect/burn; SwapRouter02 `0xCaf681a6…` + QuoterV2
  (in-SDK quotes — quoters revert empty on public RPC); compound = 3 txs
  (collect → swap → add) — sub-cent each, acceptable.
- **v4 second** (single-tx compound via `modifyLiquidities` unlockData;
  `@uniswap/v4-sdk` addCallParameters/collectCallParameters; Permit2 approvals;
  UniversalRouter 2.1.1 V4_SWAP command 0x10). ⚠️ Resolve the UniversalRouter
  address discrepancy (adapter const `0x06AfBA…` vs doc `0x887678…`) on Blockscout
  before building.
- Gas: priority 0, maxFee = 2× baseFee (~0.06 gwei), sub-cent txs; eth_call
  dry-run + estimateGas before broadcast; Alchemy RPC for production.

**Dynamic sizing (the $10 AND $100k problem):**
- **$10 account is blocked today**: live ENTER gate requires 0.05 ETH (~$96) gas
  reserve (constants.ts). Must become configurable (0.0001–0.001 ETH ≈ $0.2–$2).
  Challenge config: MAX_OPEN_POSITIONS 1–2, MAX_ENTRY_SIZE_USD floor, MIN_POOL_TVL
  ~10k.
- **$100k account is capped at ~1.5% deployed**: MAX_ENTRY_SIZE_USD default 500
  dominates; raise to ~25k, MAX_OPEN_POSITIONS 10–20, implement
  `discoverPoolsTopPages` for market-scan breadth.

## 6. Risk framework

- **Ruin reality:** meme tokens: 98% dead ≤3 months, 0.0045% ever >$1M cap, 56% of
  traders lost ≥$1k. IL exceeds fees in >80% of studied v3 pools. -50% needs +100%
  to recover; -90% needs 10x. The challenge format is a 1-in-10⁴+ outcome.
- **Honest scenarios for $10 (zero-IL assumption, dominant-LP, volume persists):**
  1%/day → $11k/112d; 3%/day → $35k; 5%/day → $236k; 9.25%/day (fantasy) → $1M.
  With IL/token-decay drag the realistic 112-day band is **$150–$8,000**.
- **Guardrails the engine must enforce:**
  - Per-pool exposure ≤ 5% of pool TVL (never be the pool's dominant LP on a meme).
  - IL-stop: token price moved X% from entry → close (config-driven, default tight
    for memes).
  - Pool TVL floor + collapse detection (liquidity removal → exit).
  - Fee-income telemetry: a position not earning fees for N cycles → rebalance/exit.
  - Range: 1–2σ volatility width, rebalance on OOR grace expiry.
  - Sleeve cap: speculative one-sided bets ≤10% of capital with hard stops.
  - Compounding: only when accrued fees > 10× gas.

## 7. The verdict + recommended build sequence

**The honest answer:** $10 → $1M in 112 days is not achievable via compliant organic
fee harvesting (needs 10.8%/day; organic ceiling with real capital is ~1–4%/day, and
small capital earns a small share of pool yields). The 112-day claim closes only via
wash trading (prohibited, won't build) or a 1-in-10⁴ token lottery (legal but
expected-negative). **What IS achievable and worth building:** an autonomous
fee-harvesting agent that compounds 1–4%/day in the best rotating meme/anchor pools
($10 → $150–8,000 in 112 days; $100k → meaningful 20–50%/day-in-pool capture with
diversification), with IL/rug gates that make it survivable — the difference between
this and the failed 99.99% of challenges is the gates, cadence, and honest book.

**Build order (next milestones):**
1. **Live-tx v3 layer** (mint/collect/burn/swap) + fix `getPositionValueUsd` +
   gas-floor config for small accounts → first real fees in paper→live.
2. **Throughput refactor** (gecko cache → multicall → concurrency → fast lane) →
   sub-minute full-universe cycles.
3. **Strategy v1 (challenge mode)**: anchor + meme rotation, volatility-scaled
   ranges, IL-stop gates, fee/gas-aware compounding cadence, the guardrail spec
   above.
4. **v4 single-tx compound** + UniversalRouter swaps (resolve address first).
5. **Live challenge book**: wallet + P&L ledger (fees vs IL vs price) — the thing
   no published challenge has.
