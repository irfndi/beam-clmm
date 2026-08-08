# Uniswap v3/v4 Live Transaction Layer — Robinhood Chain (4663)

Research report (2026-08-08) — every signature verified against contract source,
Blockscout verified ABIs, and live `eth_call`s on
`https://rpc.mainnet.chain.robinhood.com`.

## Verified addresses (mainnet)

| Contract                                  | Address                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| UniswapV3Factory                          | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`          |
| NonfungiblePositionManager (v3)           | `0x73991a25c818bf1f1128deaab1492d45638de0d3`          |
| TickLens                                  | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468`          |
| QuoterV2                                  | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7`          |
| SwapRouter02                              | `0xcaf681a66d020601342297493863e78c959e5cb2`          |
| UniversalRouter (**2.1.1**, V4_SWAP=0x10) | `0x8876789976decbfcbbbe364623c63652db8c0904`          |
| Permit2                                   | `0x000000000022D473030F116dDEE9F6B43aC78BA3`          |
| v4 PoolManager                            | `0x8366a39cc670b4001a1121b8f6a443a643e40951`          |
| v4 PositionManager (**NEW interface**)    | `0x58daec3116aae6d93017baaea7749052e8a04fa7`          |
| V4Quoter (new lens interface)             | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94`          |
| WETH9                                     | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (18 dec) |
| USDG                                      | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec)  |

WETH/USDG v3 pools verified: 0.01% `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca`,
0.05% `0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a`,
0.30% `0xa9188730Fe85Be88ad499D7d52B099e800fB0334`,
1.00% `0x5f009E071F07e92B6C624e83F52F17bBDa34680D`.

## Critical gotchas

1. **v4 PositionManager is the NEW interface** — NO `modifyLiquidity(params)`, NO
   `collect(CollectParams)`, NO `positions(tokenId)`. Use:
   - `modifyLiquidities(bytes unlockData, uint256 deadline)` — unlockData =
     `abi.encode(actions, params)`; mint = `[MINT_POSITION(0x02), SETTLE_PAIR(0x0d)]`;
     fee collect = `[DECREASE_LIQUIDITY(0x01, liquidity=0), TAKE_PAIR(0x11)]`
   - `getPoolAndPositionInfo(uint256 tokenId)` → poolKey + packed positionInfo
   - `getPositionLiquidity(uint256 tokenId)` → uint128
   - `permit` / `permitBatch` (Permit2 forwarder)
   - Use `@uniswap/v4-sdk` `V4PositionManager.addCallParameters` /
     `removeCallParameters` / `collectCallParameters` — do NOT hand-encode.
2. **UniversalRouter is 2.1.1**: V4_SWAP command = `0x10` (NOT the 0x1b from old
   guides); v2/v3 commands append `minHopPriceX36`. Use `universal-router-sdk ≥ 5.9.0`.
3. **v3 pools are WETH-paired** (native ETH must be wrapped for v3; v4 uses
   address-zero as first-class currency).
4. **Gas**: Arbitrum FCFS sequencing — `maxPriorityFeePerGas: 0`,
   `maxFeePerGas = 2× baseFee`. Base fee ≈ 0.02 gwei → sub-cent txs.
   Public RPC is rate-limited; use Alchemy for production.

## v3 positions (NPM)

`mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))`
(amount0Min/amount1Min = floors on what you PAY), `increaseLiquidity`,
`decreaseLiquidity` (mins = floors on what you RECEIVE), `collect` (caps, use
`type(uint128).max`), `burn`. Slippage numbers via `@uniswap/v3-sdk`
`Position.mintAmountsWithSlippage` / `burnAmountsWithSlippage`. Approvals: plain
`ERC20.approve(NPM, max)` — Permit2 NOT required for v3 NPM.

## Fee math (read-only)

v3 per token: `feeGrowthInside = feeGrowthGlobal − below(tickLower) − above(tickUpper)`
(below/above from `ticks(t).feeGrowthOutside` flip rule); `uncollected =
liquidity × (feeGrowthInside − feeGrowthInsideLast)/2^128 + tokensOwed`.
v4 same shape; feeGrowthGlobal via `PoolManager.extsload` slot math, or skip the
slot math entirely: `eth_call` the collect tx and read Transfer logs from the
call result (exact amounts + doubles as dry-run).

## Quotes

- v3: `QuoterV2.quoteExactInputSingle` / `quoteExactInput`.
- v4: `V4Quoter.quoteExactInputSingle(((address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData))` and
  `quoteExactInput(((address) exactCurrency, ((address,uint24,int24,address)[] path) path, uint128 exactAmount))`.

## Pool stats / discovery

- **No The Graph subgraph for Robinhood Chain** — **Goldsky** is the indexer
  (Uniswap v3-subgraph has `robinhood-mainnet` config). Query TVL/volume/fees/APR.
- Blockscout API (`https://robinhoodchain.blockscout.com/api/v2/...`) for token
  metadata/holders/exchange rates.
- Uniswap Trading API (`api.uniswap.org`) supports 4663 but needs a key.

## Implementation order

1. Address/config module (this doc) + chain config.
2. Read path: v3 `positions()`; v4 via `getPoolAndPositionInfo`/`getPositionLiquidity`
   (ALREADY DONE in engine/adapter-service.ts); fee formula + eth_call dry-run.
3. v3 tx layer first: approve NPM → mint → increase/decrease → collect → burn;
   swaps via SwapRouter02 with QuoterV2 quotes.
4. v4 tx layer: Permit2 two-step approvals → v4-sdk call params → `modifyLiquidities`;
   swaps via UniversalRouter V4_SWAP (SDK-encoded).
5. Guardrails: deadline now+60–300s, slippage on every path, eth_call dry-run +
   estimateGas before broadcast.
6. Stats: Goldsky subgraph; Blockscout fallback.
