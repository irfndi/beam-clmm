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

## 3. Robinhood Chain opportunity — corrected inventory (Krystal API, 2026-08-09)

> **Correction:** the gecko-only snapshot below the line was incomplete. The
> Krystal LP explorer API (`https://api.krystal.app/all/v2/lp_explorer/top_pools`,
> chainId 4663) exposes the full universe with **measured per-pool fee income**
> (`stat24h.feeUsd` from on-chain fee growth), `drawdown24h`, `priceVolatility`,
> dynamic-fee state, and per-token symbols. **500-pool universe (live):**
> **356 pools ≥ 1%/day fee yield, 82 ≥ 5%/day, 60 ≥ 10%/day; median 1.31%/day.**
> This is 5–10× richer than the gecko-derived snapshot (gecko lacks per-pool fee
> data on this chain — its APR model under-reported massively).

**The 17 harvest candidates (≥ 5%/day fee yield AND 24h drawdown ≥ −5%):**

| Pool | Yield/day | 24h dd | TVL | Fee | Turnover |
|---|---|---|---|---|---|
| ETH/USDG v4 (dynamic) | 18.29% | −0.02% | $237k | dyn | 23.9× |
| ETH/USDG v4 (dynamic) | 17.06% | −0.01% | $202k | dyn | 22.8× |
| ETH/CASHCAT v4 | 36.64% | 0.00% | $5.3k | 1.104% | 36.5× |
| ETH/TENDIES v4 | 15.87% | 0.00% | $2.4k | 1.10% | 15.8× |
| ETH/USDG v4 (5% dyn) | 13.45% | −0.01% | $565k | 5.0% | 18.2× |
| ETH/CASHCAT v4 | 12.63% | 0.00% | $3.0k | 0.34% | 43.6× |
| ETH/PRYSM v4 | 8.03% | −2.3% | $1.3k | 1% | 8.0× |
| ETH/FORTUNA v4 | 7.93% | −4.7% | $1.3k | 1% | 7.9× |
| USDG/FRONG v4 | 5.49% | 0.00% | $9.8k | 1.104% | 5.5× |
| ETH/TOAD v4 | 5.33% | 0.00% | $6.2k | 1% | 5.3× |
| ETH/GUAC v4 | 4.50% | 0.00% | $7.0k | 1% | — |
| ETH/MANCER v4 | 5.15% | −5.0% | $40k | 2.1% | 2.6× |
| + 5 more (ETH/USDG 4.7%@$609k, etc.) | | | | | |

**The key findings the gecko snapshot missed:**
1. **ETH/USDG v4 dynamic-fee pools are the motherlode**: 17–18%/day at $200–237k
   TVL with ~0 drawdown (stable pair, 20×+ daily turnover, high dynamic fee), plus
   a 5%-fee pool at $565k (13.4%/day). **A stable-anchor harvest at scale with
   ~zero IL** — the exact opposite of the meme-only picture.
2. **Meme harvest pools exist with 0 drawdown TODAY** (ETH/CASHCAT 36.6%/day,
   ETH/TENDIES 15.9%/day) — but they're $2–9k TVL (capacity-limited, token-crash
   risk is one bad day away — dd24h=0 is today's snapshot).
3. **Top-yield pools are mostly top-crash pools** (the 60 ≥10%/day pools have
   dd24h −34% to −89%): the 17-candidate filter (yield AND drawdown) is the
   operative strategy signal, and it must be re-measured continuously — the
   harvest set rotates hourly.

**Share-adjusted daily earnings (fee yield × your share of pool TVL):**

| Pool | TVL | $100 | $1k | $10k |
|---|---|---|---|---|
| ETH/CASHCAT 36.6%/d | $5.3k | $0.69 (0.7%/d) | **$6.9 (6.9%/d)** | pool-capped |
| ETH/TENDIES 15.9%/d | $2.4k | $0.65 | **$6.5 (6.5%/d)** | pool-capped |
| ETH/USDG 18.3%/d | $237k | $0.008 | $0.08 | $0.77 (0.8%/d) |
| ETH/USDG 13.4%/d | $565k | — | $0.02 | $0.24 |
| USDG/FRONG 5.5%/d | $9.8k | $0.06 | $0.56 | $5.6 |

**The share constraint is now the central design fact**: $100–1,000 CAN earn
0.7–6.9%/day by being a large share of the tiny meme harvest pools; $10k+ must
ride the ETH/USDG anchor cluster (0.2–0.8%/day) or a multi-pool harvest book.
Growth past each pool's TVL forces rotation into the next tier — the agent's
pool-selection IS the strategy.

**Gas/tx economics (unchanged):** base fee 0.0297 gwei, sub-cent txs; hourly
recompound viable at $500+.

<details><summary>Original gecko-derived snapshot (superseded — kept for comparison)</summary>

Gas: base fee **0.0297 gwei** (~0.00003 ETH ≈ $0.06 per 1M-gas tx); blocks ~101ms
(~9.9 blocks/s); 11.48M txs/day; ETH $1,914.

**Top pools by 24h volume (GeckoTerminal live):** USDG/WETH 0.01% v3 anchor
($34.9M vol/$6.66M = 19.1% APR); WETH/USDG v4 4%* cluster (~$39.6M/$3.0M ≈
53%/day pool-wide, decaying, fee tier inferred); CASHCAT/WETH 1% (363% APR);
PEPE/WETH 0.25% ($106k TVL, 2,930% APR); BLINK/WETH 1% (3h old, 3,390%);
MOG/WETH 1% (10,424%). Meme dispersion: median ~1.06%/day, best 8–9.3%/day,
24h moves −29% to −36% on the best — full-range LP is IL-swamped. Per-capital:
v3 anchor $10→$0.005/d; PEPE $100→$0.80/d; v4 cluster (if 4%) $100→$386/d.
*[INFERENCE] v4 fee tier.

</details>

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

**Corrected verdict (post-Krystal):** the opportunity set is real and rich —
82 pools ≥ 5%/day, and a **stable-pair harvest exists (ETH/USDG dynamic-fee
cluster: 13–18%/day, ~0 IL)**. The $10 → $1M math still requires a large share of
small high-yield pools (capacity-limited) or sustained multi-pool rotation, but
the honest ceiling is far above the gecko-era estimate: **$100–1,000 can compound
at 0.7–6.9%/day in the meme harvest tier; $10k+ rides the anchor cluster at
0.2–0.8%/day plus a diversified harvest book.** The 112-day scenario table:
conservative 1%/d → ~3x; base 3%/d → ~27x; aggressive 6%/d (sustained harvest
rotation, unlikely) → ~700x. **The wash-trading verdict stands (prohibited); the
strategy is organic fee harvesting with continuous drawdown-gated rotation.**

**Build order (next milestones):**
1. **Live-tx v3 layer** (mint/collect/burn/swap) + fix `getPositionValueUsd` +
   gas-floor config for small accounts → first real fees.
2. **Krystal stats source** (pool discovery + measured feeUsd + drawdown24h —
   the strategy's primary signal set) + gecko fallback.
3. **Two-tier loop** (slow 500-pool universe refresh 5–15 min + fast harvest
   lane every 10–60s with drawdown-gated exits) + multicall batching +
   concurrency.
4. **Challenge-mode strategy**: the 17-candidate scoring/tiering, volatility-
   sized ranges, rotation triggers, fee/gas-aware compounding cadence.
5. **v4 single-tx compound** + UniversalRouter swaps (resolve address).
6. **Live challenge book**: wallet + P&L ledger (fees vs IL vs price).
