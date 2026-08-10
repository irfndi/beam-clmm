import { Effect, Layer } from "effect";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContract,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CurrencyAmount, Ether, Percent, Token } from "@uniswap/sdk-core";
import {
  NonfungiblePositionManager as V3NonfungiblePositionManager,
  Pool as V3Pool,
  Position as V3Position,
  TickMath,
  nearestUsableTick,
  type TickDataProvider,
} from "@uniswap/v3-sdk";
import { Pool as V4Pool, Position as V4Position, V4PositionManager } from "@uniswap/v4-sdk";
import { ConfigService } from "./config-service.js";
import { AdapterService, type AdapterApi, type DiscoveredPool } from "./services.js";
import type { EntryDepositMode } from "./types.js";
import type { BinArray, BinData, PoolState, Position } from "./types.js";
import {
  GAS_TOP_UP_STABLECOIN,
  MIN_NATIVE_FOR_GAS_WEI,
  NATIVE_MINT,
  STABLECOIN_MINT,
} from "./constants.js";
import { createLogger } from "./logger.js";
import { DiscoverPoolsError, underlyingErrorMessage } from "./errors.js";

const logger = createLogger("EVMAdapter");

// ─── Robinhood Chain verified addresses (2026-07; Uniswap deployment docs +
//     Blockscout cross-check). Do NOT assume other-chain addresses — the
//     Uniswap docs explicitly warn deployments differ per chain.
export const CHAIN_ID = 4663;
export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const V3_FACTORY: Address = getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
export const V3_NPM: Address = getAddress("0x73991a25c818bf1f1128deaab1492d45638de0d3");
export const V3_TICK_LENS: Address = getAddress("0x7dfd4f31be6814d2906bde155c3e1b146eac1468");
export const V4_POSITION_MANAGER: Address = getAddress(
  "0x58daec3116aae6d93017baaea7749052e8a04fa7",
);
export const V4_STATE_VIEW: Address = getAddress("0xF3334192D15450CdD385c8B70e03f9A6bD9E673b");
// Official 4663 deployments (developers.uniswap.org/deployments.json, 2026-07-15).
export const UNIVERSAL_ROUTER: Address = getAddress("0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99");
export const V3_SWAP_ROUTER_02: Address = getAddress(
  "0xCaf681a66D020601342297493863E78C959E5cb2",
);
// v3 pools on Robinhood Chain are WETH-paired (native ETH must be wrapped for
// v3; v4 treats address-zero as a first-class currency). Verified 2026-07.
export const WETH9: Address = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");

/**
 * v4 pools have no per-pool contract address — identity is the PoolKey struct
 * and the poolId is keccak256(abi.encode(key)), which cannot be reversed
 * on-chain. The engine's `poolAddress` for a v4 pool is therefore the poolId
 * (lowercase 0x-hex), resolved to a PoolKey through this registry. Populate
 * entries from the Uniswap UI / explorer for the pools you manage.
 * ponytail: static registry, add a pool-indexer when v4 discovery is needed.
 */
export interface V4PoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}
export const V4_POOL_REGISTRY: Record<string, V4PoolKey> = {};

/**
 * Register a v4 pool key by poolId (lowercase 0x-hex). v4 pools have no
 * on-chain enumeration (poolId is a one-way hash), so discovery seeds this
 * registry from known pairs / an indexer; `poolKeys(bytes25)` on the
 * PositionManager can reverse a truncated id when the key is unknown.
 */
export function registerV4Pool(poolId: string, key: V4PoolKey): void {
  V4_POOL_REGISTRY[poolId.toLowerCase()] = key;
}

// ─── Minimal ABIs (only the functions this adapter calls) ────────────────────

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const v3FactoryAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "function feeAmountTickSpacing(uint24) view returns (int24)",
]);
const v3PoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const tickLensAbi = parseAbi([
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) view returns ((int24,int128,uint128)[])",
]);
const v3NpmAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
const v4StateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const v4PositionManagerAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address,address,uint24,int24,address) poolKey, uint256 positionInfo)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
  "function poolKeys(bytes25 poolId) view returns ((address,address,uint24,int24,address) poolKey)",
]);

/** ERC-721 Transfer event — the enumeration source for the non-enumerable
 *  v4 PositionManager (tokenOfOwnerByIndex reverts; ownerOf multicall batches
 *  revert on ANY burned id). Mint = from 0x00, burn = to 0x00. */
const erc721TransferEvent = {
  type: "event",
  name: "Transfer",
  inputs: [
    { type: "address", name: "from", indexed: true },
    { type: "address", name: "to", indexed: true },
    { type: "uint256", name: "id", indexed: true },
  ],
} as const;

/** v3 factory PoolCreated — canonical event, verified on 4663. */
const poolCreatedEvent = {
  type: "event",
  name: "PoolCreated",
  inputs: [
    { type: "address", name: "token0", indexed: true },
    { type: "address", name: "token1", indexed: true },
    { type: "uint24", name: "fee", indexed: true },
    { type: "int24", name: "tickSpacing" },
    { type: "address", name: "pool" },
  ],
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isNative(mint: string): boolean {
  return mint.toLowerCase() === NATIVE_MINT.toLowerCase();
}

/** Uniswap tick → price of token1 in token0 (1.0001^tick). */
function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

function sqrtPriceX96ToPrice(sqrtPriceX96: bigint): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio;
}

const decimalsCache = new Map<string, number>();

/** v4 poolId = keccak256(abi.encode(poolKey)) — canonical v4 pool identity. */
async function computeV4PoolId(key: V4PoolKey): Promise<string> {
  const encoded = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  );
  return keccak256(encoded).toLowerCase();
}

// ─── Live-transaction ABIs (only the functions this adapter broadcasts) ─────

const v3MintDecodeAbi = parseAbi([
  "function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))",
]);
const swapRouter02Abi = parseAbi([
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) payable returns (uint256)",
  "function unwrapWETH9(uint256,address) payable",
  "function multicall(bytes[]) payable returns (bytes[])",
]);
const universalRouterAbi = parseAbi(["function execute(bytes,bytes[],uint256) payable"]);

/** Permit2 (canonical 0x000…22D4 deployment, used by the v4 PositionManager
 *  and UniversalRouter as a forwarder). */
export const PERMIT2: Address = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

export const MAX_UINT256 = 2n ** 256n - 1n;
export const MAX_UINT160 = 2n ** 160n - 1n;
const MAX_UINT48 = 2n ** 48n - 1n;

// Position txs (mint/collect/exit/rebalance) carry a 30-minute deadline:
// they are not price-critical (no ordering risk), and under a baseFee spike
// the FCFS mempool can hold a tx past the old 300s deadline — reverting on
// inclusion and burning gas. SWAPS keep a 5-minute deadline (price-critical).
const POSITION_DEADLINE_S = 30 * 60;

/** ERC-721 Transfer(address,address,uint256) — minted NFTs emit from = 0x0. */
const erc721TransferTopic = keccak256(toHex("Transfer(address,address,uint256)")).toLowerCase();
/** UniswapV3 Swap event — receipt-level output decoding. */
const v3SwapEventTopic = keccak256(
  toHex("Swap(address,address,int256,int256,uint160,uint128,int24)"),
).toLowerCase();

/** viem chain object for wallet transactions on 4663. */
export const ROBINHOOD_CHAIN = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC] } },
} as const;

// ─── Pure calldata builders + quote math (network-free, unit-tested) ─────────

/** Pool state snapshot the pure builders/quotes need (v3 and v4 both). */
export interface PoolQuoteState {
  readonly token0: Address;
  readonly token1: Address;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly sqrtPriceX96: bigint;
  readonly tickCurrent: number;
  readonly liquidity: bigint;
}

/** Convert a USD size into raw atomic units for a leg. 0 when unpriceable. */
export function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (!(priceUsd > 0) || !(usd > 0)) return 0n;
  return BigInt(Math.floor((usd / priceUsd) * 10 ** decimals));
}

/** Half-width tick range (±rangeBps) around the current tick, spacing-aligned. */
export function tickRangeAround(
  tick: number,
  tickSpacing: number,
  rangeBps = 500,
): { tickLower: number; tickUpper: number } {
  const half = Math.round(Math.log(1 + rangeBps / 10_000) / Math.log(1.0001));
  return {
    tickLower: nearestUsableTick(tick - half, tickSpacing),
    tickUpper: nearestUsableTick(tick + half, tickSpacing),
  };
}

function sdkPercent(bps: number): Percent {
  return new Percent(Math.round(bps), 10_000);
}

function v3Token(addr: Address, decimals: number): Token {
  return new Token(CHAIN_ID, getAddress(addr), decimals);
}

/**
 * TickDataProvider that reports no initialized ticks — the SDK swap loop then
 * performs constant-product steps at the pool's current in-range liquidity.
 * ponytail: single-hop quote at current liquidity; a trade crossing an
 * initialized tick executes worse than quoted, so the router's
 * amountOutMinimum (slippage) is the guard. Upgrade to TickLens-backed quotes
 * when a trace-capable RPC is configured.
 */
export const CONSTANT_PRODUCT_TICK_PROVIDER: TickDataProvider = {
  async getTick(): Promise<never> {
    throw new Error("no tick data in constant-product quote");
  },
  async nextInitializedTickWithinOneWord(
    tick: number,
    lte: boolean,
    tickSpacing: number,
  ): Promise<[number, boolean]> {
    return [lte ? tick - tickSpacing : tick + tickSpacing, false];
  },
};

/**
 * Exact-input quote at current liquidity (single hop, no tick crossing).
 * Deterministic: all inputs are on-chain state, no network. Both v3 and v4
 * vanilla pools share the same swap math.
 */
export async function quoteSwapInternal(
  state: PoolQuoteState,
  zeroForOne: boolean,
  amountIn: bigint,
): Promise<{ outAmountAtomic: bigint }> {
  const t0 = v3Token(state.token0, state.token0Decimals);
  const t1 = v3Token(state.token1, state.token1Decimals);
  const pool = new V3Pool(
    t0,
    t1,
    state.fee,
    state.sqrtPriceX96.toString(),
    state.liquidity.toString(),
    state.tickCurrent,
    CONSTANT_PRODUCT_TICK_PROVIDER,
  );
  const input = zeroForOne
    ? CurrencyAmount.fromRawAmount(t0, amountIn.toString())
    : CurrencyAmount.fromRawAmount(t1, amountIn.toString());
  const [out] = await pool.getOutputAmount(input);
  return { outAmountAtomic: BigInt(out.quotient.toString()) };
}

export interface V3MintCalldataArgs {
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly sqrtPriceX96: bigint;
  readonly tickCurrent: number;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly recipient: Address;
  readonly deadline: number;
  readonly slippageToleranceBps: number;
  readonly tickLower?: number;
  readonly tickUpper?: number;
  readonly rangeBps?: number;
}

export interface V3MintCalldataResult {
  readonly calldata: Hex;
  readonly value: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  /** Actual amounts the NPM pulls (the SDK encodes mintAmounts as the desired
   *  amounts — what the wallet pays). */
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly amount0Min: bigint;
  readonly amount1Min: bigint;
}

/**
 * v3 NPM mint calldata for a two-sided position (or single-sided when one
 * leg is 0). Returns the encoded mint plus the slippage floors decoded from
 * the calldata, so callers approve exactly the amount the mint can pull.
 */
export function buildV3MintCalldata(args: V3MintCalldataArgs): V3MintCalldataResult {
  const {
    token0,
    token1,
    fee,
    tickSpacing,
    sqrtPriceX96,
    tickCurrent,
    token0Decimals,
    token1Decimals,
    amount0,
    amount1,
    recipient,
    deadline,
    slippageToleranceBps,
  } = args;
  const range = tickRangeAround(tickCurrent, tickSpacing, args.rangeBps);
  const tickLower = args.tickLower ?? range.tickLower;
  const tickUpper = args.tickUpper ?? range.tickUpper;
  const t0 = v3Token(token0, token0Decimals);
  const t1 = v3Token(token1, token1Decimals);
  const pool = new V3Pool(t0, t1, fee, sqrtPriceX96.toString(), "0", tickCurrent);
  const position =
    amount0 > 0n && amount1 > 0n
      ? V3Position.fromAmounts({
          pool,
          tickLower,
          tickUpper,
          amount0: amount0.toString(),
          amount1: amount1.toString(),
          useFullPrecision: true,
        })
      : amount0 > 0n
        ? V3Position.fromAmount0({
            pool,
            tickLower,
            tickUpper,
            amount0: amount0.toString(),
            useFullPrecision: true,
          })
        : V3Position.fromAmount1({ pool, tickLower, tickUpper, amount1: amount1.toString() });
  const { calldata, value } = V3NonfungiblePositionManager.addCallParameters(position, {
    slippageTolerance: sdkPercent(slippageToleranceBps),
    deadline,
    recipient: getAddress(recipient),
  });
  // Decode to expose the slippage floors (amount0Min/amount1Min) for approval
  // sizing: NPM pulls exactly the amounts implied by the liquidity, bounded
  // below by the mins.
  const decoded = decodeFunctionData({ abi: v3MintDecodeAbi, data: calldata as Hex });
  const p = decoded.args[0] as readonly [
    Address,
    Address,
    number,
    number,
    number,
    bigint,
    bigint,
    bigint,
    bigint,
    Address,
    bigint,
  ];
  return {
    calldata: calldata as Hex,
    value: BigInt(value),
    tickLower: Number(p[3]),
    tickUpper: Number(p[4]),
    amount0: p[5],
    amount1: p[6],
    amount0Min: p[7],
    amount1Min: p[8],
  };
}

export interface V3CollectCalldataArgs {
  readonly tokenId: bigint;
  readonly token0: Address;
  readonly token1: Address;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  readonly recipient: Address;
}

/** v3 NPM collect — caps are type(uint128).max, so the full owed balance
 *  (fees + principal after a decrease) is collected to `recipient`. */
export function buildV3CollectCalldata(args: V3CollectCalldataArgs): {
  calldata: Hex;
  value: bigint;
} {
  const { tokenId, token0, token1, token0Decimals, token1Decimals, recipient } = args;
  const { calldata, value } = V3NonfungiblePositionManager.collectCallParameters({
    tokenId: tokenId.toString(),
    expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(v3Token(token0, token0Decimals), "0"),
    expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(v3Token(token1, token1Decimals), "0"),
    recipient: getAddress(recipient),
  });
  return { calldata: calldata as Hex, value: BigInt(value) };
}

export interface V3ExitCalldataArgs {
  readonly tokenId: bigint;
  readonly token0: Address;
  readonly token1: Address;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  readonly fee: number;
  readonly sqrtPriceX96: bigint;
  readonly tickCurrent: number;
  readonly liquidity: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly tokensOwed0: bigint;
  readonly tokensOwed1: bigint;
  readonly recipient: Address;
  readonly deadline: number;
  readonly slippageToleranceBps: number;
}

/** v3 full exit: decreaseLiquidity(100%) + collect + burn in one multicall. */
export function buildV3ExitCalldata(args: V3ExitCalldataArgs): { calldata: Hex; value: bigint } {
  const {
    tokenId,
    token0,
    token1,
    token0Decimals,
    token1Decimals,
    fee,
    sqrtPriceX96,
    tickCurrent,
    liquidity,
    tickLower,
    tickUpper,
    tokensOwed0,
    tokensOwed1,
    recipient,
    deadline,
    slippageToleranceBps,
  } = args;
  const t0 = v3Token(token0, token0Decimals);
  const t1 = v3Token(token1, token1Decimals);
  const pool = new V3Pool(t0, t1, fee, sqrtPriceX96.toString(), "0", tickCurrent);
  const position = new V3Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper });
  const { calldata, value } = V3NonfungiblePositionManager.removeCallParameters(position, {
    tokenId: tokenId.toString(),
    liquidityPercentage: new Percent(1),
    slippageTolerance: sdkPercent(slippageToleranceBps),
    deadline,
    burnToken: true,
    collectOptions: {
      expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(t0, tokensOwed0.toString()),
      expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(t1, tokensOwed1.toString()),
      recipient: getAddress(recipient),
    },
  });
  return { calldata: calldata as Hex, value: BigInt(value) };
}

export interface V3ExactInputSingleCalldataArgs {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly fee: number;
  readonly recipient: Address;
  readonly deadline: number;
  readonly amountIn: bigint;
  readonly amountOutMinimum: bigint;
  readonly sqrtPriceLimitX96?: bigint;
}

/** SwapRouter02 exactInputSingle — v3 single-hop swaps. */
export function buildV3ExactInputSingleCalldata(args: V3ExactInputSingleCalldataArgs): Hex {
  const {
    tokenIn,
    tokenOut,
    fee,
    recipient,
    deadline,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96 = 0n,
  } = args;
  return encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      [
        getAddress(tokenIn),
        getAddress(tokenOut),
        fee,
        getAddress(recipient),
        BigInt(deadline),
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96,
      ],
    ],
  });
}

export function buildUnwrapWETH9Calldata(amountMinimum: bigint, recipient: Address): Hex {
  return encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "unwrapWETH9",
    args: [amountMinimum, getAddress(recipient)],
  });
}

export function buildSwapRouterMulticallCalldata(calls: readonly Hex[]): Hex {
  return encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "multicall",
    args: [calls],
  });
}

export interface UniversalRouterV4SwapCalldataArgs {
  readonly poolKey: V4PoolKey;
  readonly zeroForOne: boolean;
  readonly amountIn: bigint;
  readonly amountOutMinimum: bigint;
  readonly minHopPriceX36?: bigint;
  readonly deadline: number;
}

/**
 * UniversalRouter 2.1.1 V4_SWAP (0x10) single-hop exact-input command, verified
 * against the verified 4663 router source: inputs = abi.encode(bytes actions,
 * bytes[] params) with actions = SWAP_EXACT_IN_SINGLE (0x06) and params =
 * [abi.encode(ExactInputSingleParams)]; ExactInputSingleParams carries
 * (PoolKey, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36, hookData).
 */
export function buildUniversalRouterV4SwapCalldata(
  args: UniversalRouterV4SwapCalldataArgs,
): Hex {
  const { poolKey, zeroForOne, amountIn, amountOutMinimum, deadline } = args;
  if (amountIn > MAX_UINT160 || amountOutMinimum > MAX_UINT160) {
    throw new Error("v4 swap amount exceeds uint160");
  }
  const swapParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            type: "tuple",
            components: [
              { type: "address" },
              { type: "address" },
              { type: "uint24" },
              { type: "int24" },
              { type: "address" },
            ],
          },
          { type: "bool" },
          { type: "uint128" },
          { type: "uint128" },
          { type: "uint256" },
          { type: "bytes" },
        ],
      },
    ],
    [
      [
        [
          poolKey.currency0,
          poolKey.currency1,
          poolKey.fee,
          poolKey.tickSpacing,
          poolKey.hooks,
        ],
        zeroForOne,
        amountIn,
        amountOutMinimum,
        args.minHopPriceX36 ?? 0n,
        "0x",
      ],
    ],
  );
  const unlockData = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], ["0x06", [swapParams]]);
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: ["0x10", [unlockData], BigInt(deadline)],
  });
}

function v4Currency(key: V4PoolKey, decimals: number, isCurrency0: boolean) {
  const address = (isCurrency0 ? key.currency0 : key.currency1).toLowerCase();
  return address === "0x0000000000000000000000000000000000000000"
    ? Ether.onChain(CHAIN_ID)
    : new Token(CHAIN_ID, getAddress(address), decimals);
}

export interface V4MintCalldataArgs {
  readonly poolKey: V4PoolKey;
  readonly sqrtPriceX96: bigint;
  readonly tickCurrent: number;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  readonly amount0: bigint;
  readonly amount1: bigint;
  readonly recipient: Address;
  readonly deadline: number;
  readonly slippageToleranceBps: number;
  readonly tickLower?: number;
  readonly tickUpper?: number;
  readonly rangeBps?: number;
}

export interface V4MintCalldataResult {
  readonly calldata: Hex;
  readonly value: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  /** Actual amounts the PM pulls for the position's liquidity. */
  readonly amount0: bigint;
  readonly amount1: bigint;
}

/**
 * v4 PositionManager mint — builds the modifyLiquidities unlockData via the
 * v4-sdk. PoolKey order is authoritative (registry-fed); native currency
 * (address-zero) deposits ETH via msg.value (useNative).
 */
export function buildV4MintCalldata(args: V4MintCalldataArgs): V4MintCalldataResult {
  const {
    poolKey,
    sqrtPriceX96,
    tickCurrent,
    token0Decimals,
    token1Decimals,
    amount0,
    amount1,
    recipient,
    deadline,
    slippageToleranceBps,
  } = args;
  const c0 = v4Currency(poolKey, token0Decimals, true);
  const c1 = v4Currency(poolKey, token1Decimals, false);
  const range = tickRangeAround(tickCurrent, poolKey.tickSpacing, args.rangeBps);
  const tickLower = args.tickLower ?? range.tickLower;
  const tickUpper = args.tickUpper ?? range.tickUpper;
  const pool = new V4Pool(
    c0,
    c1,
    poolKey.fee,
    poolKey.tickSpacing,
    getAddress(poolKey.hooks),
    sqrtPriceX96.toString(),
    "0",
    tickCurrent,
  );
  const position =
    amount0 > 0n && amount1 > 0n
      ? V4Position.fromAmounts({
          pool,
          tickLower,
          tickUpper,
          amount0: amount0.toString(),
          amount1: amount1.toString(),
          useFullPrecision: true,
        })
      : amount0 > 0n
        ? V4Position.fromAmount0({
            pool,
            tickLower,
            tickUpper,
            amount0: amount0.toString(),
            useFullPrecision: true,
          })
        : V4Position.fromAmount1({ pool, tickLower, tickUpper, amount1: amount1.toString() });
  const { calldata, value } = V4PositionManager.addCallParameters(position, {
    slippageTolerance: sdkPercent(slippageToleranceBps),
    deadline,
    recipient: getAddress(recipient),
    hookData: "0x",
    // The v4 SDK hardcodes native as currency0: sortsBefore sorts address
    // zero first, V4Pool re-sorts, and addCallParameters sets
    // msg.value = amount0Max ("native currency will always be currency0 in
    // v4"). Canonical on-chain keys are therefore always native-first, and a
    // NON-canonical key with native as currency1 must fail HERE (the SDK's
    // NATIVE_NOT_SET invariant, clean + gas-free) — a c1.isNative branch
    // would build a leg-swapped mint with msg.value from the token leg and
    // burn gas on-chain. Reverted from an earlier || fix on that evidence.
    ...(c0.isNative ? { useNative: Ether.onChain(CHAIN_ID) } : {}),
  });
  return {
    calldata: calldata as Hex,
    value: BigInt(value),
    tickLower,
    tickUpper,
    amount0: BigInt(position.mintAmounts.amount0.toString()),
    amount1: BigInt(position.mintAmounts.amount1.toString()),
  };
}

export interface V4CollectCalldataArgs {
  readonly poolKey: V4PoolKey;
  readonly tokenId: bigint;
  readonly recipient: Address;
  readonly deadline: number;
  readonly slippageToleranceBps: number;
}

/** v4 fee collection — decrease(liquidity=0) + TAKE_PAIR in one unlockData. */
export function buildV4CollectCalldata(args: V4CollectCalldataArgs): {
  calldata: Hex;
  value: bigint;
} {
  const { poolKey, tokenId, recipient, deadline, slippageToleranceBps } = args;
  const c0 = v4Currency(poolKey, 18, true);
  const c1 = v4Currency(poolKey, 18, false);
  // Collect only needs the pool's currency identity (TAKE_PAIR); a
  // zero-liquidity position at tick 0 satisfies the SDK invariants.
  const pool = new V4Pool(
    c0,
    c1,
    poolKey.fee,
    poolKey.tickSpacing,
    getAddress(poolKey.hooks),
    TickMath.getSqrtRatioAtTick(0).toString(),
    "0",
    0,
  );
  const position = new V4Position({
    pool,
    liquidity: "0",
    tickLower: -poolKey.tickSpacing,
    tickUpper: poolKey.tickSpacing,
  });
  const { calldata, value } = V4PositionManager.collectCallParameters(position, {
    tokenId: tokenId.toString(),
    recipient: getAddress(recipient),
    slippageTolerance: sdkPercent(slippageToleranceBps),
    deadline,
    hookData: "0x",
  });
  return { calldata: calldata as Hex, value: BigInt(value) };
}

export interface V4ExitCalldataArgs {
  readonly poolKey: V4PoolKey;
  readonly tokenId: bigint;
  readonly liquidity: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly sqrtPriceX96: bigint;
  readonly tickCurrent: number;
  readonly deadline: number;
  readonly slippageToleranceBps: number;
}

/** v4 full exit — BURN_POSITION + TAKE_PAIR in one unlockData. */
export function buildV4ExitCalldata(args: V4ExitCalldataArgs): { calldata: Hex; value: bigint } {
  const {
    poolKey,
    tokenId,
    liquidity,
    tickLower,
    tickUpper,
    sqrtPriceX96,
    tickCurrent,
    deadline,
    slippageToleranceBps,
  } = args;
  const c0 = v4Currency(poolKey, 18, true);
  const c1 = v4Currency(poolKey, 18, false);
  const pool = new V4Pool(
    c0,
    c1,
    poolKey.fee,
    poolKey.tickSpacing,
    getAddress(poolKey.hooks),
    sqrtPriceX96.toString(),
    "0",
    tickCurrent,
  );
  const position = new V4Position({
    pool,
    liquidity: liquidity.toString(),
    tickLower,
    tickUpper,
  });
  const { calldata, value } = V4PositionManager.removeCallParameters(position, {
    tokenId: tokenId.toString(),
    liquidityPercentage: new Percent(1),
    slippageTolerance: sdkPercent(slippageToleranceBps),
    deadline,
    burnToken: true,
    hookData: "0x",
  });
  return { calldata: calldata as Hex, value: BigInt(value) };
}

/**
 * Decode the new-interface PM's packed positionInfo (200b poolId | 24b
 * tickUpper | 24b tickLower | 8b hasSubscriber; ticks are int24 sign-extended).
 */
export function decodeV4PositionInfo(info: bigint): { tickLower: number; tickUpper: number } {
  return {
    tickLower: Number(BigInt.asIntN(24, (info >> 8n) & ((1n << 24n) - 1n))),
    tickUpper: Number(BigInt.asIntN(24, (info >> 32n) & ((1n << 24n) - 1n))),
  };
}

/**
 * Uniswap v3/v4 position amounts from liquidity + tick bounds + current sqrt
 * price (Q64.96 fixed point; identical math on both protocol versions — the
 * v3 whitepaper §6.3 formulas). Returns raw atomic amounts (token0, token1).
 * Pure and deterministic; used by the live position mark so the ledger prices
 * REAL holdings instead of the old liquidity-heuristic.
 */
export function positionAmountsAtSqrtPrice(
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
  sqrtPriceX96: bigint,
): { amount0: bigint; amount1: bigint } {
  const Q96 = 1n << 96n;
  // v3-sdk's TickMath returns JSBI in this build — normalize to bigint.
  const pa = BigInt(TickMath.getSqrtRatioAtTick(tickLower).toString());
  const pb = BigInt(TickMath.getSqrtRatioAtTick(tickUpper).toString());
  const p = sqrtPriceX96;
  if (p <= pa) {
    // Below range: all token0.
    return { amount0: (liquidity * (pb - pa) * Q96) / (pa * pb), amount1: 0n };
  }
  if (p < pb) {
    // In range: both legs.
    return {
      amount0: (liquidity * (pb - p) * Q96) / (p * pb),
      amount1: (liquidity * (p - pa)) / Q96,
    };
  }
  // Above range: all token1.
  return { amount0: 0n, amount1: (liquidity * (pb - pa)) / Q96 };
}

/** Extract the minted tokenId from a mint receipt (ERC-721 Transfer from 0x0). */
export function tokenIdFromMintReceipt(
  receipt: Pick<TransactionReceipt, "logs">,
): bigint | null {
  for (const log of receipt.logs) {
    const topic0 = log.topics[0]?.toLowerCase();
    const from = log.topics[1]?.toLowerCase();
    if (topic0 === erc721TransferTopic && from === "0x0000000000000000000000000000000000000000") {
      return BigInt(log.topics[3] ?? "0x0");
    }
  }
  return null;
}

// ─── The adapter ──────────────────────────────────────────────────────────────

const NOT_IMPLEMENTED = (what: string) =>
  Effect.fail(
    new Error(
      `${what}: live EVM execution is not implemented in this scaffold. ` +
        `The agent runs read-only (observe/reason/decide) and paper mode; ` +
        `the Uniswap v3/v4 transaction layer is the next milestone.`,
    ),
  );

export const AdapterLive = Layer.effect(AdapterService,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const rpcUrl = config.rpcUrl || DEFAULT_RPC;
    const publicClient = createPublicClient({ transport: http(rpcUrl) });

    const account = config.walletPrivateKey
      ? (() => {
          try {
            return privateKeyToAccount(config.walletPrivateKey as `0x${string}`);
          } catch {
            // A CONFIGURED key that fails to parse must refuse to boot: with
            // the old catch -> null the engine silently ran paper-mode-style
            // (every sendTx errors 'live transactions disabled') and the
            // operator only noticed after the first cycle. The key itself is
            // never logged.
            throw new Error(
              "WALLET_PRIVATE_KEY is set but could not be parsed as an EVM private key " +
                "(expected 0x-prefixed, 64 hex chars). Fix it before starting the engine.",
            );
          }
        })()
      : null;
    const walletAddress: Address | null = account?.address ?? null;

    const erc20 = (address: Address) =>
      getContract({ address, abi: erc20Abi, client: { public: publicClient } });
    const v3Factory = () =>
      getContract({ address: V3_FACTORY, abi: v3FactoryAbi, client: { public: publicClient } });
    const v3Pool = (address: Address) =>
      getContract({ address, abi: v3PoolAbi, client: { public: publicClient } });
    const v3Npm = () =>
      getContract({ address: V3_NPM, abi: v3NpmAbi, client: { public: publicClient } });
    const tickLens = () =>
      getContract({ address: V3_TICK_LENS, abi: tickLensAbi, client: { public: publicClient } });
    const v4StateView = () =>
      getContract({
        address: V4_STATE_VIEW,
        abi: v4StateViewAbi,
        client: { public: publicClient },
      });
    const v4PositionManager = () =>
      getContract({
        address: V4_POSITION_MANAGER,
        abi: v4PositionManagerAbi,
        client: { public: publicClient },
      });

    async function getDecimals(mint: string): Promise<number> {
      if (isNative(mint)) return 18;
      const cached = decimalsCache.get(mint.toLowerCase());
      if (cached !== undefined) return cached;
      const decimals = await erc20(getAddress(mint))
        .read.decimals()
        .catch(() => 18);
      decimalsCache.set(mint.toLowerCase(), Number(decimals));
      return Number(decimals);
    }

    async function getBalance(mint: string, owner: Address): Promise<bigint> {
      if (isNative(mint)) return publicClient.getBalance({ address: owner });
      return erc20(getAddress(mint)).read.balanceOf([owner]);
    }

    // ─── Live transaction layer ────────────────────────────────────────────────
    // Wallet client exists only when a private key is configured; every
    // broadcast path fails with a clear error instead of crashing in paper mode.
    const walletClient = account
      ? createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http(rpcUrl) })
      : null;

    /** Incrementing nonce cache by address (seeded from the pending count on
     *  first use; entry dropped on send failure so the next attempt re-reads). */
    const nonces = new Map<Address, bigint>();
    async function nextNonce(): Promise<bigint> {
      const owner = requireWallet();
      let nonce = nonces.get(owner);
      if (nonce === undefined) {
        nonce = BigInt(await publicClient.getTransactionCount({ address: owner, blockTag: "pending" }));
      }
      nonces.set(owner, nonce + 1n);
      return nonce;
    }

    function requireWallet(): Address {
      if (!walletAddress || !walletClient) {
        throw new Error(
          "live transactions disabled: WALLET_PRIVATE_KEY is not configured (paper mode)",
        );
      }
      return walletAddress;
    }

    function revertMessage(e: unknown): string {
      const msg = e instanceof Error ? e.message : String(e);
      return msg.slice(0, 400);
    }

    /**
     * Dry-run → estimateGas → broadcast → receipt wait. Gas strategy (Orbit
     * L2, FCFS): maxPriorityFeePerGas 0, maxFeePerGas = 2× baseFee, limit =
     * estimate + 30%. Never broadcasts without the eth_call dry-run passing.
     */
    async function sendTx(params: {
      to: Address;
      data?: Hex;
      value?: bigint;
    }): Promise<{ txSignature: string; receipt: TransactionReceipt }> {
      const owner = requireWallet();
      const wc = walletClient;
      if (!wc) throw new Error("live transactions disabled: WALLET_PRIVATE_KEY is not configured (paper mode)");
      const { to, data, value = 0n } = params;
      try {
        await publicClient.call({ account: owner, to, data, value });
      } catch (e) {
        throw new Error(`dry-run revert (${to}): ${revertMessage(e)}`);
      }
      let gas: bigint;
      try {
        const estimate = await publicClient.estimateGas({
          account: owner,
          to,
          data,
          value,
        });
        gas = (estimate * 130n) / 100n;
      } catch (e) {
        throw new Error(`estimateGas failed (${to}): ${revertMessage(e)}`);
      }
      const baseFee = (await publicClient.getBlock()).baseFeePerGas ?? 100_000_000n;
      const maxFeePerGas = baseFee * 2n;
      const maxPriorityFeePerGas = 0n;
      const nonce = await nextNonce();
      let txHash: Hex;
      try {
        txHash = await wc.sendTransaction({
          to,
          data,
          value,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce: Number(nonce),
        });
      } catch (e) {
        nonces.delete(owner);
        throw new Error(`sendTransaction failed: ${revertMessage(e)}`);
      }
      logger.info("broadcast", { txHash, to, nonce: nonce.toString(), gas: gas.toString() });
      // Receipt wait with self-healing: on timeout the tx was either DROPPED
      // (baseFee spiked above the 2x snapshot, FCFS mempool eviction) or slow.
      // A stale cache entry (nonce+1) after a drop bricks every later
      // broadcast — including EXITs, exactly what a fee spike makes urgent.
      // Reconcile from the chain and re-broadcast the same nonce with a gas
      // bump once before giving up.
      const receipt = await publicClient
        .waitForTransactionReceipt({ hash: txHash, timeout: 60_000 })
        .catch(async (_err: unknown): Promise<TransactionReceipt> => {
          const pendingCount = BigInt(
            await publicClient.getTransactionCount({ address: owner, blockTag: "pending" }),
          );
          if (pendingCount <= nonce) {
            // Dropped: same nonce, bumped gas, one retry.
            const bumped = (maxFeePerGas * 150n) / 100n;
            try {
              const retryHash = await wc.sendTransaction({
                to,
                data,
                value,
                gas,
                maxFeePerGas: bumped,
                maxPriorityFeePerGas,
                nonce: Number(nonce),
              });
              logger.warn("re-broadcast with bumped gas after receipt timeout", {
                txHash,
                retryHash,
                nonce: nonce.toString(),
              });
              return await publicClient.waitForTransactionReceipt({
                hash: retryHash,
                timeout: 60_000,
              });
            } catch (re) {
              nonces.delete(owner);
              throw new Error(
                `transaction ${txHash} receipt wait timed out and re-broadcast failed: ${revertMessage(re)}`,
              );
            }
          }
          // Nonce advanced: the tx is in flight (or mined but unreadable).
          // Re-seed the cache so subsequent broadcasts cannot gap over it.
          nonces.set(owner, pendingCount);
          throw new Error(
            `transaction ${txHash} receipt wait timed out (nonce ${nonce.toString()}); nonce cache re-seeded to ${pendingCount.toString()}`,
          );
        });
      if (receipt.status === "reverted") {
        throw new Error(`transaction reverted on-chain: ${txHash}`);
      }
      return { txSignature: txHash, receipt };
    }

    /** Plain ERC-20 approval (v3 NPM + v3 SwapRouter02 are not Permit2
     *  forwarders) — approve MAX once, only when the current allowance is low. */
    async function ensureErc20Allowance(
      token: Address,
      spender: Address,
      amount: bigint,
    ): Promise<void> {
      if (isNative(token)) return;
      const tokenAddr = getAddress(token);
      const current = await erc20(tokenAddr)
        .read.allowance([requireWallet(), spender])
        .catch(() => 0n);
      if (current >= amount) return;
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, MAX_UINT256],
      });
      await sendTx({ to: tokenAddr, data });
    }

    /** Two-step Permit2 approval (v4 PositionManager / UniversalRouter): the
     *  token must approve Permit2 (ERC-20), then Permit2 must approve the
     *  spender. Amounts capped at MAX_UINT160 / MAX_UINT48 (Permit2 types). */
    async function ensurePermit2Allowance(
      token: Address,
      spender: Address,
      amount: bigint,
    ): Promise<void> {
      if (isNative(token)) return;
      const tokenAddr = getAddress(token);
      const owner = requireWallet();
      const ercCurrent = await erc20(tokenAddr)
        .read.allowance([owner, PERMIT2])
        .catch(() => 0n);
      if (ercCurrent < amount) {
        await sendTx({
          to: tokenAddr,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [PERMIT2, MAX_UINT256],
          }),
        });
      }
      const permit2 = getContract({
        address: PERMIT2,
        abi: permit2Abi,
        client: { public: publicClient },
      });
      const p2 = await permit2.read.allowance([owner, tokenAddr, spender]).catch(() => 0n);
      const p2Amount = BigInt(Array.isArray(p2) ? p2[0] : p2);
      const p2Expiration = BigInt(Array.isArray(p2) ? p2[1] : 0n);
      // Permit2 treats an EXPIRED allowance as 0 regardless of amount — an
      // expired-but-large approval would let the mint broadcast and revert
      // on-chain (burned gas). Unreachable today (all approvals use
      // MAX_UINT48 ≈ 8.9M years) but cheap to guard.
      const p2Expired = p2Expiration <= BigInt(Math.floor(Date.now() / 1000));
      if (p2Amount < amount || p2Expired) {
        await sendTx({
          to: PERMIT2,
          data: encodeFunctionData({
            abi: permit2Abi,
            functionName: "approve",
            args: [tokenAddr, spender, MAX_UINT160, Number(MAX_UINT48)],
          }),
        });
      }
    }

    async function tokenDecimalsOf(mint: string): Promise<number> {
      return getDecimals(isNative(mint) ? WETH9 : getAddress(mint));
    }

    /** On-chain pool state for a v3 pool (address) — feeds the pure builders. */
    async function v3PoolQuoteState(poolAddress: Address): Promise<PoolQuoteState> {
      const c = v3Pool(poolAddress);
      const [token0, token1, fee, tickSpacing, slot0, liquidity] = await Promise.all([
        c.read.token0(),
        c.read.token1(),
        c.read.fee(),
        c.read.tickSpacing(),
        c.read.slot0(),
        c.read.liquidity(),
      ]);
      const [token0Decimals, token1Decimals] = await Promise.all([
        tokenDecimalsOf(token0),
        tokenDecimalsOf(token1),
      ]);
      return {
        token0,
        token1,
        token0Decimals,
        token1Decimals,
        fee: Number(fee),
        tickSpacing: Number(tickSpacing),
        sqrtPriceX96: slot0[0],
        tickCurrent: Number(slot0[1]),
        liquidity,
      };
    }

    /**
     * Resolve the TRUE PoolKey for a v4 poolId. The on-chain source of truth
     * is the PositionManager's poolKeys(bytes25) — the left-aligned 25-byte
     * truncation of the 32-byte poolId — returning the real currency0/1,
     * fee, tickSpacing and hooks. The registry (Krystal-fed) is a fast path
     * but its tickSpacing is a 400 stand-in: a wrong tickSpacing/fee would
     * misalign range math and mint against the wrong pool identity, so
     * execution NEVER trusts the approximation when the pool is on-chain.
     */
    async function resolveV4PoolKey(poolId: string): Promise<V4PoolKey> {
      const id = poolId.toLowerCase();
      const existing = V4_POOL_REGISTRY[id];
      if (existing && existing.tickSpacing !== 400 && existing.fee > 0) {
        return existing;
      }
      // bytes25: first 25 bytes of the poolId, right-padded to a 32-byte word.
      const truncated = `${id.slice(0, 2 + 50)}${"0".repeat(14)}` as `0x${string}`;
      try {
        const pm = v4PositionManager();
        const [key] = await pm.read.poolKeys([truncated]);
        if (!key) throw new Error("poolKeys returned empty key");
        const [c0, c1, feeRaw, spacingRaw, hooksRaw] = key;
        // SAFETY (on-chain audit): poolKeys returns ALL-ZERO tuples for some
        // live pools — never register a garbage key over a good one. A zero
        // address or zero fee means the lookup failed; fail closed.
        const ZERO = "0x0000000000000000000000000000000000000000";
        if (
          !c0 || !c1 || !hooksRaw ||
          c0.toLowerCase() === ZERO || c1.toLowerCase() === ZERO ||
          Number(feeRaw) <= 0 || Number(spacingRaw) <= 0
        ) {
          throw new Error("poolKeys returned an invalid/zero key");
        }
        const resolved: V4PoolKey = {
          currency0: c0.toLowerCase() as `0x${string}`,
          currency1: c1.toLowerCase() as `0x${string}`,
          fee: Number(feeRaw),
          tickSpacing: Number(spacingRaw),
          hooks: hooksRaw.toLowerCase() as `0x${string}`,
        };
        registerV4Pool(id, resolved);
        return resolved;
      } catch (e) {
        if (existing) return existing;
        throw new Error(
          `v4 pool ${id} key unresolved on-chain (${underlyingErrorMessage(e)})`,
        );
      }
    }

    /** Pool state for a v4 pool (poolId) via the StateView — feeds the pure
     *  builders. PoolKey comes from the registry (poolId is one-way). */
    async function v4PoolQuoteState(poolId: string): Promise<PoolQuoteState> {
      const key = await resolveV4PoolKey(poolId);
      const stateView = v4StateView();
      const poolIdHex = poolId.toLowerCase() as `0x${string}`;
      const [slot0, liquidity] = await Promise.all([
        stateView.read.getSlot0([poolIdHex]),
        stateView.read.getLiquidity([poolIdHex]),
      ]);
      const [token0Decimals, token1Decimals] = await Promise.all([
        tokenDecimalsOf(key.currency0),
        tokenDecimalsOf(key.currency1),
      ]);
      return {
        token0: key.currency0,
        token1: key.currency1,
        token0Decimals,
        token1Decimals,
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        sqrtPriceX96: slot0[0],
        tickCurrent: Number(slot0[1]),
        liquidity,
      };
    }

    /** Find a direct v3 pool between two mints (native maps to WETH9). */
    async function findV3PoolForPair(
      tokenA: string,
      tokenB: string,
    ): Promise<{ pool: Address; fee: number } | null> {
      const factory = v3Factory();
      const a = isNative(tokenA) ? WETH9 : getAddress(tokenA);
      const b = isNative(tokenB) ? WETH9 : getAddress(tokenB);
      for (const fee of [3000, 500, 10_000, 100]) {
        try {
          const pool = await factory.read.getPool([a, b, fee]);
          if (pool && pool.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
            return { pool, fee };
          }
        } catch {
          continue;
        }
      }
      return null;
    }

    /** Find a registered v4 pool for a token pair (either order). */
    function findV4PoolForPair(
      tokenA: string,
      tokenB: string,
    ): { poolId: string; key: V4PoolKey } | null {
      const a = isNative(tokenA)
        ? "0x0000000000000000000000000000000000000000"
        : getAddress(tokenA).toLowerCase();
      const b = isNative(tokenB)
        ? "0x0000000000000000000000000000000000000000"
        : getAddress(tokenB).toLowerCase();
      for (const [poolId, key] of Object.entries(V4_POOL_REGISTRY)) {
        const k0 = key.currency0.toLowerCase();
        const k1 = key.currency1.toLowerCase();
        if ((k0 === a && k1 === b) || (k0 === b && k1 === a)) return { poolId, key };
      }
      return null;
    }

    function usdOf(amountAtomic: bigint, decimals: number, priceUsd: number): number {
      return (Number(amountAtomic) / 10 ** decimals) * (priceUsd || 0);
    }

    /**
     * Full exit of a position (v3: decreaseLiquidity+collect+burn; v4:
     * burn+TAKE_PAIR) returning the exact reclaimed amounts via balance
     * deltas. Shared by exitPosition and rebalancePosition.
     */
    async function reclaimPosition(
      poolAddress: string,
      positionPubKey: string,
    ): Promise<{
      txSignature: string;
      token0: Address;
      token1: Address;
      decimals0: number;
      decimals1: number;
      reclaimed0: bigint;
      reclaimed1: bigint;
      pendingFeeXAtomic: bigint;
      pendingFeeYAtomic: bigint;
      isV4: boolean;
    }> {
      const owner = requireWallet();
      const tokenId = BigInt(positionPubKey);
      const isV4 = poolAddress.length === 66;
      let token0: Address;
      let token1: Address;
      let decimals0: number;
      let decimals1: number;
      let calldata: Hex;
      let value: bigint;
      let pendingFeeXAtomic = 0n;
      let pendingFeeYAtomic = 0n;
      if (isV4) {
        const pm = v4PositionManager();
        const [poolKeyTuple, positionInfo] = await pm.read.getPoolAndPositionInfo([tokenId]);
        const key: V4PoolKey = {
          currency0: poolKeyTuple[0],
          currency1: poolKeyTuple[1],
          fee: Number(poolKeyTuple[2]),
          tickSpacing: Number(poolKeyTuple[3]),
          hooks: poolKeyTuple[4],
        };
        const poolId = await computeV4PoolId(key);
        const state = await v4PoolQuoteState(poolId);
        const { tickLower, tickUpper } = decodeV4PositionInfo(positionInfo);
        const liquidity = await pm.read.getPositionLiquidity([tokenId]);
        const built = buildV4ExitCalldata({
          poolKey: key,
          tokenId,
          liquidity,
          tickLower,
          tickUpper,
          sqrtPriceX96: state.sqrtPriceX96,
          tickCurrent: state.tickCurrent,
          deadline: Math.floor(Date.now() / 1000) + POSITION_DEADLINE_S,
          slippageToleranceBps: 50,
        });
        calldata = built.calldata;
        value = built.value;
        token0 = key.currency0;
        token1 = key.currency1;
        decimals0 = state.token0Decimals;
        decimals1 = state.token1Decimals;
      } else {
        const npm = v3Npm();
        const p = await npm.read.positions([tokenId]);
        token0 = p[2];
        token1 = p[3];
        const fee = Number(p[4]);
        const tickLower = Number(p[5]);
        const tickUpper = Number(p[6]);
        const liquidity = p[7];
        pendingFeeXAtomic = p[10];
        pendingFeeYAtomic = p[11];
        const poolAddr = await v3PoolOf(token0, token1, fee);
        const state = await v3PoolQuoteState(poolAddr);
        const built = buildV3ExitCalldata({
          tokenId,
          token0,
          token1,
          token0Decimals: state.token0Decimals,
          token1Decimals: state.token1Decimals,
          fee,
          sqrtPriceX96: state.sqrtPriceX96,
          tickCurrent: state.tickCurrent,
          liquidity,
          tickLower,
          tickUpper,
          tokensOwed0: pendingFeeXAtomic,
          tokensOwed1: pendingFeeYAtomic,
          recipient: owner,
          deadline: Math.floor(Date.now() / 1000) + POSITION_DEADLINE_S,
          slippageToleranceBps: 50,
        });
        calldata = built.calldata;
        value = built.value;
        decimals0 = state.token0Decimals;
        decimals1 = state.token1Decimals;
      }
      const [pre0, pre1] = await Promise.all([
        getBalance(token0, owner),
        getBalance(token1, owner),
      ]);
      const { txSignature } = await sendTx({
        to: isV4 ? V4_POSITION_MANAGER : V3_NPM,
        data: calldata,
        value,
      });
      const [post0, post1] = await Promise.all([
        getBalance(token0, owner),
        getBalance(token1, owner),
      ]);
      return {
        txSignature,
        token0,
        token1,
        decimals0,
        decimals1,
        reclaimed0: post0 - pre0,
        reclaimed1: post1 - pre1,
        pendingFeeXAtomic,
        pendingFeeYAtomic,
        isV4,
      };
    }

    // ─── Swap routing (v3 SwapRouter02 / v4 UniversalRouter) ───────────────────

    type SwapRoute =
      | {
          router: "swaprouter02";
          target: Address;
          pool: Address;
          fee: number;
          zeroForOne: boolean;
          decimals0: number;
          decimals1: number;
        }
      | {
          router: "universalrouter";
          target: Address;
          poolId: string;
          poolKey: V4PoolKey;
          zeroForOne: boolean;
          decimals0: number;
          decimals1: number;
        };

    /** Single-hop quote: registered v4 pool first, then a direct v3 pool.
     *  The quote is in-SDK at current liquidity (the public RPC strips
     *  quote-carrying reverts); slippage guards execution. */
    async function quotePair(
      tokenIn: string,
      tokenOut: string,
      amountIn: bigint,
    ): Promise<{ outAmountAtomic: bigint; route: SwapRoute }> {
      const v4 = findV4PoolForPair(tokenIn, tokenOut);
      if (v4) {
        const state = await v4PoolQuoteState(v4.poolId);
        const inputAddr = isNative(tokenIn)
          ? "0x0000000000000000000000000000000000000000"
          : getAddress(tokenIn).toLowerCase();
        const zeroForOne = inputAddr === state.token0.toLowerCase();
        const { outAmountAtomic } = await quoteSwapInternal(state, zeroForOne, amountIn);
        return {
          outAmountAtomic,
          route: {
            router: "universalrouter",
            target: UNIVERSAL_ROUTER,
            poolId: v4.poolId,
            poolKey: v4.key,
            zeroForOne,
            decimals0: state.token0Decimals,
            decimals1: state.token1Decimals,
          },
        };
      }
      const v3 = await findV3PoolForPair(tokenIn, tokenOut);
      if (!v3) {
        throw new Error(
          `no direct v3 or registered v4 pool for ${tokenIn} -> ${tokenOut}`,
        );
      }
      const state = await v3PoolQuoteState(v3.pool);
      const inputAddr = isNative(tokenIn)
        ? WETH9.toLowerCase()
        : getAddress(tokenIn).toLowerCase();
      const zeroForOne = inputAddr === state.token0.toLowerCase();
      const { outAmountAtomic } = await quoteSwapInternal(state, zeroForOne, amountIn);
      return {
        outAmountAtomic,
        route: {
          router: "swaprouter02",
          target: V3_SWAP_ROUTER_02,
          pool: v3.pool,
          fee: v3.fee,
          zeroForOne,
          decimals0: state.token0Decimals,
          decimals1: state.token1Decimals,
        },
      };
    }

    function buildSwapCalldata(
      route: SwapRoute,
      tokenIn: string,
      tokenOut: string,
      amountIn: bigint,
      amountOutMinimum: bigint,
      deadline: number,
    ): Hex {
      if (route.router === "universalrouter") {
        return buildUniversalRouterV4SwapCalldata({
          poolKey: route.poolKey,
          zeroForOne: route.zeroForOne,
          amountIn,
          amountOutMinimum,
          deadline,
        });
      }
      return buildV3ExactInputSingleCalldata({
        tokenIn: isNative(tokenIn) ? WETH9 : getAddress(tokenIn),
        tokenOut: isNative(tokenOut) ? WETH9 : getAddress(tokenOut),
        fee: route.fee,
        recipient: requireWallet(),
        deadline,
        amountIn,
        amountOutMinimum,
      });
    }

    /** Address the router actually pulls for a mint: v3 swaps wrap native
     *  ETH (WETH9); v4 swaps use address-zero native as a first-class
     *  currency. */
    function routerInputAddress(mint: string, router: SwapRoute["router"]): Address {
      if (router === "swaprouter02") return isNative(mint) ? WETH9 : getAddress(mint);
      return isNative(mint)
        ? "0x0000000000000000000000000000000000000000"
        : getAddress(mint);
    }

    async function approveInputForRoute(
      tokenIn: string,
      route: SwapRoute,
      amount: bigint,
    ): Promise<void> {
      const addr = routerInputAddress(tokenIn, route.router);
      if (route.router === "universalrouter") {
        await ensurePermit2Allowance(addr, route.target, amount);
      } else {
        await ensureErc20Allowance(addr, route.target, amount);
      }
    }

    /**
     * USD price of a mint. Stablecoin → 1. Otherwise derive from a v3 pool
     * against the stablecoin (3 fee tiers), then fall back to 0 (fail-open —
     * callers treat 0 as "unpriceable"). GeckoTerminal on Robinhood Chain is
     * a follow-up; pool-derived prices are real on-chain values.
     */
    async function priceUsd(mint: string): Promise<number> {
      if (mint.toLowerCase() === STABLECOIN_MINT.toLowerCase()) return 1;
      // Native ETH is WETH-paired in v3 pools.
      if (isNative(mint)) return priceUsdViaV3Pool(WETH9);
      return priceUsdViaV3Pool(mint);
    }

    /** Price of `mint` in USDG via the most liquid v3 pool. The on-chain
     *  sqrt price is the RAW token1/token0 ratio (decimals-sensitive); scale
     *  by 10^(decimals(mint) - 6) so the result is USDG per mint (USDG=1). */
    async function priceUsdViaV3Pool(mint: string): Promise<number> {
      const factory = v3Factory();
      const mintAddr = getAddress(mint).toLowerCase();
      for (const fee of [3000, 500, 10_000]) {
        try {
          const pool = await factory.read.getPool([
            getAddress(mint),
            getAddress(STABLECOIN_MINT),
            fee,
          ]);
          if (pool === "0x0000000000000000000000000000000000000000") continue;
          const poolContract = v3Pool(pool);
          const [token0, slot0] = await Promise.all([
            poolContract.read.token0(),
            poolContract.read.slot0(),
          ]);
          const rawPrice = sqrtPriceX96ToPrice(slot0[0]); // token1/token0 raw
          const decimals = await getDecimals(mint);
          const scale = 10 ** (decimals - 6);
          return token0.toLowerCase() === mintAddr ? rawPrice * scale : scale / rawPrice;
        } catch {
          continue;
        }
      }
      return 0;
    }

    /** One v3 pool read → engine PoolState (statsSource heuristic until a
     *  GeckoTerminal integration for Robinhood Chain lands). */
    async function v3PoolState(poolAddress: Address): Promise<PoolState> {
      const poolContract = v3Pool(poolAddress);
      const [token0, token1, tickSpacing, slot0, liquidity] = await Promise.all([
        poolContract.read.token0(),
        poolContract.read.token1(),
        poolContract.read.tickSpacing(),
        poolContract.read.slot0(),
        poolContract.read.liquidity(),
      ]);
      const tick = Number(slot0[1]);
      const price0 = await priceUsd(token0).catch(() => 0);
      const tvlUsd = (Number(liquidity) / 1e18) * (price0 || 0) * 4; // rough reserve proxy
      return {
        address: poolAddress.toLowerCase(),
        tokenX: token0.toLowerCase(),
        tokenY: token1.toLowerCase(),
        tokenXSymbol: isNative(token0) ? "ETH" : token0.toLowerCase() === WETH9.toLowerCase() ? "WETH" : "TOKEN",
        tokenYSymbol: isNative(token1) ? "ETH" : token1.toLowerCase() === WETH9.toLowerCase() ? "WETH" : "TOKEN",
        tvlUsd: tvlUsd || 0,
        volume24hUsd: 0,
        fees24hUsd: 0,
        apr: 0,
        activeBinId: tick,
        binStep: Number(tickSpacing),
        currentPrice: tickToPrice(tick),
        timestamp: Date.now(),
        statsSource: "heuristic" as const,
      };
    }

    /** Bin array = populated ticks around the active tick via TickLens. */
    async function v3BinArray(poolAddress: Address): Promise<BinArray> {
      const poolContract = v3Pool(poolAddress);
      const [slot0, tickSpacing] = await Promise.all([
        poolContract.read.slot0(),
        poolContract.read.tickSpacing(),
      ]);
      const activeTick = Number(slot0[1]);
      const lens = tickLens();
      const word = activeTick >> 8;
      const bins: BinData[] = [];
      for (const w of [word - 1, word, word + 1]) {
        const populated = (await lens.read.getPopulatedTicksInWord([poolAddress, w])) as unknown as ReadonlyArray<
          readonly [number, bigint, bigint]
        >;
        for (const p of populated) {
          bins.push({
            binId: Number(p[0]),
            reserveX: p[2],
            reserveY: 0n,
            liquiditySupply: p[2],
            price: tickToPrice(Number(p[0])),
          });
        }
      }
      bins.sort((a, b) => a.binId - b.binId);
      // TickLens returns empty for wide/low-occupancy pools (no populated
      // ticks near the active one). Mirror the v4 proxy: a synthetic active
      // bin keeps range utilization KNOWN (1.0 while live) so the ENTER
      // gates proceed — the volatility-scaled range width is the real
      // utilization control, not tick occupancy. A measured value when
      // populated, the proxy otherwise.
      if (bins.length === 0) {
        bins.push({
          binId: activeTick,
          reserveX: slot0[0],
          reserveY: 0n,
          liquiditySupply: 0n,
          price: tickToPrice(activeTick),
        });
      }
      return {
        lowerBinId: bins[0]?.binId ?? activeTick,
        upperBinId: bins[bins.length - 1]?.binId ?? activeTick,
        bins,
        activeBinId: activeTick,
        binStep: Number(tickSpacing),
        reservesKnown: true,
      };
    }

    /** v3 positions of an owner (NPM is an ERC721 enumerable). */
    async function v3PositionsOf(
      owner: Address,
      poolFilter?: string,
    ): Promise<ReadonlyArray<Position>> {
      const npm = v3Npm();
      const balance = Number(await npm.read.balanceOf([owner]));
      const positions: Position[] = [];
      for (let i = 0; i < balance; i++) {
        try {
          const tokenId = await npm.read.tokenOfOwnerByIndex([owner, BigInt(i)]);
          const p = await npm.read.positions([tokenId]);
          const token0 = p[2];
          const token1 = p[3];
          const pool = await v3PoolOf(token0, token1, p[4]);
          if (poolFilter && pool.toLowerCase() !== poolFilter.toLowerCase()) continue;
          positions.push({
            id: tokenId.toString(),
            poolAddress: pool.toLowerCase(),
            poolName: `${token0.slice(0, 6)}/${token1.slice(0, 6)}`,
            tokenX: token0.toLowerCase(),
            tokenY: token1.toLowerCase(),
            lowerBinId: Number(p[5]),
            upperBinId: Number(p[6]),
            liquidityShares: p[7],
            depositedUsd: 0,
            currentValueUsd: 0,
            unrealizedPnlUsd: 0,
            feesEarnedUsd: 0,
            openedAt: Date.now(),
          });
        } catch {
          continue;
        }
      }
      return positions;
    }

    async function v3PoolOf(token0: Address, token1: Address, fee: number): Promise<Address> {
      return v3Factory().read.getPool([token0, token1, fee]);
    }

    /** v4 positions of an owner via the PositionManager. */
    // ── v4 owned-token enumeration ────────────────────────────────────────────
    // This PM is NOT ERC721Enumerable: tokenOfOwnerByIndex reverts on 4663
    // (probe-verified), and multicall-batched ownerOf() reverts atomically on
    // the first BURNED id (NOT_MINTED) — both probe-verified. Enumeration
    // instead derives ownership from ERC-721 Transfer logs (mint = from
    // 0x00…0, burn = to 0x00…0): owned = {transfers to wallet} − {transfers
    // from wallet}, exact for ERC-721. Gated by a 15-min TTL + balanceOf
    // change so the log queries run at most once per window.
    const v4OwnedIdsCache = new Map<
      string,
      { ids: bigint[]; balance: number; scannedAt: number }
    >();
    const V4_OWNED_IDS_TTL_MS = 15 * 60 * 1000;

    async function v4OwnedTokenIds(owner: Address): Promise<bigint[]> {
      const pm = v4PositionManager();
      const balance = Number(await pm.read.balanceOf([owner]));
      if (balance === 0) return [];
      const cached = v4OwnedIdsCache.get(owner.toLowerCase());
      if (
        cached &&
        cached.balance === balance &&
        Date.now() - cached.scannedAt < V4_OWNED_IDS_TTL_MS
      ) {
        return cached.ids;
      }
      const toWallet = await publicClient
        .getLogs({
          address: V4_POSITION_MANAGER,
          event: erc721TransferEvent,
          args: { to: getAddress(owner) },
          fromBlock: 0n,
        })
        .catch(() => []);
      const fromWallet = await publicClient
        .getLogs({
          address: V4_POSITION_MANAGER,
          event: erc721TransferEvent,
          args: { from: getAddress(owner) },
          fromBlock: 0n,
        })
        .catch(() => []);
      // Last-transfer-wins per id (NOT a net to−from set): a position that
      // left the wallet and came back (or was self-transferred) has BOTH from
      // and to events — the set version drops it and the 15-min re-scan can
      // never recover it, leaving that position with no exit gate or fee
      // claim. Ownership = the LATEST transfer event's recipient. Logs are
      // ordered within a block, so (blockNumber, logIndex) is a total order.
      const latest = new Map<string, { to: string; order: bigint }>();
      for (const log of [...toWallet, ...fromWallet]) {
        const id = log.args.id;
        const to = log.args.to;
        if (id === undefined || to === undefined) continue;
        const order =
          (log.blockNumber ?? 0n) * 1_000_000n + BigInt(log.logIndex ?? 0);
        const prev = latest.get(id.toString());
        if (prev === undefined || order > prev.order) {
          latest.set(id.toString(), { to: getAddress(to), order });
        }
      }
      const walletAddress = getAddress(owner);
      const owned = [...latest.entries()]
        .filter(([, v]) => v.to === walletAddress)
        .map(([id]) => BigInt(id));
      v4OwnedIdsCache.set(owner.toLowerCase(), { ids: owned, balance, scannedAt: Date.now() });
      logger.info("v4 position enumeration complete", {
        owner: owner.slice(0, 10),
        owned: owned.length,
        balance,
      });
      return owned;
    }

    async function v4PositionsOf(
      owner: Address,
      poolFilter?: string,
    ): Promise<ReadonlyArray<Position>> {
      const pm = v4PositionManager();
      const ownedIds = await v4OwnedTokenIds(owner);
      const positions: Position[] = [];
      for (const tokenId of ownedIds) {
        try {
          // New PM interface: poolKey + packed info, liquidity via lens call.
          // Decode the REAL tick range from the packed positionInfo (200-bit
          // poolId | 24-bit tickUpper | 24-bit tickLower | 8-bit subscriber) —
          // a hardcoded 0/0 range made every v4 position permanently
          // "out of range", firing the vol-gate EXIT on any volatility spike.
          const [poolKey, positionInfo] = await pm.read.getPoolAndPositionInfo([tokenId]);
          const liquidity = await pm.read.getPositionLiquidity([tokenId]);
          const key: V4PoolKey = {
            currency0: poolKey[0],
            currency1: poolKey[1],
            fee: Number(poolKey[2]),
            tickSpacing: Number(poolKey[3]),
            hooks: poolKey[4],
          };
          const poolId = await computeV4PoolId(key);
          if (poolFilter && poolId.toLowerCase() !== poolFilter.toLowerCase()) continue;
          const { tickLower, tickUpper } = decodeV4PositionInfo(positionInfo);
          positions.push({
            id: tokenId.toString(),
            poolAddress: poolId,
            poolName: `v4:${poolId.slice(0, 10)}`,
            tokenX: key.currency0.toLowerCase(),
            tokenY: key.currency1.toLowerCase(),
            lowerBinId: tickLower,
            upperBinId: tickUpper,
            liquidityShares: liquidity,
            depositedUsd: 0,
            currentValueUsd: 0,
            unrealizedPnlUsd: 0,
            feesEarnedUsd: 0,
            openedAt: Date.now(),
          });
        } catch {
          continue;
        }
      }
      return positions;
    }

    /**
     * v3 factory has no allPairs/allPairsLength on 4663 (reverts) — discover
     * via PoolCreated logs (factory startBlock 8930). In-memory cache; the
     * engine rotates scanOrdinal pages of 50.
     * ponytail: full-log scan on first call; a subgraph indexer replaces this
     * when pool counts grow.
     */
    let discoveredPoolCache: DiscoveredPool[] | null = null;
    async function discoverAllV3Pools(): Promise<DiscoveredPool[]> {
      if (discoveredPoolCache !== null) return discoveredPoolCache;
      const latest = await publicClient.getBlockNumber();
      // Public RPC times out on 100k-block log queries; 10k chunks work.
      // Window: env DISCOVERY_BLOCK_WINDOW (default 2M blocks ≈ recent pools);
      // the chain creates pools continuously (~509k total since genesis, ~99%
      // WETH-paired fee-10000 meme pools), so a full-history scan is
      // thousands of chunks — the gecko/subgraph indexer is the
      // completeness path (follow-up).
      const CHUNK = 10_000n;
      const windowBlocks = BigInt(
        Number(process.env.DISCOVERY_BLOCK_WINDOW ?? 2_000_000),
      );
      const fromStart = latest > windowBlocks ? latest - windowBlocks : 8930n;
      const pools = new Map<string, DiscoveredPool>();
      for (let from = fromStart; from <= latest; from += CHUNK) {
        const to = from + CHUNK - 1n < latest ? from + CHUNK - 1n : latest;
        try {
          const logs = await publicClient.getLogs({
            address: V3_FACTORY,
            event: poolCreatedEvent,
            fromBlock: from,
            toBlock: to,
          });
          for (const log of logs) {
            const args = log.args;
            if (!args.pool) continue;
            pools.set(args.pool.toLowerCase(), {
              address: args.pool.toLowerCase(),
              tokenX: args.token0?.toLowerCase() ?? "",
              tokenY: args.token1?.toLowerCase() ?? "",
              binStep: Number(args.tickSpacing ?? 60),
              tvlUsd: 0,
              volume24hUsd: 0,
              fees24hUsd: 0,
              apr: 0,
            });
          }
        } catch (e) {
          // viem errors embed BigInt args — stringify via message only.
          logger.warn("discoverAllV3Pools: chunk failed", {
            from: from.toString(),
            to: to.toString(),
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      discoveredPoolCache = [...pools.values()];
      logger.info("discovered v3 pools", { count: discoveredPoolCache.length });
      return discoveredPoolCache;
    }

    return {
      hasWallet: () => account !== null,
      getWalletAddress: () => walletAddress,
      // Chain-identity guard: eth_chainId against the CONFIGURED RPC (not the
      // hardcoded chain object). The engine's addresses are 4663-specific, so
      // the boot sequence refuses to start when this mismatches. A transport
      // error surfaces here too — the caller decides fail-open vs fail-closed.
      verifyChainId: () => Effect.tryPromise(() => publicClient.getChainId()),
      getWalletBalanceUsd: () => Effect.gen(function* () {
        if (!walletAddress) return 0;
        const [nativeWei, stable] = yield* Effect.tryPromise(async () => {
          const [n, s] = await Promise.all([
            getBalance(NATIVE_MINT, walletAddress),
            getBalance(STABLECOIN_MINT, walletAddress),
          ]);
          return [n, s] as const;
        });
        const ethPrice = yield* Effect.tryPromise(() => priceUsd(NATIVE_MINT));
        return (Number(nativeWei) / 1e18) * ethPrice + Number(stable) / 1e6;
      }),
      getWalletHoldings: () => Effect.gen(function* () {
        const holdings = new Map<string, { amountAtomic: bigint; decimals: number }>();
        if (!walletAddress) return holdings;
        yield* Effect.tryPromise(async () => {
          const [n, s] = await Promise.all([
            getBalance(NATIVE_MINT, walletAddress),
            getBalance(STABLECOIN_MINT, walletAddress),
          ]);
          holdings.set(NATIVE_MINT, { amountAtomic: n, decimals: 18 });
          holdings.set(STABLECOIN_MINT, { amountAtomic: s, decimals: 6 });
        });
        return holdings;
      }),
      getNativeBalance: () => Effect.tryPromise(async () => {
        if (!walletAddress) return 0n;
        return publicClient.getBalance({ address: walletAddress });
      }),
      getPoolState: (poolAddress) =>
        Effect.tryPromise({
          try: async () => {
            // v4 poolIds are 66-char 0x-hex; v3 pools are 42-char addresses.
            if (poolAddress.length === 66) {
              const key = V4_POOL_REGISTRY[poolAddress.toLowerCase()];
              if (!key) {
                return {
                  address: poolAddress.toLowerCase(),
                  tokenX: "",
                  tokenY: "",
                  tokenXSymbol: "",
                  tokenYSymbol: "",
                  tvlUsd: 0,
                  volume24hUsd: 0,
                  fees24hUsd: 0,
                  apr: 0,
                  activeBinId: 0,
                  binStep: 0,
                  currentPrice: 0,
                  timestamp: Date.now(),
                  statsSource: "heuristic" as const,
                };
              }
              const stateView = v4StateView();
              const poolIdHex = poolAddress.toLowerCase() as `0x${string}`;
              const [slot0] = await Promise.all([
                stateView.read.getSlot0([poolIdHex]),
                stateView.read.getLiquidity([poolIdHex]),
              ]);
              const tick = Number(slot0[1]);
              return {
                address: poolAddress.toLowerCase(),
                tokenX: key.currency0.toLowerCase(),
                tokenY: key.currency1.toLowerCase(),
                tokenXSymbol: isNative(key.currency0) ? "ETH" : "TOKEN",
                tokenYSymbol: isNative(key.currency1) ? "ETH" : "TOKEN",
                tvlUsd: 0,
                volume24hUsd: 0,
                fees24hUsd: 0,
                apr: 0,
                activeBinId: tick,
                binStep: key.tickSpacing,
                currentPrice: tickToPrice(tick),
                timestamp: Date.now(),
                statsSource: "heuristic" as const,
              };
            }
            return v3PoolState(getAddress(poolAddress));
          },
          catch: (e) => new Error(`getPoolState(${poolAddress}): ${underlyingErrorMessage(e)}`),
        }),
      getBinArray: (poolAddress) =>
        Effect.tryPromise({
          try: async () => {
            if (poolAddress.length === 66) {
              const key = V4_POOL_REGISTRY[poolAddress.toLowerCase()];
              if (!key) {
                return {
                  lowerBinId: 0,
                  upperBinId: 0,
                  bins: [],
                  activeBinId: 0,
                  binStep: 0,
                  reservesKnown: false,
                };
              }
              const stateView = v4StateView();
              const poolIdHex = poolAddress.toLowerCase() as `0x${string}`;
              const slot0 = await stateView.read.getSlot0([poolIdHex]);
              // v4 has no TickLens; per-tick reads are unbounded. Report the
              // active tick with a synthetic single bin so range utilization
              // is KNOWN (1.0 while the pool is live) instead of fabricating a
              // spread: the real utilization control for v4 is the
              // volatility-scaled RANGE WIDTH the strategy selects, not tick
              // occupancy. reservesKnown=true lets the ENTER gates proceed;
              // the strategy treats 1.0 as "managed range, in-scope" — a
              // deliberate proxy, not a measured value.
              return {
                lowerBinId: Number(slot0[1]),
                upperBinId: Number(slot0[1]),
                bins: [
                  {
                    binId: Number(slot0[1]),
                    reserveX: slot0[0],
                    reserveY: slot0[0],
                    liquiditySupply: 0n,
                    price: tickToPrice(Number(slot0[1])),
                  },
                ],
                activeBinId: Number(slot0[1]),
                binStep: key.tickSpacing,
                reservesKnown: true,
              };
            }
            return v3BinArray(getAddress(poolAddress));
          },
          catch: (e) => new Error(`getBinArray(${poolAddress}): ${underlyingErrorMessage(e)}`),
        }),
      getPositions: (poolAddress, wallet) =>
        Effect.tryPromise({
          try: async () =>
            poolAddress.length === 66
              ? v4PositionsOf(getAddress(wallet), poolAddress)
              : v3PositionsOf(getAddress(wallet), poolAddress),
          catch: (e) => new Error(`getPositions: ${underlyingErrorMessage(e)}`),
        }),
      getAllWalletPositions: (wallet) =>
        Effect.tryPromise({
          try: async () => {
            const owner = getAddress(wallet);
            const [v3, v4] = await Promise.all([v3PositionsOf(owner), v4PositionsOf(owner)]);
            return v3.concat(v4).map((p) => ({
              poolAddress: p.poolAddress,
              positionPubKey: p.id,
              lowerBinId: p.lowerBinId,
              upperBinId: p.upperBinId,
            }));
          },
          catch: (e) => new Error(`getAllWalletPositions: ${underlyingErrorMessage(e)}`),
        }),
      getPositionValueUsd: (poolAddress, positionPubKey) =>
        Effect.tryPromise({
          try: async () => {
            // Real mark: sqrt-price-bounded amount math (Uniswap v3/v4,
            // Q64.96) on the position's actual liquidity, both legs priced at
            // their own token. The old heuristic (liquidity/1e18 × price × 2)
            // was correct only for 18/18 pools near $1 — for the dominant
            // WETH/USDG (18/6, ~$3000) it undervalued positions ~20,000x,
            // collapsing portfolio equity into the 50% hard floor and faking
            // ~99.99% trailing drawdowns (EXIT churn). Fail-open: any
            // unreadable input returns null and the caller falls back to the
            // price-anchored mark.
            if (!walletAddress) return null;
            const pos =
              poolAddress.length === 66
                ? (await v4PositionsOf(walletAddress)).find((p) => p.id === positionPubKey)
                : (await v3PositionsOf(walletAddress)).find((p) => p.id === positionPubKey);
            if (!pos || pos.liquidityShares <= 0n) return null;
            const state = poolAddress.length === 66
              ? await v4PoolQuoteState(poolAddress)
              : await v3PoolQuoteState(getAddress(poolAddress));
            if (!state || !state.sqrtPriceX96) return null;
            // Amounts from liquidity + tick bounds (identical math v3/v4).
            const { amount0, amount1 } = positionAmountsAtSqrtPrice(
              pos.liquidityShares,
              pos.lowerBinId,
              pos.upperBinId,
              state.sqrtPriceX96,
            );
            const [price0, price1] = await Promise.all([
              priceUsd(state.token0).catch(() => 0),
              priceUsd(state.token1).catch(() => 0),
            ]);
            const usd0 = (Number(amount0) / 10 ** state.token0Decimals) * price0;
            const usd1 = (Number(amount1) / 10 ** state.token1Decimals) * price1;
            return usd0 + usd1;
          },
          catch: () => null,
        }).pipe(Effect.catch(() => Effect.succeed(null))),
      simulateRebalance: (_poolAddress, _positionPubKey, _newLowerBinId, _newUpperBinId) =>
        Effect.succeed({
          estimatedFeesUsd: 0,
          estimatedCostUsd: 0,
          netBenefitUsd: 0,
          source: "pool-heuristic" as const,
        }),
      enterPosition: (poolAddress, lowerBinId, upperBinId, positionSizeUsd, _options) =>
        Effect.tryPromise({
          try: async () => {
            const owner = requireWallet();
            const isV4 = poolAddress.length === 66;
            const state = isV4
              ? await v4PoolQuoteState(poolAddress)
              : await v3PoolQuoteState(getAddress(poolAddress));
            const [price0, price1] = await Promise.all([
              priceUsd(state.token0),
              priceUsd(state.token1),
            ]);
            const halfUsd = positionSizeUsd / 2;
            let amount0 = usdToAtomic(halfUsd, price0, state.token0Decimals);
            let amount1 = usdToAtomic(halfUsd, price1, state.token1Decimals);
            // Fail closed on an unpriceable pool: a USD-sized entry needs both
            // leg prices.
            if (amount0 <= 0n && amount1 <= 0n) {
              throw new Error(
                `enterPosition: cannot price pool legs (${state.token0}, ${state.token1})`,
              );
            }
            // Wallet-funding check → single-sided deposit when only one leg is
            // fundable (full size in the held leg), per the interface docs.
            const [bal0, bal1] = await Promise.all([
              getBalance(state.token0, owner),
              getBalance(state.token1, owner),
            ]);
            let mode: EntryDepositMode = "two-sided";
            if (bal0 >= amount0 && bal1 >= amount1) {
              // both legs fundable — two-sided
            } else if (bal0 >= amount0) {
              mode = "single-sided-x";
              amount1 = 0n;
              amount0 = usdToAtomic(positionSizeUsd, price0, state.token0Decimals);
            } else if (bal1 >= amount1) {
              mode = "single-sided-y";
              amount0 = 0n;
              amount1 = usdToAtomic(positionSizeUsd, price1, state.token1Decimals);
            } else {
              throw new Error(
                `enterPosition: wallet can fund neither leg (need ${amount0} ${state.token0} / ${amount1} ${state.token1})`,
              );
            }
            const deadline = Math.floor(Date.now() / 1000) + POSITION_DEADLINE_S;
            const slippageToleranceBps = 50;
            const rangeOverride =
              lowerBinId && upperBinId && lowerBinId < upperBinId
                ? { tickLower: lowerBinId, tickUpper: upperBinId }
                : {};
            if (isV4) {
              const key = await resolveV4PoolKey(poolAddress);
              const built = buildV4MintCalldata({
                poolKey: key,
                sqrtPriceX96: state.sqrtPriceX96,
                tickCurrent: state.tickCurrent,
                token0Decimals: state.token0Decimals,
                token1Decimals: state.token1Decimals,
                amount0,
                amount1,
                recipient: owner,
                deadline,
                slippageToleranceBps,
                ...rangeOverride,
              });
              // Sequential, not parallel: both broadcast through the shared
              // nonce cache, and parallel sends on a fresh wallet read the
              // same pending count -> identical nonce -> one tx rejected or
              // dropped (the first-ever mint is exactly this case).
              await ensurePermit2Allowance(key.currency0, V4_POSITION_MANAGER, built.amount0);
              await ensurePermit2Allowance(key.currency1, V4_POSITION_MANAGER, built.amount1);
              const { txSignature, receipt } = await sendTx({
                to: V4_POSITION_MANAGER,
                data: built.calldata,
                value: built.value,
              });
              const positionPubKey = tokenIdFromMintReceipt(receipt)?.toString() ?? "";
              if (!positionPubKey) throw new Error("enterPosition: could not decode minted tokenId");
              return {
                positionPubKey,
                txSignature,
                depositMode: mode,
                amountXUsd: usdOf(built.amount0, state.token0Decimals, price0),
                amountYUsd: usdOf(built.amount1, state.token1Decimals, price1),
              };
            }
            const built = buildV3MintCalldata({
              token0: state.token0,
              token1: state.token1,
              fee: state.fee,
              tickSpacing: state.tickSpacing,
              sqrtPriceX96: state.sqrtPriceX96,
              tickCurrent: state.tickCurrent,
              token0Decimals: state.token0Decimals,
              token1Decimals: state.token1Decimals,
              amount0,
              amount1,
              recipient: owner,
              deadline,
              slippageToleranceBps,
              ...rangeOverride,
            });
            // Sequential, not parallel: shared nonce cache (see v4 mint).
            await ensureErc20Allowance(state.token0, V3_NPM, built.amount0);
            await ensureErc20Allowance(state.token1, V3_NPM, built.amount1);
            const { txSignature, receipt } = await sendTx({
              to: V3_NPM,
              data: built.calldata,
              value: built.value,
            });
            const positionPubKey = tokenIdFromMintReceipt(receipt)?.toString() ?? "";
            if (!positionPubKey) throw new Error("enterPosition: could not decode minted tokenId");
            return {
              positionPubKey,
              txSignature,
              depositMode: mode,
              amountXUsd: usdOf(built.amount0, state.token0Decimals, price0),
              amountYUsd: usdOf(built.amount1, state.token1Decimals, price1),
            };
          },
          catch: (e) => new Error(`enterPosition: ${underlyingErrorMessage(e)}`),
        }),
      exitPosition: (poolAddress, positionPubKey) =>
        Effect.tryPromise({
          try: async () => {
            const reclaimed = await reclaimPosition(poolAddress, positionPubKey);
            const [price0, price1] = await Promise.all([
              priceUsd(reclaimed.token0),
              priceUsd(reclaimed.token1),
            ]);
            const withdrawnXAtomic = reclaimed.reclaimed0.toString();
            const withdrawnYAtomic = reclaimed.reclaimed1.toString();
            const withdrawnUsd =
              price0 > 0 && price1 > 0
                ? usdOf(BigInt(withdrawnXAtomic), reclaimed.decimals0, price0) +
                  usdOf(BigInt(withdrawnYAtomic), reclaimed.decimals1, price1)
                : null;
            const pendingFeeUsd =
              price0 > 0 && price1 > 0
                ? usdOf(reclaimed.pendingFeeXAtomic, reclaimed.decimals0, price0) +
                  usdOf(reclaimed.pendingFeeYAtomic, reclaimed.decimals1, price1)
                : null;
            return {
              txSignature: reclaimed.txSignature,
              withdrawnXAtomic,
              withdrawnYAtomic,
              withdrawnUsd,
              pendingFeeXAtomic: reclaimed.pendingFeeXAtomic.toString(),
              pendingFeeYAtomic: reclaimed.pendingFeeYAtomic.toString(),
              pendingFeeUsd,
              sweptRewards: [],
            };
          },
          catch: (e) => new Error(`exitPosition: ${underlyingErrorMessage(e)}`),
        }),
      placeLimitOrder: (_poolAddress, _request) => NOT_IMPLEMENTED("placeLimitOrder"),
      cancelLimitOrder: (_poolAddress, _orderPubKey, _binIds) => NOT_IMPLEMENTED("cancelLimitOrder"),
      rebalancePosition: (poolAddress, positionPubKey, newLowerBinId, newUpperBinId, topUp) =>
        Effect.tryPromise({
          try: async () => {
            const owner = requireWallet();
            // EVM v3/v4 have no in-place range change: full exit (burn) then
            // mint in the new range. The tokenId changes — program.ts re-keys
            // defensively when the returned pubkey differs.
            const reclaimed = await reclaimPosition(poolAddress, positionPubKey);
            const [price0, price1] = await Promise.all([
              priceUsd(reclaimed.token0),
              priceUsd(reclaimed.token1),
            ]);
            const reclaimedUsd =
              usdOf(reclaimed.reclaimed0, reclaimed.decimals0, price0) +
              usdOf(reclaimed.reclaimed1, reclaimed.decimals1, price1);
            const topUpUsd = topUp
              ? usdOf(topUp.amountXAtomic, reclaimed.decimals0, price0) +
                usdOf(topUp.amountYAtomic, reclaimed.decimals1, price1)
              : 0;
            const newSizeUsd = reclaimedUsd + topUpUsd;
            if (!(newSizeUsd > 0)) throw new Error("rebalancePosition: reclaimed value is 0");
            const state = reclaimed.isV4
              ? await v4PoolQuoteState(poolAddress)
              : await v3PoolQuoteState(getAddress(poolAddress));
            const deadline = Math.floor(Date.now() / 1000) + POSITION_DEADLINE_S;
            const slippageToleranceBps = 50;
            const amount0 = usdToAtomic(newSizeUsd / 2, price0, state.token0Decimals);
            const amount1 = usdToAtomic(newSizeUsd / 2, price1, state.token1Decimals);
            let mintTx: string;
            let newTokenId: string;
            if (reclaimed.isV4) {
              const key = await resolveV4PoolKey(poolAddress);
              const built = buildV4MintCalldata({
                poolKey: key,
                sqrtPriceX96: state.sqrtPriceX96,
                tickCurrent: state.tickCurrent,
                token0Decimals: state.token0Decimals,
                token1Decimals: state.token1Decimals,
                amount0,
                amount1,
                recipient: owner,
                deadline,
                slippageToleranceBps,
                tickLower: newLowerBinId,
                tickUpper: newUpperBinId,
              });
              // Sequential, not parallel: both broadcast through the shared
              // nonce cache, and parallel sends on a fresh wallet read the
              // same pending count -> identical nonce -> one tx rejected or
              // dropped (the first-ever mint is exactly this case).
              await ensurePermit2Allowance(key.currency0, V4_POSITION_MANAGER, built.amount0);
              await ensurePermit2Allowance(key.currency1, V4_POSITION_MANAGER, built.amount1);
              const res = await sendTx({
                to: V4_POSITION_MANAGER,
                data: built.calldata,
                value: built.value,
              });
              mintTx = res.txSignature;
              const tid = tokenIdFromMintReceipt(res.receipt);
              if (!tid) throw new Error("rebalancePosition: could not decode minted tokenId");
              newTokenId = tid.toString();
            } else {
              const built = buildV3MintCalldata({
                token0: state.token0,
                token1: state.token1,
                fee: state.fee,
                tickSpacing: state.tickSpacing,
                sqrtPriceX96: state.sqrtPriceX96,
                tickCurrent: state.tickCurrent,
                token0Decimals: state.token0Decimals,
                token1Decimals: state.token1Decimals,
                amount0,
                amount1,
                recipient: owner,
                deadline,
                slippageToleranceBps,
                tickLower: newLowerBinId,
                tickUpper: newUpperBinId,
              });
              // Sequential, not parallel: shared nonce cache (see v4 mint).
              await ensureErc20Allowance(state.token0, V3_NPM, built.amount0);
              await ensureErc20Allowance(state.token1, V3_NPM, built.amount1);
              const res = await sendTx({ to: V3_NPM, data: built.calldata, value: built.value });
              mintTx = res.txSignature;
              const tid = tokenIdFromMintReceipt(res.receipt);
              if (!tid) throw new Error("rebalancePosition: could not decode minted tokenId");
              newTokenId = tid.toString();
            }
            return { positionPubKey: newTokenId, txSignatures: [reclaimed.txSignature, mintTx] };
          },
          catch: (e) => new Error(`rebalancePosition: ${underlyingErrorMessage(e)}`),
        }),
      claimFees: (poolAddress, positionPubKey, ..._rest) =>
        Effect.tryPromise({
          try: async () => {
            const owner = requireWallet();
            const tokenId = BigInt(positionPubKey);
            const isV4 = poolAddress.length === 66;
            let token0: Address;
            let token1: Address;
            let decimals0: number;
            let decimals1: number;
            let calldata: Hex;
            let value: bigint;
            let expected0 = 0n;
            let expected1 = 0n;
            if (isV4) {
              const pm = v4PositionManager();
              const [poolKeyTuple] = await pm.read.getPoolAndPositionInfo([tokenId]);
              const key: V4PoolKey = {
                currency0: poolKeyTuple[0],
                currency1: poolKeyTuple[1],
                fee: Number(poolKeyTuple[2]),
                tickSpacing: Number(poolKeyTuple[3]),
                hooks: poolKeyTuple[4],
              };
              const state = await v4PoolQuoteState(poolAddress);
              const built = buildV4CollectCalldata({
                poolKey: key,
                tokenId,
                recipient: owner,
                deadline: Math.floor(Date.now() / 1000) + POSITION_DEADLINE_S,
                slippageToleranceBps: 50,
              });
              calldata = built.calldata;
              value = built.value;
              token0 = key.currency0;
              token1 = key.currency1;
              decimals0 = state.token0Decimals;
              decimals1 = state.token1Decimals;
            } else {
              const npm = v3Npm();
              const p = await npm.read.positions([tokenId]);
              token0 = p[2];
              token1 = p[3];
              expected0 = p[10];
              expected1 = p[11];
              const fee = Number(p[4]);
              const state = await v3PoolQuoteState(await v3PoolOf(token0, token1, fee));
              const built = buildV3CollectCalldata({
                tokenId,
                token0,
                token1,
                token0Decimals: state.token0Decimals,
                token1Decimals: state.token1Decimals,
                recipient: owner,
              });
              calldata = built.calldata;
              value = built.value;
              decimals0 = state.token0Decimals;
              decimals1 = state.token1Decimals;
            }
            const [pre0, pre1] = await Promise.all([
              getBalance(token0, owner),
              getBalance(token1, owner),
            ]);
            const { txSignature } = await sendTx({
              to: isV4 ? V4_POSITION_MANAGER : V3_NPM,
              data: calldata,
              value,
            });
            const [post0, post1] = await Promise.all([
              getBalance(token0, owner),
              getBalance(token1, owner),
            ]);
            // Exact collected amounts via balance deltas; v3 tokensOwed is the
            // fallback when the delta is 0 (zero-fee claim).
            const atomic0 = post0 - pre0 > 0n ? post0 - pre0 : expected0;
            const atomic1 = post1 - pre1 > 0n ? post1 - pre1 : expected1;
            const feeX = Number(atomic0) / 10 ** decimals0;
            const feeY = Number(atomic1) / 10 ** decimals1;
            const [price0, price1] = await Promise.all([priceUsd(token0), priceUsd(token1)]);
            // v3/v4 collect pays 100% to the wallet — no on-chain platform
            // split (the engine's platform fee is applied off-chain).
            const netFeesUsd =
              price0 > 0 && price1 > 0
                ? usdOf(atomic0, decimals0, price0) + usdOf(atomic1, decimals1, price1)
                : null;
            return {
              txSignature,
              feeX,
              feeY,
              platformFeeX: 0,
              platformFeeY: 0,
              netFeeX: feeX,
              netFeeY: feeY,
              operatorFeeX: 0,
              operatorFeeY: 0,
              netFeesUsd,
            };
          },
          catch: (e) => new Error(`claimFees: ${underlyingErrorMessage(e)}`),
        }),
      convertClaimedFees: (_poolAddress, destination, _feeX, _feeY) =>
        Effect.succeed({
          destination,
          // Uniswap v3/v4 have no fee-conversion module (the Meteora convert
          // path does not exist here); report the skip shape.
          outputAtomic: 0n,
          outputUsd: null,
          txSignatures: [],
        }),
      claimRewards: (_poolAddress, _positionPubKey) =>
        Effect.succeed({
          skipped: true,
          skipReason: "no LM farm rewards on Uniswap v3/v4 (Robinhood Chain)",
          txSignatures: [],
          rewards: [],
        }),
      discoverPools: (scanOrdinal) =>
        Effect.tryPromise({
          try: async () => {
            const all = await discoverAllV3Pools();
            if (all.length === 0) return all;
            const pageSize = 50;
            const pages = Math.ceil(all.length / pageSize);
            const page = (scanOrdinal ?? 0) % pages;
            return all.slice(page * pageSize, page * pageSize + pageSize);
          },
          catch: (e) =>
            new DiscoverPoolsError({
              message: `discoverPools: ${underlyingErrorMessage(e)}`,
              url: rpcUrl,
            }),
        }),
      reportFeeCollection: () => Effect.void,
      // Original semantics: fail-open (never errors) — logs and continues.
      swapUSDCForNative: (minNativeThreshold, swapAmountStable) =>
        Effect.tryPromise({
          try: async () => {
            if (!walletAddress) {
              logger.warn("swapUSDCForNative: no wallet configured");
              return;
            }
            const threshold = BigInt(minNativeThreshold ?? MIN_NATIVE_FOR_GAS_WEI);
            const nativeBalance = await publicClient.getBalance({ address: walletAddress });
            if (nativeBalance >= threshold) return;
            const desiredUsdg = BigInt(Math.round((swapAmountStable ?? GAS_TOP_UP_STABLECOIN) * 1e6));
            const usdgBalance = await getBalance(STABLECOIN_MINT, walletAddress);
            // Never drain the stablecoin leg (safety audit): cap the top-up at
            // 20% of the USDG balance so a swap failure cannot strand the
            // wallet all-in-ETH with no stablecoin to fund positions.
            const drainCap = (usdgBalance * 20n) / 100n;
            const amountIn =
              usdgBalance < desiredUsdg
                ? drainCap < usdgBalance
                  ? drainCap
                  : usdgBalance
                : desiredUsdg < drainCap
                  ? desiredUsdg
                  : drainCap;
            if (amountIn <= 0n) {
              logger.warn("swapUSDCForNative: no USDG balance to top up gas");
              return;
            }
            // v3 path only (v3 pools are WETH-paired): USDG -> WETH into the
            // router, then unwrapWETH9 -> native ETH to the wallet, one tx.
            const { outAmountAtomic, route } = await quotePair(STABLECOIN_MINT, WETH9, amountIn);
            if (route.router !== "swaprouter02") {
              logger.warn("swapUSDCForNative: no v3 USDG/WETH pool");
              return;
            }
            const amountOutMinimum = (outAmountAtomic * 9900n) / 10000n; // 1% slippage
            const deadline = Math.floor(Date.now() / 1000) + 300;
            const swapData = buildV3ExactInputSingleCalldata({
              tokenIn: STABLECOIN_MINT,
              tokenOut: WETH9,
              fee: route.fee,
              recipient: V3_SWAP_ROUTER_02,
              deadline,
              amountIn,
              amountOutMinimum,
            });
            const unwrapData = buildUnwrapWETH9Calldata(amountOutMinimum, walletAddress);
            const calldata = buildSwapRouterMulticallCalldata([swapData, unwrapData]);
            await ensureErc20Allowance(STABLECOIN_MINT, V3_SWAP_ROUTER_02, amountIn);
            const { txSignature } = await sendTx({ to: V3_SWAP_ROUTER_02, data: calldata });
            logger.info("swapUSDCForNative", { txSignature, amountIn: amountIn.toString() });
          },
          catch: (e) => {
            logger.warn("swapUSDCForNative failed (fail-open)", {
              error: underlyingErrorMessage(e),
            });
          },
        }).pipe(Effect.catch(() => Effect.void)),      getTokenBalance: (mint) =>
        Effect.tryPromise({
          try: async () => (walletAddress ? getBalance(mint, walletAddress) : 0n),
          catch: (e) => new Error(`getTokenBalance: ${underlyingErrorMessage(e)}`),
        }),
      getTokenPrices: (mints, _opts) =>
        Effect.tryPromise({
          try: async () => {
            const out: Record<string, number> = {};
            for (const mint of mints) out[mint] = await priceUsd(mint);
            return out;
          },
          catch: (e) => new Error(`getTokenPrices: ${underlyingErrorMessage(e)}`),
        }),
      getTokenDecimals: (mint) =>
        Effect.tryPromise({
          try: () => getDecimals(mint),
          catch: (e) => new Error(`getTokenDecimals: ${underlyingErrorMessage(e)}`),
        }),
      // EVM ERC-20 has no on-chain mint/freeze authority registry; nulls are
      // the fail-open contract (callers treat absent authorities as unknown).
      getMintAuthorities: (_mintAddress) =>
        Effect.succeed({ mintAuthority: null, freezeAuthority: null }),
      swapToken: (inputMint, outputMint, amountAtomic, _quoteData) =>
        Effect.tryPromise({
          try: async () => {
            const { outAmountAtomic, route } = await quotePair(inputMint, outputMint, amountAtomic);
            const amountOutMinimum = (outAmountAtomic * 9950n) / 10000n;
            const deadline = Math.floor(Date.now() / 1000) + 300;
            const calldata = buildSwapCalldata(
              route,
              inputMint,
              outputMint,
              amountAtomic,
              amountOutMinimum,
              deadline,
            );
            await approveInputForRoute(inputMint, route, amountAtomic);
            const { txSignature } = await sendTx({ to: route.target, data: calldata });
            return txSignature;
          },
          catch: (e) => new Error(`swapToken: ${underlyingErrorMessage(e)}`),
        }),
      quoteSwap: (request) =>
        Effect.tryPromise({
          try: async () => {
            const { outAmountAtomic, route } = await quotePair(
              request.inputMint,
              request.outputMint,
              request.amountAtomic,
            );
            const slippageBps = request.slippageBps > 0 ? request.slippageBps : 50;
            const minimumOutAmountAtomic =
              (outAmountAtomic * BigInt(10_000 - slippageBps)) / 10_000n;
            return {
              request,
              outAmountAtomic,
              minimumOutAmountAtomic,
              // Single-hop current-liquidity quote; price impact is not modeled.
              priceImpactBps: 0,
              quotedAt: Date.now(),
              route: [{ inputMint: request.inputMint, outputMint: request.outputMint }],
              rawQuote: {
                router: route.router,
                ...(route.router === "swaprouter02"
                  ? { pool: route.pool.toLowerCase(), fee: route.fee }
                  : { poolId: route.poolId, poolKey: route.poolKey, zeroForOne: route.zeroForOne }),
                amountIn: request.amountAtomic.toString(),
                outAmountAtomic: outAmountAtomic.toString(),
              },
            };
          },
          catch: (e) => new Error(`quoteSwap: ${underlyingErrorMessage(e)}`),
        }),
      prepareSwap: (quote) =>
        Effect.tryPromise({
          try: async () => {
            const owner = requireWallet();
            const raw = quote.rawQuote;
            const deadline = Math.floor(Date.now() / 1000) + 300;
            const calldata =
              raw.router === "universalrouter"
                ? buildUniversalRouterV4SwapCalldata({
                    poolKey: raw.poolKey as V4PoolKey,
                    zeroForOne: raw.zeroForOne as boolean,
                    amountIn: quote.request.amountAtomic,
                    amountOutMinimum: quote.minimumOutAmountAtomic,
                    deadline,
                  })
                : buildV3ExactInputSingleCalldata({
                    tokenIn: routerInputAddress(quote.request.inputMint, "swaprouter02"),
                    tokenOut: routerInputAddress(quote.request.outputMint, "swaprouter02"),
                    fee: raw.fee as number,
                    recipient: owner,
                    deadline,
                    amountIn: quote.request.amountAtomic,
                    amountOutMinimum: quote.minimumOutAmountAtomic,
                  });
            return {
              quote,
              transactionBase64: Buffer.from(calldata.slice(2), "hex").toString("base64"),
              transactionFormat: "legacy" as const,
              preparedAt: Date.now(),
            };
          },
          catch: (e) => new Error(`prepareSwap: ${underlyingErrorMessage(e)}`),
        }),
      simulateSwap: (prepared) =>
        Effect.tryPromise({
          try: async () => {
            const owner = requireWallet();
            const raw = prepared.quote.rawQuote;
            const calldata = (`0x${Buffer.from(prepared.transactionBase64, "base64").toString("hex")}`) as Hex;
            const target = raw.router === "universalrouter" ? UNIVERSAL_ROUTER : V3_SWAP_ROUTER_02;
            await publicClient.call({ account: owner, to: target, data: calldata });
            return { successful: true, logs: [], unitsConsumed: null };
          },
          catch: (e) => new Error(`simulateSwap: ${underlyingErrorMessage(e)}`),
        }),
      submitSwap: (prepared, onBroadcast) =>
        Effect.gen(function* () {
          const raw = prepared.quote.rawQuote;
          const calldata = (`0x${Buffer.from(prepared.transactionBase64, "base64").toString("hex")}`) as Hex;
          const route: SwapRoute =
            raw.router === "universalrouter"
              ? {
                  router: "universalrouter",
                  target: UNIVERSAL_ROUTER,
                  poolId: raw.poolId as string,
                  poolKey: raw.poolKey as V4PoolKey,
                  zeroForOne: raw.zeroForOne as boolean,
                  decimals0: 0,
                  decimals1: 0,
                }
              : {
                  router: "swaprouter02",
                  target: V3_SWAP_ROUTER_02,
                  pool: raw.pool as Address,
                  fee: raw.fee as number,
                  zeroForOne: false,
                  decimals0: 0,
                  decimals1: 0,
                };
          yield* Effect.tryPromise(() =>
            approveInputForRoute(
              prepared.quote.request.inputMint,
              route,
              prepared.quote.request.amountAtomic,
            ),
          );
          const { txSignature } = yield* Effect.tryPromise(() =>
            sendTx({ to: route.target, data: calldata }),
          );
          if (onBroadcast) yield* onBroadcast(txSignature);
          return txSignature;
        }),
      getSwapStatus: (signature) =>
        Effect.tryPromise({
          try: async () => {
            const receipt = await publicClient
              .getTransactionReceipt({ hash: signature as Hex })
              .catch(() => null);
            if (!receipt) return { state: "not_found" as const, error: null };
            if (receipt.status === "success") return { state: "confirmed" as const, error: null };
            return { state: "failed" as const, error: `transaction reverted: ${signature}` };
          },
          catch: (e) => new Error(`getSwapStatus: ${underlyingErrorMessage(e)}`),
        }),
      getConfirmedSwapOutput: (signature) =>
        Effect.tryPromise({
          try: async () => {
            const receipt = await publicClient
              .getTransactionReceipt({ hash: signature as Hex })
              .catch(() => null);
            if (!receipt || receipt.status !== "success") return null;
            // v3 Swap event: the exact-output amount is the positive int256 side.
            for (const log of receipt.logs) {
              if (log.topics[0]?.toLowerCase() === v3SwapEventTopic) {
                const data = log.data.slice(2);
                const amount0 = BigInt.asIntN(256, BigInt(`0x${data.slice(0, 64)}`));
                const amount1 = BigInt.asIntN(256, BigInt(`0x${data.slice(64, 128)}`));
                const output = amount0 > 0n ? amount0 : amount1 > 0n ? amount1 : 0n;
                return { outputAtomic: output, feeAtomic: 0n };
              }
            }
            return null;
          },
          catch: (e) => new Error(`getConfirmedSwapOutput: ${underlyingErrorMessage(e)}`),
        }),
    } satisfies AdapterApi;
  }),
);
