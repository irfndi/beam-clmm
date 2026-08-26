// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread -- viem/RPC and config compatibility boundaries are normalized here.
import { Effect, Layer } from "effect";
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  decodeFunctionResult,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContract,
  http,
  isAddress,
  isHex,
  fallback,
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

/** Spacing-aligned tick range (v3/v4 nearestUsableTick bounds). */
interface TickRange {
  tickLower: number;
  tickUpper: number;
}

/** Calldata + native-currency `value` pair produced by an SDK call builder. */
interface CalldataResult {
  calldata: Hex;
  value: bigint;
}

function sdkHex(value: string): Hex {
  if (!isHex(value)) throw new Error("Uniswap SDK returned malformed calldata");
  return value;
}

function poolIdHex(value: string): Hex {
  if (!isHex(value) || value.length !== 66) {
    throw new Error(`invalid v4 pool id: ${value}`);
  }
  return value;
}

function transactionHash(value: string): Hex {
  if (!isHex(value) || value.length !== 66) {
    throw new Error("invalid transaction hash");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function privateKeyHex(value: string): `0x${string}` {
  if (!isHex(value) || value.length !== 66) {
    throw new Error("expected 0x-prefixed, 64 hex chars");
  }
  return value;
}

function isV4PoolKey(value: unknown): value is V4PoolKey {
  if (!isRecord(value)) return false;
  return (
    typeof value.currency0 === "string" &&
    isAddress(value.currency0) &&
    typeof value.currency1 === "string" &&
    isAddress(value.currency1) &&
    typeof value.fee === "number" &&
    Number.isFinite(value.fee) &&
    typeof value.tickSpacing === "number" &&
    Number.isFinite(value.tickSpacing) &&
    typeof value.hooks === "string" &&
    isAddress(value.hooks)
  );
}

type V4SwapQuoteRaw = {
  readonly router: "universalrouter";
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
  readonly zeroForOne: boolean;
};

type V3SwapQuoteRaw = {
  readonly router: "swaprouter02";
  readonly pool: Address;
  readonly fee: number;
};

function isV4SwapQuoteRaw(value: unknown): value is V4SwapQuoteRaw {
  if (!isRecord(value)) return false;
  return (
    value.router === "universalrouter" &&
    typeof value.poolId === "string" &&
    isV4PoolKey(value.poolKey) &&
    typeof value.zeroForOne === "boolean"
  );
}

function isV3SwapQuoteRaw(value: unknown): value is V3SwapQuoteRaw {
  if (!isRecord(value)) return false;
  return (
    value.router === "swaprouter02" &&
    typeof value.pool === "string" &&
    isAddress(value.pool) &&
    typeof value.fee === "number" &&
    Number.isFinite(value.fee)
  );
}

function decodePreparedCalldata(base64: string): Hex {
  return sdkHex(`0x${Buffer.from(base64, "base64").toString("hex")}`);
}

type V3MintArgs = readonly [
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

function parseV3MintArgs(value: unknown): V3MintArgs {
  if (!Array.isArray(value) || value.length < 11) {
    throw new Error("Uniswap SDK returned malformed v3 mint arguments");
  }
  const [
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    amount0,
    amount1,
    amount0Min,
    amount1Min,
    recipient,
    deadline,
  ] = value;
  if (
    typeof token0 !== "string" ||
    !isAddress(token0) ||
    typeof token1 !== "string" ||
    !isAddress(token1) ||
    typeof fee !== "number" ||
    typeof tickLower !== "number" ||
    typeof tickUpper !== "number" ||
    typeof amount0 !== "bigint" ||
    typeof amount1 !== "bigint" ||
    typeof amount0Min !== "bigint" ||
    typeof amount1Min !== "bigint" ||
    typeof recipient !== "string" ||
    !isAddress(recipient) ||
    typeof deadline !== "bigint"
  ) {
    throw new Error("Uniswap SDK returned invalid v3 mint argument types");
  }
  return [
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    amount0,
    amount1,
    amount0Min,
    amount1Min,
    recipient,
    deadline,
  ];
}

function parsePopulatedTicks(value: unknown): ReadonlyArray<readonly [number, bigint, bigint]> {
  if (!Array.isArray(value)) throw new Error("TickLens returned malformed tick data");
  const parsed: Array<readonly [number, bigint, bigint]> = [];
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length < 3 ||
      typeof entry[0] !== "number" ||
      typeof entry[1] !== "bigint" ||
      typeof entry[2] !== "bigint"
    ) {
      throw new Error("TickLens returned invalid tick data");
    }
    parsed.push([entry[0], entry[1], entry[2]]);
  }
  return parsed;
}

/** token0/token1 amounts for a position at a given sqrt price. */
interface AmountsInRange {
  amount0: bigint;
  amount1: bigint;
}

// ─── Chain selection ─────────────────────────────────────────────────────────
// The chain is a RUNTIME selection driven by BEAM_CHAIN (default "base"), with
// all Uniswap deployment addresses and the viem chain object resolved from
// chain-registry.ts. Robinhood is no longer the default — Base is. Paper
// trading works on any registered chain; live trading needs a funded key on
// the selected chain. The values are both imported (for local use) and
// re-exported (so downstream imports of CHAIN_ID etc. keep resolving).
import {
  CHAIN_ID,
  DEFAULT_RPC,
  ROBINHOOD_CHAIN,
  V3_FACTORY,
  V3_NPM,
  V3_TICK_LENS,
  MULTICALL3,
  V4_POSITION_MANAGER,
  V4_STATE_VIEW,
  UNIVERSAL_ROUTER,
  V3_SWAP_ROUTER_02,
  V3_SWAP_ROUTER_ENCODING,
  WETH9,
} from "./chain-registry.js";
export {
  CHAIN_ID,
  DEFAULT_RPC,
  ROBINHOOD_CHAIN,
  V3_FACTORY,
  V3_NPM,
  V3_TICK_LENS,
  V4_POSITION_MANAGER,
  V4_STATE_VIEW,
  UNIVERSAL_ROUTER,
  V3_SWAP_ROUTER_02,
  WETH9,
  DEFAULT_STABLECOIN_MINT,
  GECKO_NETWORK_SLUG,
  LIVE_ENTRY_V4_ENABLED_CHAIN,
  listChains,
  getChainDeployment,
  BEAM_CHAIN_NAME,
  ACTIVE_CHAIN_KEY,
} from "./chain-registry.js";

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

export function isResolvedV4PoolKeyValid(key: V4PoolKey): boolean {
  const zero = "0x0000000000000000000000000000000000000000";
  const currency0 = key.currency0.toLowerCase();
  const currency1 = key.currency1.toLowerCase();
  return (
    isAddress(key.currency0) &&
    isAddress(key.currency1) &&
    isAddress(key.hooks) &&
    currency1 !== zero &&
    currency0 !== currency1 &&
    Number.isInteger(key.fee) &&
    key.fee >= 0 &&
    key.fee <= 0xffffff &&
    Number.isInteger(key.tickSpacing) &&
    key.tickSpacing > 0
  );
}

export const V4_POOL_REGISTRY: Record<string, V4PoolKey> = {};
const VERIFIED_V4_POOL_IDS = new Set<string>();

/**
 * Register a v4 pool key by poolId (lowercase 0x-hex). v4 pools have no
 * on-chain enumeration (poolId is a one-way hash), so discovery seeds this
 * registry from known pairs / an indexer; `poolKeys(bytes25)` on the
 * PositionManager can reverse a truncated id when the key is unknown.
 */
export function registerV4Pool(poolId: string, key: V4PoolKey): void {
  V4_POOL_REGISTRY[poolId.toLowerCase()] = key;
}

function registerVerifiedV4Pool(poolId: string, key: V4PoolKey): void {
  const id = poolId.toLowerCase();
  V4_POOL_REGISTRY[id] = key;
  VERIFIED_V4_POOL_IDS.add(id);
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
const multicall3Abi = parseAbi([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)",
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

/** Convert a raw token1/token0 atomic-unit ratio into base tokens per mint. */
export function rawPoolPriceToBasePerMint(
  rawPrice: number,
  mintIsToken0: boolean,
  mintDecimals: number,
  baseDecimals: number,
): number {
  const scale = 10 ** (mintDecimals - baseDecimals);
  return mintIsToken0 ? rawPrice * scale : scale / rawPrice;
}

/** Pick the quote with the greatest exact output; null when none succeeded. */
export function selectHighestOutputQuote<T extends { readonly outAmountAtomic: bigint }>(
  quotes: ReadonlyArray<T>,
): T | null {
  let best: T | null = null;
  for (const quote of quotes) {
    if (best === null || quote.outAmountAtomic > best.outAmountAtomic) best = quote;
  }
  return best;
}

function settledFiniteNumber(result: PromiseSettledResult<number>): number | undefined {
  return result.status === "fulfilled" && Number.isFinite(result.value) ? result.value : undefined;
}

function settledPositiveNumber(result: PromiseSettledResult<number>): number | undefined {
  return result.status === "fulfilled" && Number.isFinite(result.value) && result.value > 0
    ? result.value
    : undefined;
}

const decimalsCache = new Map<string, number>();

/** USD price TTL cache — see priceUsd. 5 minutes: fresh enough for risk
 *  gates and marks, and it collapses the per-cycle re-pricing of the same
 *  pool legs that was driving the public RPC into HTTP 429s. */
const PRICE_CACHE_TTL_MS = 5 * 60_000;
const priceCache = new Map<string, { price: number; at: number }>();
/** Upper bound on cached USD marks: meme-token churn would otherwise grow the
 *  map forever (entries are overwritten on re-read but never deleted). */
const PRICE_CACHE_MAX_ENTRIES = 1024;

/** Cycle-scoped wallet position enumeration — see positionsEnumeration.
 *  Reconcile, the equity mark, and per-pool getPositions all enumerate the
 *  SAME wallet within one scan cycle; unshared, that is 2–3 full NFT
 *  enumerations per cycle against a rate-limited public RPC. Lives in the
 *  service layer (not module scope) so its lifetime is the adapter's. */
const ENUMERATION_CACHE_TTL_MS = 30_000;

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
/** Live 4663 SwapRouter02 encoding (probe-verified 2026-08-10): the 7-field
 *  exactInputSingle struct WITHOUT the deadline param. */
const swapRouter02V2Abi = parseAbi([
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)",
  "function unwrapWETH9(uint256,address) payable",
  "function multicall(bytes[]) payable returns (bytes[])",
]);
const universalRouterAbi = parseAbi(["function execute(bytes,bytes[],uint256) payable"]);

const weth9Abi = parseAbi(["function deposit() payable", "function withdraw(uint256)"]);

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

/** viem chain object for the ACTIVE chain (re-exported values resolve above). */

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
export function tickRangeAround(tick: number, tickSpacing: number, rangeBps = 500): TickRange {
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
  const decoded = decodeFunctionData({ abi: v3MintDecodeAbi, data: sdkHex(calldata) });
  const p = parseV3MintArgs(decoded.args[0]);
  return {
    calldata: sdkHex(calldata),
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
export function buildV3CollectCalldata(args: V3CollectCalldataArgs): CalldataResult {
  const { tokenId, token0, token1, token0Decimals, token1Decimals, recipient } = args;
  const { calldata, value } = V3NonfungiblePositionManager.collectCallParameters({
    tokenId: tokenId.toString(),
    expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(v3Token(token0, token0Decimals), "0"),
    expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(v3Token(token1, token1Decimals), "0"),
    recipient: getAddress(recipient),
  });
  return { calldata: sdkHex(calldata), value: BigInt(value) };
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
export function buildV3ExitCalldata(args: V3ExitCalldataArgs): CalldataResult {
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
  return { calldata: sdkHex(calldata), value: BigInt(value) };
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

/**
 * SwapRouter02 v2 exactInputSingle — the 7-field struct WITHOUT the deadline
 * param (deadline removed in @uniswap/swap-router-contracts 2.0). Probe
 * 2026-08-10 (chain 4663): the deployed SwapRouter02 0xCaf681… carries
 * selector 0x04e45aaf (7-field) and NOT 0x414bf389 (8-field) — the legacy
 * builder's calldata reverts on this chain. New swap paths (swap-to-fund,
 * verifyExitRoute, convertClaimedFees) must use this encoding.
 */
export function buildV3ExactInputSingleCalldataV2(args: {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly fee: number;
  readonly recipient: Address;
  readonly amountIn: bigint;
  readonly amountOutMinimum: bigint;
  readonly sqrtPriceLimitX96?: bigint;
}): Hex {
  const {
    tokenIn,
    tokenOut,
    fee,
    recipient,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96 = 0n,
  } = args;
  return encodeFunctionData({
    abi: swapRouter02V2Abi,
    functionName: "exactInputSingle",
    args: [
      [
        getAddress(tokenIn),
        getAddress(tokenOut),
        fee,
        getAddress(recipient),
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

/** v3 SwapRouter02 exactInputSingle calldata for the ACTIVE chain. Canonical
 *  deployments (Base) use the 8-field struct WITH deadline (selector
 *  0x414bf389); Robinhood's fork uses the 7-field struct WITHOUT deadline
 *  (selector 0x04e45aaf). ALL v3 swap paths must route through this so the
 *  encoding matches the deployed router — a mismatch reverts every swap. */
export function buildV3SwapCalldataForChain(args: {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly fee: number;
  readonly recipient: Address;
  readonly amountIn: bigint;
  readonly amountOutMinimum: bigint;
  readonly deadline?: number;
}): Hex {
  if (V3_SWAP_ROUTER_ENCODING === "canonical-8f") {
    return buildV3ExactInputSingleCalldata({
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      fee: args.fee,
      recipient: args.recipient,
      deadline: args.deadline ?? Math.floor(Date.now() / 1000) + 300,
      amountIn: args.amountIn,
      amountOutMinimum: args.amountOutMinimum,
    });
  }
  return buildV3ExactInputSingleCalldataV2({
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    fee: args.fee,
    recipient: args.recipient,
    amountIn: args.amountIn,
    amountOutMinimum: args.amountOutMinimum,
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
export function buildUniversalRouterV4SwapCalldata(args: UniversalRouterV4SwapCalldataArgs): Hex {
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
        [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
        zeroForOne,
        amountIn,
        amountOutMinimum,
        args.minHopPriceX36 ?? 0n,
        "0x",
      ],
    ],
  );
  const unlockData = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    ["0x06", [swapParams]],
  );
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
    calldata: sdkHex(calldata),
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
export function buildV4CollectCalldata(args: V4CollectCalldataArgs): CalldataResult {
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
  return { calldata: sdkHex(calldata), value: BigInt(value) };
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
export function buildV4ExitCalldata(args: V4ExitCalldataArgs): CalldataResult {
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
  return { calldata: sdkHex(calldata), value: BigInt(value) };
}

/**
 * Decode the new-interface PM's packed positionInfo (200b poolId | 24b
 * tickUpper | 24b tickLower | 8b hasSubscriber; ticks are int24 sign-extended).
 */
export function decodeV4PositionInfo(info: bigint): TickRange {
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
): AmountsInRange {
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
export function tokenIdFromMintReceipt(receipt: Pick<TransactionReceipt, "logs">): bigint | null {
  for (const log of receipt.logs) {
    const topic0 = log.topics[0]?.toLowerCase();
    const from = log.topics[1]?.toLowerCase();
    // `from` is a 32-byte topic WORD (0x + 64 hex), not the 20-byte address
    // form — comparing against the 42-char address NEVER matches and every
    // mint would fail 'could not decode minted tokenId' (caught by
    // adapter-gaps.test.ts; live mints never reached the receipt before).
    if (topic0 === erc721TransferTopic && from === `0x${"0".repeat(64)}`) {
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

export const AdapterLive = Layer.effect(
  AdapterService,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const rpcUrl = config.rpcUrl || DEFAULT_RPC;
    // Generous transport timeout + retries: the public RPCs (Base
    // mainnet.base.org, Robinhood) are slow AND rate-limited under load and
    // heavy pool-state reads (StateView slot0/liquidity) can exceed viem's
    // default 10s or hit 429s — every timeout/rate-limit threw evaluatePool,
    // counted the pool as failed + core-data failure, and latched pauses.
    // Retries are config-driven (RPC_RETRY_COUNT, default 4) so 429s/5xx on
    // shared public endpoints don't churn cycles. A configured fallback RPC is
    // wrapped in a viem fallback() transport for cross-endpoint resilience.
    const retryCount = config.rpcRetryCount ?? 4;
    const rawTransport = () => http(rpcUrl, { timeout: 45_000, retryCount: retryCount });
    const publicClient = createPublicClient({
      // RPC_FALLBACK_URLS (comma-separated) wraps each fallback in a viem
      // fallback() chain: on 429/timeout the primary, the next endpoint
      // (e.g. keyless PublicNode for Robinhood) takes over, keeping scans
      // healthy without a paid RPC key.
      transport:
        config.rpcFallbackUrls.length > 0
          ? fallback([
              rawTransport(),
              ...config.rpcFallbackUrls.map((url) => http(url, { timeout: 45_000, retryCount })),
            ])
          : rawTransport(),
    });

    // Fee-truth two-seat knobs: read the nested SwapMintConfig/ExitProofConfig
    // shapes defensively (the main agent wires them into config-service as
    // optional AppConfig keys); defaults per spec when absent.
    function swapMintSlippageBps(): number {
      // SAFETY: ConfigService carries optional compatibility keys from the
      // nested config schema; this narrow read preserves absent-key defaults.
      const nested = (config as { swapMintConfig?: { maxSwapSlippageBps?: number } })
        .swapMintConfig;
      return nested?.maxSwapSlippageBps ?? 100;
    }
    function simulateBeforeExitEnabled(): boolean {
      // SAFETY: ConfigService carries optional compatibility keys from the
      // nested config schema; this narrow read preserves absent-key defaults.
      const nested = (config as { exitProofConfig?: { simulateBeforeExit?: boolean } })
        .exitProofConfig;
      return nested?.simulateBeforeExit ?? true;
    }

    const account = config.walletPrivateKey
      ? (() => {
          try {
            return privateKeyToAccount(privateKeyHex(config.walletPrivateKey));
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
    const multicall3 = () =>
      getContract({ address: MULTICALL3, abi: multicall3Abi, client: { public: publicClient } });
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

    async function aggregate3Read(
      calls: ReadonlyArray<{
        readonly target: Address;
        readonly callData: Hex;
        readonly allowFailure?: boolean;
      }>,
    ): Promise<ReadonlyArray<{ readonly success: boolean; readonly returnData: Hex }>> {
      const result = await multicall3().read.aggregate3([
        calls.map((call) => ({
          target: call.target,
          allowFailure: call.allowFailure ?? false,
          callData: call.callData,
        })),
      ]);
      return result.map((item) => ({
        success: item.success,
        returnData: item.returnData,
      }));
    }

    async function getDecimals(mint: string): Promise<number> {
      if (isNative(mint)) return 18;
      const mintKey = mint.toLowerCase();
      const cached = decimalsCache.get(mintKey);
      if (cached !== undefined) return cached;
      let decimals: number;
      try {
        decimals = Number(await erc20(getAddress(mint)).read.decimals());
      } catch {
        // Fail closed on a malformed/non-standard ERC-20: guessing 18 here
        // silently mis-prices a 6-decimal token by 12 orders of magnitude.
        // The settlement stablecoin (USDG) and native ETH are the only tokens
        // the engine needs to price without a live decimals() call.
        if (mintKey === STABLECOIN_MINT.toLowerCase()) decimals = 6;
        else
          throw new Error(`decimals() read failed for ${mint}; cannot determine token precision`);
      }
      decimalsCache.set(mintKey, decimals);
      return decimals;
    }

    async function getBalance(mint: string, owner: Address): Promise<bigint> {
      if (isNative(mint)) return publicClient.getBalance({ address: owner });
      return erc20(getAddress(mint)).read.balanceOf([owner]);
    }

    // ─── Live transaction layer ────────────────────────────────────────────────
    // Wallet client exists only when a private key is configured; every
    // broadcast path fails with a clear error instead of crashing in paper mode.
    const walletClient = account
      ? createWalletClient({
          account,
          chain: ROBINHOOD_CHAIN,
          transport: http(rpcUrl, { timeout: 45_000 }),
        })
      : null;

    /** Incrementing nonce cache by address (seeded from the pending count on
     *  first use; entry dropped on send failure so the next attempt re-reads). */
    const nonces = new Map<Address, bigint>();
    async function nextNonce(): Promise<bigint> {
      const owner = requireWallet();
      let nonce = nonces.get(owner);
      if (nonce === undefined) {
        nonce = BigInt(
          await publicClient.getTransactionCount({ address: owner, blockTag: "pending" }),
        );
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

    /** Decode a revert reason (Error(string)) from a viem/RPC error; falls back
     *  to the message text. Used by the pre-broadcast withdraw gate. */
    function decodeRevertReason(e: unknown): string | null {
      const err = isRecord(e) ? e : null;
      const data = typeof err?.data === "string" ? err.data : null;
      if (data && data.length >= 10 && data.slice(0, 10).toLowerCase() === "0x08c379a0") {
        try {
          const [reason] = decodeAbiParameters([{ type: "string" }], sdkHex(`0x${data.slice(10)}`));
          return String(reason).slice(0, 300);
        } catch {
          // fall through to message parsing
        }
      }
      const msg =
        (typeof err?.shortMessage === "string" ? err.shortMessage : null) ??
        (typeof err?.message === "string" ? err.message : null) ??
        String(e);
      const m =
        /reverted with reason string '([^']+)'/i.exec(msg) ??
        /execution reverted with reason: (.+)/i.exec(msg) ??
        /execution reverted: (.+)/i.exec(msg);
      return (m?.[1] ?? msg).replace(/[.]+$/, "").slice(0, 300);
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
      if (!wc)
        throw new Error(
          "live transactions disabled: WALLET_PRIVATE_KEY is not configured (paper mode)",
        );
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
        .catch(async (): Promise<TransactionReceipt> => {
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
      // A mined tx may have minted/burned/moved an NFT — cached ownership is
      // stale the moment our own ENTER/EXIT lands.
      dropEnumerationCache();
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
    async function resolveV4PoolKey(
      poolId: string,
      allowApproximateFallback = true,
    ): Promise<V4PoolKey> {
      const id = poolId.toLowerCase();
      const existing = V4_POOL_REGISTRY[id];
      if (existing && VERIFIED_V4_POOL_IDS.has(id)) {
        return existing;
      }
      // bytes25: first 25 bytes of the poolId, right-padded to a 32-byte word.
      const truncated = poolIdHex(`${id.slice(0, 2 + 50)}${"0".repeat(14)}`);
      try {
        const pm = v4PositionManager();
        const [key] = await pm.read.poolKeys([truncated]);
        if (!key) throw new Error("poolKeys returned empty key");
        const [c0, c1, feeRaw, spacingRaw, hooksRaw] = key;
        // SAFETY (on-chain audit): poolKeys can return an all-zero tuple for
        // unknown ids. Native ETH is legitimately address(0), but v4 sorts it
        // as currency0; hookless pools and zero-fee pools are also valid.
        if (!c0 || !c1 || !hooksRaw) {
          throw new Error("poolKeys returned an incomplete key");
        }
        const resolved: V4PoolKey = {
          currency0: getAddress(c0),
          currency1: getAddress(c1),
          fee: Number(feeRaw),
          tickSpacing: Number(spacingRaw),
          hooks: getAddress(hooksRaw),
        };
        if (!isResolvedV4PoolKeyValid(resolved)) {
          throw new Error("poolKeys returned an invalid/zero key");
        }
        registerVerifiedV4Pool(id, resolved);
        return resolved;
      } catch (e) {
        if (existing && allowApproximateFallback) return existing;
        throw new Error(`v4 pool ${id} key unresolved on-chain (${underlyingErrorMessage(e)})`);
      }
    }

    /** Engine PoolState for a resolved v4 pool from already-read StateView
     *  data (shared by getPoolState's v4 branch and the batched path). */
    async function buildV4PoolState(
      poolId: string,
      key: V4PoolKey,
      slot0: readonly [bigint, number, number, number],
      liquidity: bigint,
    ): Promise<PoolState> {
      const tick = Number(slot0[1]);
      const [decimals0Result, decimals1Result, price0Result, price1Result] =
        await Promise.allSettled([
          tokenDecimalsOf(key.currency0),
          tokenDecimalsOf(key.currency1),
          priceUsd(key.currency0),
          priceUsd(key.currency1),
        ]);
      return {
        address: poolId.toLowerCase(),
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
        tokenXDecimals: settledFiniteNumber(decimals0Result),
        tokenYDecimals: settledFiniteNumber(decimals1Result),
        tokenXPriceUsd: settledPositiveNumber(price0Result),
        tokenYPriceUsd: settledPositiveNumber(price1Result),
        liquidity,
        timestamp: Date.now(),
        statsSource: "heuristic" as const,
      };
    }

    /** Batched pool state + bins for MANY pools (v3 + v4 mixed). Plain-async
     *  core shared by the getPoolStatesWithBins / getBinArrays service
     *  methods; per-pool cost is ~2 round trips regardless of pool count
     *  within a chunk. Pools whose reads fail are absent — callers treat
     *  that as a skip, never as "pool gone". */
    async function getPoolStatesWithBinsImpl(
      poolAddresses: ReadonlyArray<string>,
    ): Promise<ReadonlyMap<string, { state: PoolState; bins: BinArray | null }>> {
      const out = new Map<string, { state: PoolState; bins: BinArray | null }>();
      // Split by pool kind: 42-char addresses are v3 pools, 66-char 0x-hex
      // strings are v4 poolIds.
      const v3: Address[] = [];
      const v4: string[] = [];
      for (const p of poolAddresses) {
        if (p.length === 66) v4.push(p);
        else v3.push(getAddress(p));
      }
      // v4 keys resolve through the registry/poolKeys (self-caching), so key
      // resolution is warm after the first cycle per pool.
      const v4Keys = await Promise.all(
        v4.map((p) =>
          resolveV4PoolKey(p)
            .then((key) => ({ poolId: p.toLowerCase(), key }))
            .catch(() => null),
        ),
      );
      const resolvedV4 = v4Keys.filter((k): k is NonNullable<typeof k> => k !== null);
      // All v4 StateView reads in ONE aggregate3 (getSlot0 + getLiquidity per
      // pool).
      const v4Results =
        resolvedV4.length > 0
          ? await aggregate3Read(
              resolvedV4.flatMap(({ poolId }) => [
                {
                  target: V4_STATE_VIEW,
                  allowFailure: true,
                  callData: encodeFunctionData({
                    abi: v4StateViewAbi,
                    functionName: "getSlot0",
                    args: [poolIdHex(poolId)],
                  }),
                },
                {
                  target: V4_STATE_VIEW,
                  allowFailure: true,
                  callData: encodeFunctionData({
                    abi: v4StateViewAbi,
                    functionName: "getLiquidity",
                    args: [poolIdHex(poolId)],
                  }),
                },
              ]),
            ).catch(() => null)
          : null;
      const v3States = await v3PoolStates(v3).catch(() => new Map<string, PoolState>());
      const v3Bins = await v3BinArrays(v3).catch(() => new Map<string, BinArray | null>());
      for (const [i, entry] of resolvedV4.entries()) {
        const slot0Result = v4Results?.[i * 2];
        const liquidityResult = v4Results?.[i * 2 + 1];
        if (
          slot0Result === undefined ||
          liquidityResult === undefined ||
          !slot0Result.success ||
          !liquidityResult.success
        ) {
          continue;
        }
        try {
          const slot0 = decodeFunctionResult({
            abi: v4StateViewAbi,
            functionName: "getSlot0",
            data: slot0Result.returnData,
          });
          const liquidity = decodeFunctionResult({
            abi: v4StateViewAbi,
            functionName: "getLiquidity",
            data: liquidityResult.returnData,
          });
          const tick = Number(slot0[1]);
          const state = await buildV4PoolState(entry.poolId, entry.key, slot0, liquidity);
          out.set(entry.poolId, {
            state,
            bins: {
              lowerBinId: tick,
              upperBinId: tick,
              bins: [
                {
                  binId: tick,
                  reserveX: slot0[0],
                  reserveY: slot0[0],
                  liquiditySupply: 0n,
                  price: tickToPrice(tick),
                },
              ],
              activeBinId: tick,
              binStep: entry.key.tickSpacing,
              reservesKnown: true,
            },
          });
        } catch {
          continue;
        }
      }
      for (const [key, state] of v3States) {
        out.set(key, { state, bins: v3Bins.get(key) ?? null });
      }
      return out;
    }

    /** Pool state for a v4 pool (poolId) via the StateView — feeds the pure
     *  builders. PoolKey comes from the registry (poolId is one-way). */
    async function v4PoolQuoteStateForKey(poolId: string, key: V4PoolKey): Promise<PoolQuoteState> {
      const stateView = v4StateView();
      const poolIdHexValue = poolIdHex(poolId.toLowerCase());
      const [slot0, liquidity] = await Promise.all([
        stateView.read.getSlot0([poolIdHexValue]),
        stateView.read.getLiquidity([poolIdHexValue]),
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

    async function v4PoolQuoteState(
      poolId: string,
      allowApproximateFallback = true,
    ): Promise<PoolQuoteState> {
      const key = await resolveV4PoolKey(poolId, allowApproximateFallback);
      return v4PoolQuoteStateForKey(poolId, key);
    }

    /** Find a direct v3 pool between two mints (native maps to WETH9). All
     *  fee tiers in ONE aggregate3 (was up to 4 sequential factory reads). */
    async function findV3PoolForPair(
      tokenA: string,
      tokenB: string,
    ): Promise<{ pool: Address; fee: number } | null> {
      const a = isNative(tokenA) ? WETH9 : getAddress(tokenA);
      const b = isNative(tokenB) ? WETH9 : getAddress(tokenB);
      const fees = [3000, 500, 10_000, 100] as const;
      const results = await aggregate3Read(
        fees.map((fee) => ({
          target: V3_FACTORY,
          allowFailure: true,
          callData: encodeFunctionData({
            abi: v3FactoryAbi,
            functionName: "getPool",
            args: [a, b, fee],
          }),
        })),
      );
      for (const [i, fee] of fees.entries()) {
        const result = results[i];
        if (result === undefined || !result.success) continue;
        try {
          const pool = decodeFunctionResult({
            abi: v3FactoryAbi,
            functionName: "getPool",
            data: result.returnData,
          });
          if (pool && pool.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
            return { pool, fee };
          }
        } catch {
          continue;
        }
      }
      return null;
    }

    /**
     * Cycle-scoped enumeration shared by every caller in one scan cycle
     * (reconcile → getAllWalletPositions, equity mark → getAllPositionValuesUsd,
     * per-pool checks → getPositions/getPositionValueUsd). Unshared, the same
     * wallet was fully enumerated 2–3× per cycle — the largest remaining RPC
     * offender after price batching. TTL 30s ≈ one cycle's reuse window; an
     * external mint/burn is picked up next cycle, and our own successful
     * broadcasts drop the cache immediately (see sendTx).
     */
    const enumerationCache = new Map<
      string,
      { v3: ReadonlyArray<Position>; v4: ReadonlyArray<Position>; at: number }
    >();

    async function positionsEnumeration(
      owner: Address,
    ): Promise<{ v3: ReadonlyArray<Position>; v4: ReadonlyArray<Position> }> {
      const ownerKey = owner.toLowerCase();
      const cached = enumerationCache.get(ownerKey);
      if (cached !== undefined && Date.now() - cached.at < ENUMERATION_CACHE_TTL_MS) {
        return { v3: cached.v3, v4: cached.v4 };
      }
      const [v3, v4] = await Promise.all([v3PositionsOf(owner), v4PositionsOf(owner)]);
      enumerationCache.set(ownerKey, { v3, v4, at: Date.now() });
      return { v3, v4 };
    }

    function dropEnumerationCache(): void {
      enumerationCache.clear();
    }

    /** Find a registered v4 pool for a token pair (either order). */
    function findV4PoolsForPair(
      tokenA: string,
      tokenB: string,
    ): ReadonlyArray<{ poolId: string; key: V4PoolKey }> {
      const a = isNative(tokenA)
        ? "0x0000000000000000000000000000000000000000"
        : getAddress(tokenA).toLowerCase();
      const b = isNative(tokenB)
        ? "0x0000000000000000000000000000000000000000"
        : getAddress(tokenB).toLowerCase();
      const matches: Array<{ poolId: string; key: V4PoolKey }> = [];
      for (const [poolId, key] of Object.entries(V4_POOL_REGISTRY)) {
        const k0 = key.currency0.toLowerCase();
        const k1 = key.currency1.toLowerCase();
        if ((k0 === a && k1 === b) || (k0 === b && k1 === a)) {
          matches.push({ poolId, key });
        }
      }
      return matches;
    }

    function usdOf(amountAtomic: bigint, decimals: number, priceUsd: number): number {
      return (Number(amountAtomic) / 10 ** decimals) * (priceUsd || 0);
    }

    /**
     * Full exit of a position (v3: decreaseLiquidity+collect+burn; v4:
     * burn+TAKE_PAIR) returning the exact reclaimed amounts via balance
     * deltas. Shared by exitPosition and rebalancePosition.
     */
    /**
     * Build the exact burn+collect calldata the engine broadcasts for a
     * position exit (v3: decreaseLiquidity+collect+burn multicall; v4:
     * burn+TAKE_PAIR). Shared by reclaimPosition (broadcast) and
     * simulateWithdraw (eth_call dry-run only — the pre-broadcast fail-closed
     * gate). Never broadcasts.
     */
    async function buildPositionExitCalldata(
      poolAddress: string,
      positionPubKey: string,
    ): Promise<{
      tokenId: bigint;
      isV4: boolean;
      token0: Address;
      token1: Address;
      decimals0: number;
      decimals1: number;
      calldata: Hex;
      value: bigint;
      pendingFeeXAtomic: bigint;
      pendingFeeYAtomic: bigint;
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
      return {
        tokenId,
        isV4,
        token0,
        token1,
        decimals0,
        decimals1,
        calldata,
        value,
        pendingFeeXAtomic,
        pendingFeeYAtomic,
      };
    }

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
      const exit = await buildPositionExitCalldata(poolAddress, positionPubKey);
      const { token0, token1, decimals0, decimals1, isV4 } = exit;
      const [pre0, pre1] = await Promise.all([
        getBalance(token0, owner),
        getBalance(token1, owner),
      ]);
      const { txSignature } = await sendTx({
        to: isV4 ? V4_POSITION_MANAGER : V3_NPM,
        data: exit.calldata,
        value: exit.value,
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
        pendingFeeXAtomic: exit.pendingFeeXAtomic,
        pendingFeeYAtomic: exit.pendingFeeYAtomic,
        isV4,
      };
    }

    /** eth_call dry-run of the EXACT exit calldata (never broadcasts). The
     *  pre-broadcast fail-closed gate for exitPosition/rebalancePosition —
     *  gated by ExitProofConfig.simulateBeforeExit (default true). */
    async function simulateWithdrawInternal(
      poolAddress: string,
      positionPubKey: string,
    ): Promise<{ ok: boolean; reason: string | null }> {
      try {
        const owner = requireWallet();
        const exit = await buildPositionExitCalldata(poolAddress, positionPubKey);
        await publicClient.call({
          account: owner,
          to: exit.isV4 ? V4_POSITION_MANAGER : V3_NPM,
          data: exit.calldata,
          value: exit.value,
        });
        return { ok: true, reason: null };
      } catch (e) {
        return { ok: false, reason: decodeRevertReason(e) };
      }
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
      const v4InputAddress = isNative(tokenIn)
        ? "0x0000000000000000000000000000000000000000"
        : getAddress(tokenIn).toLowerCase();
      const v4Quotes = await Promise.all(
        findV4PoolsForPair(tokenIn, tokenOut).map(async ({ poolId }) => {
          try {
            // Execution must use an on-chain-resolved PoolKey. Krystal's
            // fee/tickSpacing values are display approximations and may hash
            // to a different pool. Quote every exact-key candidate and keep
            // the best output so a zombie first-registration cannot mask a
            // healthy pool for the same pair.
            const key = await resolveV4PoolKey(poolId, false);
            const state = await v4PoolQuoteStateForKey(poolId, key);
            const zeroForOne = v4InputAddress === state.token0.toLowerCase();
            const { outAmountAtomic } = await quoteSwapInternal(state, zeroForOne, amountIn);
            return { poolId, key, state, zeroForOne, outAmountAtomic };
          } catch {
            return null;
          }
        }),
      );
      const v4 = selectHighestOutputQuote(
        v4Quotes.filter((quote): quote is NonNullable<typeof quote> => quote !== null),
      );
      if (v4 !== null) {
        return {
          outAmountAtomic: v4.outAmountAtomic,
          route: {
            router: "universalrouter",
            target: UNIVERSAL_ROUTER,
            poolId: v4.poolId,
            poolKey: v4.key,
            zeroForOne: v4.zeroForOne,
            decimals0: v4.state.token0Decimals,
            decimals1: v4.state.token1Decimals,
          },
        };
      }
      const v3 = await findV3PoolForPair(tokenIn, tokenOut);
      if (!v3) {
        throw new Error(`no direct v3 or registered v4 pool for ${tokenIn} -> ${tokenOut}`);
      }
      const state = await v3PoolQuoteState(v3.pool);
      const v3InputAddress = isNative(tokenIn)
        ? WETH9.toLowerCase()
        : getAddress(tokenIn).toLowerCase();
      const zeroForOne = v3InputAddress === state.token0.toLowerCase();
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
      return buildV3SwapCalldataForChain({
        tokenIn: isNative(tokenIn) ? WETH9 : getAddress(tokenIn),
        tokenOut: isNative(tokenOut) ? WETH9 : getAddress(tokenOut),
        fee: route.fee,
        recipient: requireWallet(),
        amountIn,
        amountOutMinimum,
      });
    }

    /** Address the router actually pulls for a mint: v3 swaps wrap native
     *  ETH (WETH9); v4 swaps use address-zero native as a first-class
     *  currency. */
    function routerInputAddress(mint: string, router: SwapRoute["router"]): Address {
      if (router === "swaprouter02") return isNative(mint) ? WETH9 : getAddress(mint);
      return isNative(mint) ? "0x0000000000000000000000000000000000000000" : getAddress(mint);
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
     * Calldata for a single-hop swap through `route`. v3 routes use the v2
     * SwapRouter02 encoding (7-field exactInputSingle, NO deadline — the
     * probe-verified live 4663 deployment carries selector 0x04e45aaf, not
     * the 8-field legacy one); v4 routes use the UniversalRouter V4_SWAP
     * encoding. Native input settles via msg.value on both routers.
     */
    function buildSwapCalldataV2(
      route: SwapRoute,
      tokenIn: string,
      tokenOut: string,
      amountIn: bigint,
      amountOutMinimum: bigint,
      deadline: number,
    ): Hex {
      if (route.router === "swaprouter02") {
        return buildV3SwapCalldataForChain({
          tokenIn: routerInputAddress(tokenIn, "swaprouter02"),
          tokenOut: routerInputAddress(tokenOut, "swaprouter02"),
          fee: route.fee,
          recipient: requireWallet(),
          amountIn,
          amountOutMinimum,
          deadline,
        });
      }
      return buildUniversalRouterV4SwapCalldata({
        poolKey: route.poolKey,
        zeroForOne: route.zeroForOne,
        amountIn,
        amountOutMinimum,
        deadline,
      });
    }

    /** Broadcast a quoted single-hop swap (sendTx dry-runs the eth_call first).
     *  Native input passes msg.value and needs no approval; ERC20 input gets
     *  the route's approval (Permit2 for v4, plain ERC-20 for v3). */
    async function executeSwapViaRoute(
      route: SwapRoute,
      tokenIn: string,
      tokenOut: string,
      amountIn: bigint,
      amountOutMinimum: bigint,
    ): Promise<string> {
      const deadline = Math.floor(Date.now() / 1000) + 300; // swaps: 5-min deadline
      const calldata = buildSwapCalldataV2(
        route,
        tokenIn,
        tokenOut,
        amountIn,
        amountOutMinimum,
        deadline,
      );
      const value = isNative(tokenIn) ? amountIn : 0n;
      if (!isNative(tokenIn)) {
        await approveInputForRoute(tokenIn, route, amountIn);
      }
      const { txSignature } = await sendTx({ to: route.target, data: calldata, value });
      return txSignature;
    }

    /** (dp8) Pre-broadcast entry simulation. The funding path broadcasts the
     * deficit swap + WETH wrap + approvals before the mint's own sendTx
     * dry-run, so a doomed mint (fork NPM storage bug, hook revert, token
     * restriction) costs gas and leaves the swapped leg trapped in the pool
     * (observed 2026-08-14: ~$4.7 on the native CollectionToken pool). This
     * eth_calls the EXACT mint with the wallet's projected post-swap /
     * post-wrap state injected (OZ storage layout: _balances slot 0,
     * _allowances slot 1) and the caller aborts BEFORE any broadcast when it
     * reverts. Fail-closed: any simulation error aborts the entry. v4 mints
     * pull via Permit2 (not the ERC20 allowance), so their sim fails on the
     * permit pull until the permit path is added — the desired fail-closed
     * for the currently-broken v4 path. */
    async function dryRunEntryMintSimulation(input: {
      poolAddress: string;
      state: PoolQuoteState;
      amount0: bigint;
      amount1: bigint;
      lowerBinId: number;
      upperBinId: number;
      isV4: boolean;
      owner: Address;
      injectedTokenBalance: bigint;
      injectedWethBalance: bigint;
      deadline: number;
    }): Promise<{ ok: boolean; reason?: string }> {
      try {
        const {
          poolAddress,
          state,
          amount0,
          amount1,
          lowerBinId,
          upperBinId,
          isV4,
          owner,
          deadline,
        } = input;
        const rangeOverride =
          lowerBinId && upperBinId && lowerBinId < upperBinId
            ? { tickLower: lowerBinId, tickUpper: upperBinId }
            : {};
        const target = isV4 ? V4_POSITION_MANAGER : V3_NPM;
        const built = isV4
          ? buildV4MintCalldata({
              poolKey: await resolveV4PoolKey(poolAddress),
              sqrtPriceX96: state.sqrtPriceX96,
              tickCurrent: state.tickCurrent,
              token0Decimals: state.token0Decimals,
              token1Decimals: state.token1Decimals,
              amount0,
              amount1,
              recipient: owner,
              deadline,
              slippageToleranceBps: 50,
              ...rangeOverride,
            })
          : buildV3MintCalldata({
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
              slippageToleranceBps: 50,
              ...rangeOverride,
            });
        const storageSlot = (key: Address, mapSlot: bigint): `0x${string}` =>
          keccak256(
            encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, mapSlot]),
          );
        const allowanceSlot = (spender: Address): `0x${string}` => {
          const inner = keccak256(
            encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [spender, 1n]),
          );
          return keccak256(
            encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [owner, inner]),
          );
        };
        const MAX = toHex(2n ** 256n - 1n);
        const nativeLike = (m: string): boolean =>
          isNative(m) || getAddress(m).toLowerCase() === WETH9.toLowerCase();
        const tokenAddr = nativeLike(state.token0) ? state.token1 : state.token0;
        // Merge all storage diffs per address: viem rejects a state override
        // with the same account listed twice (observed in adapter-gaps tests).
        const storageByAddress = new Map<string, Record<string, Hex>>();
        const addStorage = (addr: Address, slot: `0x${string}`, value: Hex): void => {
          const key = getAddress(addr).toLowerCase();
          const existing = storageByAddress.get(key) ?? {};
          existing[slot] = value;
          storageByAddress.set(key, existing);
        };
        if (input.injectedTokenBalance > 0n) {
          addStorage(tokenAddr, storageSlot(owner, 0n), toHex(input.injectedTokenBalance));
        }
        if (input.injectedWethBalance > 0n) {
          addStorage(WETH9, storageSlot(owner, 0n), toHex(input.injectedWethBalance));
        }
        if (isV4) {
          // v4 pulls via Permit2 (not ERC20 allowance): inject a max
          // PackedAllowance (amount + far-future expiration) for the
          // non-native leg so the mint simulation is accurate.
          const inner1 = keccak256(
            encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [target, 0n]),
          );
          const inner2 = keccak256(
            encodeAbiParameters(
              [{ type: "address" }, { type: "bytes32" }],
              [getAddress(tokenAddr), inner1],
            ),
          );
          const permitSlot = keccak256(
            encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [owner, inner2]),
          );
          const permitValue = toHex((2n ** 160n - 1n) | (0xffffn << 160n));
          addStorage(PERMIT2, permitSlot, permitValue);
        } else {
          addStorage(tokenAddr, allowanceSlot(target), MAX);
          addStorage(WETH9, allowanceSlot(target), MAX);
        }
        const overrides: Array<{ address: Address; storage: Record<string, Hex> }> = [
          ...storageByAddress.entries(),
        ].map(([address, storage]) => ({ address: getAddress(address), storage }));
        await publicClient.call({
          account: owner,
          to: target,
          data: built.calldata,
          ...(built.value > 0n ? { value: built.value } : {}),
          ...(overrides.length > 0 ? { stateOverride: overrides } : {}),
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: underlyingErrorMessage(e).slice(0, 200) };
      }
    }

    /**
     * enterPosition last-resort funding branch: the wallet holds NATIVE ETH but
     * neither pool leg is fundable. When exactly one leg is native/WETH and a
     * verified ETH → missing-leg route exists: quote at realistic size,
     * eth_call-probe the exact swap calldata (the wallet funds the probe, so
     * the RPC's balance check is real), then broadcast the deficit swap and
     * let the caller proceed with the normal two-sided mint. Returns false
     * (never throws) on ANY failure — probe revert, missing pool, unpriceable
     * leg, insufficient native — so the caller falls back to the existing
     * 'wallet can fund neither leg' error. A failure is never masked.
     */
    async function swapToFundDeficit(params: {
      owner: Address;
      state: PoolQuoteState;
      amount0: bigint;
      amount1: bigint;
      halfUsd: number;
      nativeBal: bigint;
    }): Promise<"swapped" | "no-route" | "reverted"> {
      const { owner, state, amount0, amount1, halfUsd, nativeBal } = params;
      // Exactly one leg must be native (ETH) or WETH9 — one swap funds the
      // missing ERC20 leg; a two-ERC20 pool needs two swaps (not attempted).
      const leg0Native = isNative(state.token0) || getAddress(state.token0) === WETH9;
      const leg1Native = isNative(state.token1) || getAddress(state.token1) === WETH9;
      if (leg0Native === leg1Native) return "no-route";
      const missingLeg = leg0Native ? state.token1 : state.token0;
      const missingAmount = leg0Native ? amount1 : amount0;
      const nativeLegAmount = leg0Native ? amount0 : amount1;
      if (missingAmount <= 0n) return "no-route";
      const nativePrice = await priceUsd(NATIVE_MINT);
      if (!(nativePrice > 0)) return "no-route";
      const slippageBps = swapMintSlippageBps();
      const outFloorFactor = 10_000n - BigInt(slippageBps);
      try {
        // Input converges so the slippage-floored output covers the FULL
        // missing-leg deficit: the pool fee means the naive half-sized input
        // quotes ~fee% short of the deficit. 4 iterations of
        // nextIn = amountIn * needed/out converge (out ∝ amountIn).
        let amountIn = usdToAtomic(halfUsd, nativePrice, 18);
        let route: SwapRoute | null = null;
        let outAmountAtomic = 0n;
        if (amountIn <= 0n) return "no-route";
        for (let attempt = 0; attempt < 4; attempt++) {
          const q = await quotePair(NATIVE_MINT, missingLeg, amountIn);
          route = q.route;
          outAmountAtomic = q.outAmountAtomic;
          if (outAmountAtomic <= 0n) return "no-route";
          if ((outAmountAtomic * outFloorFactor) / 10_000n >= missingAmount) break;
          const needed = (missingAmount * 10_000n) / outFloorFactor;
          const nextIn = (amountIn * needed) / outAmountAtomic + 1n;
          if (nextIn <= amountIn) return "no-route";
          amountIn = nextIn;
        }
        if (!route) return "no-route";
        const amountOutMinimum = (outAmountAtomic * outFloorFactor) / 10_000n;
        // Integer-floor fixed point: the quote can sit exactly ONE raw unit
        // below the deficit (out × 0.99 floors short). Over-input ~1% and
        // re-quote once so the slippage-floored output covers the FULL
        // deficit — the mint pulls the full missing leg, so the swap must
        // land at or above it, never one unit under.
        if (amountOutMinimum < missingAmount) {
          const bumped = (amountIn * 101n) / 100n + 1n;
          const q2 = await quotePair(NATIVE_MINT, missingLeg, bumped);
          if (
            q2.outAmountAtomic > outAmountAtomic &&
            (q2.outAmountAtomic * outFloorFactor) / 10_000n >= missingAmount
          ) {
            route = q2.route;
            outAmountAtomic = q2.outAmountAtomic;
            amountIn = bumped;
          }
        }
        const finalMinimum = (outAmountAtomic * outFloorFactor) / 10_000n;
        if (finalMinimum < missingAmount) return "no-route";
        // The swap spends native AND the mint needs the native leg from the
        // same balance — both must fit (gas is handled by the dry-run).
        if (nativeBal < amountIn + nativeLegAmount) return "no-route";
        const deadline = Math.floor(Date.now() / 1000) + 300;
        const calldata = buildSwapCalldataV2(
          route,
          NATIVE_MINT,
          missingLeg,
          amountIn,
          amountOutMinimum,
          deadline,
        );
        // (a) eth_call-probe at realistic size before anything broadcasts.
        // DECODE the router's exactInputSingle output: a reverting OR
        // zero-output probe means the route is not executable (rule 5: never
        // enter with an unproven route). The on-chain simulation is the
        // authority — the model quote above only sizes the input.
        const probeResult = await publicClient.call({
          account: owner,
          to: route.target,
          data: calldata,
          value: amountIn,
        });
        if (probeResult.data === undefined) return "no-route";
        const probeOut = decodeAbiParameters([{ type: "uint256" }], probeResult.data)[0] ?? 0n;
        if (probeOut <= 0n) return "no-route";
        // (b) swap the deficit leg (sendTx re-dry-runs + broadcasts).
        await executeSwapViaRoute(route, NATIVE_MINT, missingLeg, amountIn, amountOutMinimum);
        logger.info("enterPosition swap-to-fund", {
          missingLeg: missingLeg.slice(0, 6),
          amountIn: amountIn.toString(),
          amountOutMinimum: amountOutMinimum.toString(),
        });
        return "swapped";
      } catch (e) {
        logger.warn("enterPosition swap-to-fund probe/broadcast failed", {
          error: underlyingErrorMessage(e),
        });
        return "reverted";
      }
    }

    /**
     * USD price of a mint. Stablecoin → 1. Otherwise derive from a v3 pool
     * against the stablecoin (3 fee tiers), then fall back to 0 (fail-open —
     * callers treat 0 as "unpriceable"). GeckoTerminal on Robinhood Chain is
     * a follow-up; pool-derived prices are real on-chain values.
     */
    /** Raw liquidity floor for a v3 pool to be a trusted price source
     *  (wei units). Dead/dust pools read garbage prices for meme tokens —
     *  the LEMON/USDG pool had liquidity 0 yet priced LEMON 100x off the
     *  liquid WETH route. */
    const MIN_POOL_LIQUIDITY_FOR_PRICE = 1_000_000_000_000n;

    async function priceUsd(mint: string): Promise<number> {
      if (mint.toLowerCase() === STABLECOIN_MINT.toLowerCase()) return 1;
      const mintKey = mint.toLowerCase();
      // TTL cache: pricing one unknown token costs up to ~3 multicall round
      // trips, and every scan cycle re-prices the same pool legs. The public
      // RPC already rate-limits us (670+ HTTP 429s logged) — a 5-minute TTL
      // keeps USD marks fresh enough for gates/marks while cutting repeat
      // lookups to zero.
      const cached = priceCache.get(mintKey);
      if (cached !== undefined && Date.now() - cached.at < PRICE_CACHE_TTL_MS) {
        return cached.price;
      }
      // Native ETH is WETH-paired in v3 pools.
      const price = await priceUsdViaV3Pool(isNative(mint) ? WETH9 : getAddress(mint));
      if (priceCache.size >= PRICE_CACHE_MAX_ENTRIES) {
        // Bounded memory under meme churn: drop expired entries; when nothing
        // has expired, drop the oldest quarter.
        const now = Date.now();
        const entries = [...priceCache.entries()].sort((a, b) => a[1].at - b[1].at);
        let removed = 0;
        for (const [key, entry] of entries) {
          if (removed >= PRICE_CACHE_MAX_ENTRIES / 4) break;
          if (now - entry.at >= PRICE_CACHE_TTL_MS) {
            priceCache.delete(key);
            removed++;
          }
        }
        while (priceCache.size >= PRICE_CACHE_MAX_ENTRIES) {
          const oldest = entries[removed];
          if (oldest === undefined) break;
          priceCache.delete(oldest[0]);
          removed++;
        }
      }
      priceCache.set(mintKey, { price, at: Date.now() });
      return price;
    }

    /** Price of `mint` in USDG via the most liquid v3 pool, liquidity-aware.
     *  Walks BOTH the WETH-paired and USDG-paired pools (WETH first) and takes
     *  the highest-liquidity one; pools with zero/dust liquidity are skipped.
     *  The old code priced off the first fee-tier mint/USDG pool with no
     *  liquidity check: dead meme-token pools (e.g. LEMON/USDG at liquidity 0)
     *  read prices 100x+ off the liquid WETH route (LEMON: $0.0007 off the
     *  dead pool vs $0.0013 off WETH/LEMON), which mis-valued positions and
     *  tripped the stop-loss on a healthy position. WETH-paired prices are
     *  converted to USDG via the WETH/USDG pool. The on-chain sqrt price is
     *  the RAW token1/token0 ratio (wei units); scale by
     *  10^(decimals(mint) - decimals(base)) to get base per mint. */
    async function priceUsdViaV3Pool(mint: string): Promise<number> {
      const mintAddr = getAddress(mint).toLowerCase();
      // WETH route first: v3 pools on Robinhood Chain are WETH-paired and
      // liquid; USDG pairs for meme tokens are often dead/abandoned.
      const wethUsd = mint !== WETH9 ? await priceUsd(WETH9) : 0;
      // Discover candidate pools in ONE multicall (was 6 sequential getPool
      // reads — the single worst RPC offender on the public endpoint).
      const feeTiers = [3000, 500, 10_000] as const;
      const bases = [WETH9, STABLECOIN_MINT] as const;
      const factoryResults = await aggregate3Read(
        feeTiers.flatMap((fee) =>
          bases.map((base) => ({
            target: V3_FACTORY,
            callData: encodeFunctionData({
              abi: v3FactoryAbi,
              functionName: "getPool",
              args: [getAddress(mint), getAddress(base), fee],
            }),
          })),
        ),
      );
      const candidates: Array<{ pool: Address; base: string }> = [];
      for (const [index] of feeTiers.entries()) {
        for (const [baseIndex, base] of bases.entries()) {
          const result = factoryResults[index * bases.length + baseIndex];
          if (!result) continue;
          try {
            const pool = decodeFunctionResult({
              abi: v3FactoryAbi,
              functionName: "getPool",
              data: result.returnData,
            });
            if (pool !== "0x0000000000000000000000000000000000000000") {
              candidates.push({ pool: getAddress(pool), base });
            }
          } catch {
            // fall through
          }
        }
      }
      let best: { priceUsd: number; liquidity: bigint } | null = null;
      // All candidates' (token0, slot0, liquidity) in ONE aggregate3 (was one
      // multicall PER candidate). allowFailure keeps per-candidate skips
      // local: a dead pool no longer poisons its siblings.
      if (candidates.length > 0) {
        const stateResults = await aggregate3Read(
          candidates.flatMap((cand) =>
            (["token0", "slot0", "liquidity"] as const).map((functionName) => ({
              target: cand.pool,
              allowFailure: true,
              callData: encodeFunctionData({ abi: v3PoolAbi, functionName }),
            })),
          ),
        );
        const decimals = await getDecimals(mint);
        for (const [index, cand] of candidates.entries()) {
          try {
            const token0Result = stateResults[index * 3];
            const slot0Result = stateResults[index * 3 + 1];
            const liquidityResult = stateResults[index * 3 + 2];
            if (
              token0Result === undefined ||
              slot0Result === undefined ||
              liquidityResult === undefined ||
              !token0Result.success ||
              !slot0Result.success ||
              !liquidityResult.success
            ) {
              continue;
            }
            const token0 = decodeFunctionResult({
              abi: v3PoolAbi,
              functionName: "token0",
              data: token0Result.returnData,
            });
            const slot0 = decodeFunctionResult({
              abi: v3PoolAbi,
              functionName: "slot0",
              data: slot0Result.returnData,
            });
            const liquidity = decodeFunctionResult({
              abi: v3PoolAbi,
              functionName: "liquidity",
              data: liquidityResult.returnData,
            });
            if (liquidity <= MIN_POOL_LIQUIDITY_FOR_PRICE) continue;
            const rawPrice = sqrtPriceX96ToPrice(slot0[0]); // token1/token0 wei ratio
            const baseDecimals = cand.base === WETH9 ? 18 : 6;
            const priceInBase = rawPoolPriceToBasePerMint(
              rawPrice,
              token0.toLowerCase() === mintAddr,
              decimals,
              baseDecimals,
            );
            const priceUsd = cand.base === WETH9 ? priceInBase * wethUsd : priceInBase;
            if (priceUsd > 0 && (best === null || liquidity > best.liquidity)) {
              best = { priceUsd, liquidity };
            }
          } catch {
            continue;
          }
        }
      }
      return best?.priceUsd ?? 0;
    }

    /** Core v3 pool state for MANY pools: all pools' (token0, token1,
     *  tickSpacing, slot0, liquidity) in ONE aggregate3 round trip (was one
     *  multicall per pool), decoded once and shared between the PoolState
     *  and BinArray builders. Pools whose reads fail are absent from the
     *  result — callers treat that as a skip, never as "pool gone". */
    async function v3PoolCoreStates(poolAddresses: ReadonlyArray<Address>): Promise<
      ReadonlyMap<
        string,
        {
          token0: Address;
          token1: Address;
          tickSpacing: number;
          slot0: readonly [bigint, number, number, number, number, number, boolean];
          liquidity: bigint;
        }
      >
    > {
      if (poolAddresses.length === 0) return new Map();
      const calls = ["token0", "token1", "tickSpacing", "slot0", "liquidity"] as const;
      const results = await aggregate3Read(
        poolAddresses.flatMap((poolAddress) =>
          calls.map((functionName) => ({
            target: poolAddress,
            allowFailure: true,
            callData: encodeFunctionData({ abi: v3PoolAbi, functionName }),
          })),
        ),
      );
      const states = new Map<
        string,
        {
          token0: Address;
          token1: Address;
          tickSpacing: number;
          slot0: readonly [bigint, number, number, number, number, number, boolean];
          liquidity: bigint;
        }
      >();
      for (const [index, poolAddress] of poolAddresses.entries()) {
        const base = index * calls.length;
        const token0Result = results[base];
        const token1Result = results[base + 1];
        const spacingResult = results[base + 2];
        const slot0Result = results[base + 3];
        const liquidityResult = results[base + 4];
        if (
          token0Result === undefined ||
          token1Result === undefined ||
          spacingResult === undefined ||
          slot0Result === undefined ||
          liquidityResult === undefined ||
          !token0Result.success ||
          !token1Result.success ||
          !spacingResult.success ||
          !slot0Result.success ||
          !liquidityResult.success
        ) {
          continue;
        }
        states.set(poolAddress.toLowerCase(), {
          token0: decodeFunctionResult({
            abi: v3PoolAbi,
            functionName: "token0",
            data: token0Result.returnData,
          }),
          token1: decodeFunctionResult({
            abi: v3PoolAbi,
            functionName: "token1",
            data: token1Result.returnData,
          }),
          tickSpacing: decodeFunctionResult({
            abi: v3PoolAbi,
            functionName: "tickSpacing",
            data: spacingResult.returnData,
          }),
          slot0: decodeFunctionResult({
            abi: v3PoolAbi,
            functionName: "slot0",
            data: slot0Result.returnData,
          }),
          liquidity: decodeFunctionResult({
            abi: v3PoolAbi,
            functionName: "liquidity",
            data: liquidityResult.returnData,
          }),
        });
      }
      return states;
    }

    /** Populated ticks for MANY v3 pools: all pools' three TickLens word
     *  lookups in ONE aggregate3 (was 3 reads per pool, one pool at a time). */
    async function v3BinArrays(
      poolAddresses: ReadonlyArray<Address>,
    ): Promise<ReadonlyMap<string, BinArray | null>> {
      if (poolAddresses.length === 0) return new Map();
      const coreStates = await v3PoolCoreStates(poolAddresses);
      const lensTargets = poolAddresses.filter((p) => coreStates.has(p.toLowerCase()));
      // Per-pool word window around that pool's OWN active tick: [w-1, w, w+1]
      // where w = activeTick >> 8 (TickLens bitmap words hold 256 ticks).
      const WORDS_PER_POOL = 3;
      const lensCalls = lensTargets.flatMap((poolAddress) => {
        const core = coreStates.get(poolAddress.toLowerCase());
        const word = core === undefined ? 0 : Number(core.slot0[1]) >> 8;
        return [word - 1, word, word + 1].map((w) => ({
          target: V3_TICK_LENS,
          allowFailure: true,
          callData: encodeFunctionData({
            abi: tickLensAbi,
            functionName: "getPopulatedTicksInWord",
            args: [poolAddress, w],
          }),
        }));
      });
      const lensResults =
        lensCalls.length > 0 ? await aggregate3Read(lensCalls).catch(() => null) : null;
      const out = new Map<string, BinArray | null>();
      for (const poolAddress of poolAddresses) {
        const key = poolAddress.toLowerCase();
        const core = coreStates.get(key);
        if (!core) {
          out.set(key, null);
          continue;
        }
        const activeTick = Number(core.slot0[1]);
        const bins: BinData[] = [];
        const lensBase = lensTargets.findIndex((p) => p.toLowerCase() === key) * WORDS_PER_POOL;
        for (let w = 0; w < WORDS_PER_POOL; w++) {
          const result = lensResults?.[lensBase + w];
          if (result === undefined) continue;
          if (!result.success) continue;
          try {
            const populated = parsePopulatedTicks(
              decodeFunctionResult({
                abi: tickLensAbi,
                functionName: "getPopulatedTicksInWord",
                data: result.returnData,
              }),
            );
            for (const p of populated) {
              bins.push({
                binId: Number(p[0]),
                reserveX: p[2],
                reserveY: 0n,
                liquiditySupply: p[2],
                price: tickToPrice(Number(p[0])),
              });
            }
          } catch {
            continue;
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
            reserveX: core.slot0[0],
            reserveY: 0n,
            liquiditySupply: 0n,
            price: tickToPrice(activeTick),
          });
        }
        out.set(key, {
          lowerBinId: bins[0]?.binId ?? activeTick,
          upperBinId: bins[bins.length - 1]?.binId ?? activeTick,
          bins,
          activeBinId: activeTick,
          binStep: core.tickSpacing,
          reservesKnown: true,
        });
      }
      return out;
    }

    /** Engine PoolStates for MANY v3 pools, built from one batched core read
     *  (statsSource heuristic until a GeckoTerminal integration for Robinhood
     *  Chain lands). Pools whose core reads failed are absent. */
    async function v3PoolStates(
      poolAddresses: ReadonlyArray<Address>,
    ): Promise<ReadonlyMap<string, PoolState>> {
      if (poolAddresses.length === 0) return new Map();
      const coreStates = await v3PoolCoreStates(poolAddresses);
      const out = new Map<string, PoolState>();
      const tokenSet = new Set<string>();
      for (const core of coreStates.values()) {
        tokenSet.add(core.token0.toLowerCase());
        tokenSet.add(core.token1.toLowerCase());
      }
      const priceByMint = new Map<string, number>();
      await Promise.all(
        [...tokenSet].map(async (mint) => {
          priceByMint.set(mint, await priceUsd(mint).catch(() => 0));
        }),
      );
      for (const [key, core] of coreStates) {
        const tick = Number(core.slot0[1]);
        const price0 = priceByMint.get(core.token0.toLowerCase()) ?? 0;
        const price1 = priceByMint.get(core.token1.toLowerCase()) ?? 0;
        const tvlUsd = (Number(core.liquidity) / 1e18) * price0 * 4; // rough reserve proxy
        out.set(key, {
          address: key,
          tokenX: core.token0.toLowerCase(),
          tokenY: core.token1.toLowerCase(),
          tokenXSymbol: isNative(core.token0)
            ? "ETH"
            : core.token0.toLowerCase() === WETH9.toLowerCase()
              ? "WETH"
              : "TOKEN",
          tokenYSymbol: isNative(core.token1)
            ? "ETH"
            : core.token1.toLowerCase() === WETH9.toLowerCase()
              ? "WETH"
              : "TOKEN",
          tvlUsd: tvlUsd || 0,
          volume24hUsd: 0,
          fees24hUsd: 0,
          apr: 0,
          activeBinId: tick,
          binStep: core.tickSpacing,
          currentPrice: tickToPrice(tick),
          tokenXDecimals: await tokenDecimalsOf(core.token0).catch(() => 0),
          tokenYDecimals: await tokenDecimalsOf(core.token1).catch(() => 0),
          tokenXPriceUsd: price0,
          tokenYPriceUsd: price1,
          liquidity: core.liquidity,
          timestamp: Date.now(),
          statsSource: "heuristic" as const,
        });
      }
      return out;
    }

    /** One v3 pool read → engine PoolState (statsSource heuristic until a
     *  GeckoTerminal integration for Robinhood Chain lands). */
    async function v3PoolState(poolAddress: Address): Promise<PoolState> {
      const addr = getAddress(poolAddress);
      const state = (await v3PoolStates([addr])).get(addr.toLowerCase());
      if (!state) {
        throw new Error(`v3PoolState: core state read failed for ${poolAddress}`);
      }
      return state;
    }

    /** Bin array = populated ticks around the active tick via TickLens. */
    async function v3BinArray(poolAddress: Address): Promise<BinArray> {
      const bins = await v3BinArrays([getAddress(poolAddress)]);
      const result = bins.get(poolAddress.toLowerCase());
      if (result === null || result === undefined) {
        throw new Error(`v3BinArray: read failed for ${poolAddress}`);
      }
      return result;
    }

    /** v3 positions of an owner (NPM is an ERC721 enumerable). Fully batched:
     *  balanceOf → one aggregate3 for all tokenIds → one for all positions()
     *  → one for all pool resolutions — 4 round trips regardless of count
     *  (was 2–4 strictly sequential reads PER position). */
    async function v3PositionsOf(
      owner: Address,
      poolFilter?: string,
    ): Promise<ReadonlyArray<Position>> {
      const balance = Number(await v3Npm().read.balanceOf([owner]));
      if (balance === 0) return [];
      const indices = Array.from({ length: balance }, (_, i) => i);
      const idResults = await aggregate3Read(
        indices.map((i) => ({
          target: V3_NPM,
          callData: encodeFunctionData({
            abi: v3NpmAbi,
            functionName: "tokenOfOwnerByIndex",
            args: [owner, BigInt(i)],
          }),
        })),
      );
      const tokenIds = indices.map((i) => {
        const result = idResults[i];
        if (result === undefined || !result.success) {
          throw new Error(`v3PositionsOf: failed to read tokenId ${i}/${balance} for ${owner}`);
        }
        return decodeFunctionResult({
          abi: v3NpmAbi,
          functionName: "tokenOfOwnerByIndex",
          data: result.returnData,
        });
      });
      const posResults = await aggregate3Read(
        tokenIds.map((tokenId) => ({
          target: V3_NPM,
          callData: encodeFunctionData({
            abi: v3NpmAbi,
            functionName: "positions",
            args: [tokenId],
          }),
        })),
      );
      const parsed = tokenIds.map((tokenId, i) => {
        const result = posResults[i];
        if (result === undefined || !result.success) {
          // Fail the WHOLE enumeration instead of silently skipping: a
          // transient read failure here would look like "position gone" to
          // reconcile, which would drop a live position from tracking and
          // leave it unmanaged. The reconcile caller catches this and skips
          // the cycle (fail-open — nothing is dropped or adopted).
          throw new Error(`v3PositionsOf: failed to read position ${tokenId} for ${owner}`);
        }
        return {
          tokenId,
          p: decodeFunctionResult({
            abi: v3NpmAbi,
            functionName: "positions",
            data: result.returnData,
          }),
        };
      });
      const poolResults = await aggregate3Read(
        parsed.map(({ p }) => ({
          target: V3_FACTORY,
          callData: encodeFunctionData({
            abi: v3FactoryAbi,
            functionName: "getPool",
            args: [p[2], p[3], p[4]],
          }),
        })),
      );
      const positions: Position[] = [];
      for (const [i, { tokenId, p }] of parsed.entries()) {
        const poolResult = poolResults[i];
        if (poolResult === undefined || !poolResult.success) {
          throw new Error(`v3PositionsOf: failed to resolve pool of position ${tokenId}`);
        }
        const pool = decodeFunctionResult({
          abi: v3FactoryAbi,
          functionName: "getPool",
          data: poolResult.returnData,
        });
        if (poolFilter && pool.toLowerCase() !== poolFilter.toLowerCase()) continue;
        positions.push({
          id: tokenId.toString(),
          poolAddress: pool.toLowerCase(),
          poolName: `${p[2].slice(0, 6)}/${p[3].slice(0, 6)}`,
          tokenX: p[2].toLowerCase(),
          tokenY: p[3].toLowerCase(),
          lowerBinId: Number(p[5]),
          upperBinId: Number(p[6]),
          liquidityShares: p[7],
          // Owed fees: a liquidity-0 shell can still hold claimable fees —
          // carried so reconcile never silently abandons them on drop.
          tokensOwedX: p[10],
          tokensOwedY: p[11],
          depositedUsd: 0,
          currentValueUsd: 0,
          unrealizedPnlUsd: 0,
          feesEarnedUsd: 0,
          openedAt: Date.now(),
        });
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
        const order = (log.blockNumber ?? 0n) * 1_000_000n + BigInt(log.logIndex ?? 0);
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
      const ownedIds = await v4OwnedTokenIds(owner);
      if (ownedIds.length === 0) return [];
      // All per-token reads in ONE aggregate3 (was 2 sequential reads per
      // tokenId): getPoolAndPositionInfo + getPositionLiquidity per id.
      const results = await aggregate3Read(
        ownedIds.flatMap((tokenId) => [
          {
            target: V4_POSITION_MANAGER,
            callData: encodeFunctionData({
              abi: v4PositionManagerAbi,
              functionName: "getPoolAndPositionInfo",
              args: [tokenId],
            }),
          },
          {
            target: V4_POSITION_MANAGER,
            callData: encodeFunctionData({
              abi: v4PositionManagerAbi,
              functionName: "getPositionLiquidity",
              args: [tokenId],
            }),
          },
        ]),
      );
      const positions: Position[] = [];
      for (const [i, tokenId] of ownedIds.entries()) {
        try {
          const infoResult = results[i * 2];
          const liqResult = results[i * 2 + 1];
          if (infoResult === undefined || liqResult === undefined) {
            throw new Error(`multicall results missing for token ${tokenId}`);
          }
          // New PM interface: poolKey + packed info, liquidity via lens call.
          // Decode the REAL tick range from the packed positionInfo (200-bit
          // poolId | 24-bit tickUpper | 24-bit tickLower | 8-bit subscriber) —
          // a hardcoded 0/0 range made every v4 position permanently
          // "out of range", firing the vol-gate EXIT on any volatility spike.
          const [poolKey, positionInfo] = decodeFunctionResult({
            abi: v4PositionManagerAbi,
            functionName: "getPoolAndPositionInfo",
            data: infoResult.returnData,
          });
          const liquidity = decodeFunctionResult({
            abi: v4PositionManagerAbi,
            functionName: "getPositionLiquidity",
            data: liqResult.returnData,
          });
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
        } catch (err) {
          // Same policy as v3PositionsOf: a transient read failure must NOT
          // look like "position gone" to reconcile (which would drop a live
          // position from tracking) — fail the whole enumeration so the
          // reconcile caller skips the cycle instead.
          throw new Error(
            `v4PositionsOf: failed to read position ${tokenId} for ${owner}: ${underlyingErrorMessage(err)}`,
          );
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
      const windowBlocks = BigInt(Number(process.env.DISCOVERY_BLOCK_WINDOW ?? 2_000_000));
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
      getWalletBalanceUsd: () =>
        Effect.gen(function* () {
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
      getWalletHoldings: () =>
        Effect.gen(function* () {
          const holdings = new Map<string, { amountAtomic: bigint; decimals: number }>();
          if (!walletAddress) return holdings;
          yield* Effect.tryPromise(async () => {
            const [n, s] = await Promise.all([
              getBalance(NATIVE_MINT, walletAddress),
              getBalance(STABLECOIN_MINT, walletAddress),
            ]);
            holdings.set(NATIVE_MINT, { amountAtomic: n, decimals: 18 });
            holdings.set(STABLECOIN_MINT, { amountAtomic: s, decimals: 6 });
            // Also include every distinct token this engine trades (the v4 pool
            // registry currencies + WETH9): a stray LP leg left in the wallet
            // (swap overshoot, partial collect, failed entry) is otherwise
            // invisible to the orphan-settlement sweep and the wallet snapshot.
            // Concretely: the WETH/LEMON entry left 7,376 LEMON in the wallet
            // after the stop-loss collect; getWalletHoldings reported only
            // ETH+USDG, so the sweep never sold it and the snapshot showed
            // $9.65 against a ~$19.7 real balance (2026-08-14). Batched in
            // parallel, bounded by the registry; only non-zero balances stored.
            const mints = new Set<string>([WETH9.toLowerCase()]);
            for (const key of Object.values(V4_POOL_REGISTRY)) {
              mints.add(key.currency0.toLowerCase());
              mints.add(key.currency1.toLowerCase());
            }
            // Per-read timeout: the registry can hold hundreds of currencies and
            // a single hanging RPC must never stall the whole cycle (observed
            // 5min+ hang in the settlement sweep's holdings read). A timed-out
            // token is skipped for this call; balances re-qualify next cycle.
            const TIMEOUT_MS = 3_000;
            const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
              Promise.race([
                p,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
              ]);
            const reads = await Promise.all(
              [...mints].map(async (mint) => {
                try {
                  const bal = await withTimeout(getBalance(mint, walletAddress), TIMEOUT_MS);
                  if (bal === null || bal <= 0n) return null;
                  const decimals =
                    (await withTimeout(
                      getDecimals(mint).catch(() => 0),
                      TIMEOUT_MS,
                    )) ?? 0;
                  return { mint, bal, decimals } as const;
                } catch {
                  return null;
                }
              }),
            );
            for (const r of reads) {
              if (r !== null && r.bal > 0n) {
                holdings.set(r.mint, { amountAtomic: r.bal, decimals: r.decimals });
              }
            }
          });
          return holdings;
        }),
      getNativeBalance: () =>
        Effect.tryPromise(async () => {
          if (!walletAddress) return 0n;
          return publicClient.getBalance({ address: walletAddress });
        }),
      getPoolState: (poolAddress) =>
        Effect.tryPromise({
          try: async () => {
            // v4 poolIds are 66-char 0x-hex; v3 pools are 42-char addresses.
            if (poolAddress.length === 66) {
              // On-chain-verified key (poolKeys) — the registry entry carries
              // Krystal's cosmetic tickSpacing (400) that differs from the
              // pool's real spacing (e.g. 60); sizing ranges off 400 produced
              // unusable ticks and every v4 mint dry-run reverted.
              const key = await resolveV4PoolKey(poolAddress).catch(
                () => V4_POOL_REGISTRY[poolAddress.toLowerCase()] ?? null,
              );
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
              const poolIdHexValue = poolIdHex(poolAddress.toLowerCase());
              const [slot0, liquidity] = await Promise.all([
                stateView.read.getSlot0([poolIdHexValue]),
                stateView.read.getLiquidity([poolIdHexValue]),
              ]);
              const tick = Number(slot0[1]);
              const [decimals0Result, decimals1Result, price0Result, price1Result] =
                await Promise.allSettled([
                  tokenDecimalsOf(key.currency0),
                  tokenDecimalsOf(key.currency1),
                  priceUsd(key.currency0),
                  priceUsd(key.currency1),
                ]);
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
                tokenXDecimals: settledFiniteNumber(decimals0Result),
                tokenYDecimals: settledFiniteNumber(decimals1Result),
                tokenXPriceUsd: settledPositiveNumber(price0Result),
                tokenYPriceUsd: settledPositiveNumber(price1Result),
                liquidity,
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
              const key = await resolveV4PoolKey(poolAddress).catch(
                () => V4_POOL_REGISTRY[poolAddress.toLowerCase()] ?? null,
              );
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
              const poolIdHexValue = poolIdHex(poolAddress.toLowerCase());
              const slot0 = await stateView.read.getSlot0([poolIdHexValue]);
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
      getPoolStatesWithBins: (poolAddresses) =>
        Effect.gen(function* () {
          // Fail-open to an empty map: the scan loop skips missing pools for
          // a cycle rather than failing the whole batch on one bad read.
          const full = yield* Effect.tryPromise({
            try: () => getPoolStatesWithBinsImpl(poolAddresses),
            catch: (e) => new Error(`getPoolStatesWithBins: ${underlyingErrorMessage(e)}`),
          }).pipe(Effect.catch(() => Effect.succeed(null)));
          return full ?? new Map<string, { state: PoolState; bins: BinArray | null }>();
        }),
      getBinArrays: (poolAddresses) =>
        Effect.gen(function* () {
          const full = yield* Effect.tryPromise({
            try: () => getPoolStatesWithBinsImpl(poolAddresses),
            catch: (e) => new Error(`getBinArrays: ${underlyingErrorMessage(e)}`),
          }).pipe(Effect.catch(() => Effect.succeed(null)));
          const out = new Map<string, BinArray | null>();
          for (const p of poolAddresses) {
            const entry = full?.get(p.toLowerCase());
            out.set(p.toLowerCase(), entry === undefined ? null : entry.bins);
          }
          return out;
        }),
      getPositions: (poolAddress, wallet) =>
        Effect.tryPromise({
          try: async () => {
            const owner = getAddress(wallet);
            // Shared cycle-scoped enumeration — see positionsEnumeration.
            if (poolAddress.length === 66) {
              return (await positionsEnumeration(owner)).v4.filter(
                (p) => p.poolAddress === poolAddress.toLowerCase(),
              );
            }
            return (await positionsEnumeration(owner)).v3.filter(
              (p) => p.poolAddress === poolAddress.toLowerCase(),
            );
          },
          catch: (e) => new Error(`getPositions: ${underlyingErrorMessage(e)}`),
        }),
      getAllWalletPositions: (wallet) =>
        Effect.tryPromise({
          try: async () => {
            const owner = getAddress(wallet);
            const { v3, v4 } = await positionsEnumeration(owner);
            return v3.concat(v4).map((p) => ({
              poolAddress: p.poolAddress,
              positionPubKey: p.id,
              lowerBinId: p.lowerBinId,
              upperBinId: p.upperBinId,
              // Needed by reconcile to drop zero-liquidity shells (empty
              // position NFTs must not be managed or claimed).
              liquidityShares: p.liquidityShares,
              // Owed fees on dropped shells — never silently abandoned.
              tokensOwedX: p.tokensOwedX ?? 0n,
              tokensOwedY: p.tokensOwedY ?? 0n,
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
            // Shared cycle-scoped enumeration — see positionsEnumeration.
            const { v3, v4 } = await positionsEnumeration(walletAddress);
            const pos =
              poolAddress.length === 66
                ? v4.find((p) => p.id === positionPubKey)
                : v3.find((p) => p.id === positionPubKey);
            if (!pos || pos.liquidityShares <= 0n) return null;
            const state =
              poolAddress.length === 66
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
      getAllPositionValuesUsd: (wallet) =>
        Effect.tryPromise({
          try: async () => {
            const owner = getAddress(wallet);
            // Shared cycle-scoped enumeration — see positionsEnumeration.
            const { v3, v4 } = await positionsEnumeration(owner);
            const positions = v3.concat(v4);
            const stateByPool = new Map<string, PoolQuoteState | null>();
            await Promise.all(
              [...new Set(positions.map((p) => p.poolAddress.toLowerCase()))].map(
                async (poolAddress) => {
                  try {
                    const state =
                      poolAddress.length === 66
                        ? await v4PoolQuoteState(poolAddress)
                        : await v3PoolQuoteState(getAddress(poolAddress));
                    stateByPool.set(poolAddress, state);
                  } catch {
                    stateByPool.set(poolAddress, null);
                  }
                },
              ),
            );

            const tokenMints = new Set<string>();
            for (const state of stateByPool.values()) {
              if (state !== null) {
                tokenMints.add(state.token0.toLowerCase());
                tokenMints.add(state.token1.toLowerCase());
              }
            }
            const prices = new Map<string, number>();
            await Promise.all(
              [...tokenMints].map(async (mint) => {
                prices.set(mint, await priceUsd(mint).catch(() => 0));
              }),
            );

            const values = new Map<string, number | null>();
            for (const pos of positions) {
              const state = stateByPool.get(pos.poolAddress.toLowerCase()) ?? null;
              if (state === null || pos.liquidityShares <= 0n) {
                values.set(pos.id, null);
                continue;
              }
              const { amount0, amount1 } = positionAmountsAtSqrtPrice(
                pos.liquidityShares,
                pos.lowerBinId,
                pos.upperBinId,
                state.sqrtPriceX96,
              );
              const price0 = prices.get(state.token0.toLowerCase()) ?? 0;
              const price1 = prices.get(state.token1.toLowerCase()) ?? 0;
              values.set(
                pos.id,
                (Number(amount0) / 10 ** state.token0Decimals) * price0 +
                  (Number(amount1) / 10 ** state.token1Decimals) * price1,
              );
            }
            return values;
          },
          catch: (e) => new Error(`getAllPositionValuesUsd: ${underlyingErrorMessage(e)}`),
        }),
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
              ? await v4PoolQuoteState(poolAddress, false)
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
            // A WETH leg is fundable with NATIVE ETH (wrapped before mint):
            // v3 pools are WETH-paired and the wallet holds native — without
            // this mapping every v3 single-sided entry was rejected as
            // 'can fund neither leg' or reverted on the mint's WETH transfer.
            const nativeBal = await publicClient.getBalance({ address: owner });
            const [bal0, bal1] = await Promise.all([
              getBalance(state.token0, owner),
              getBalance(state.token1, owner),
            ]);
            const wrapable0 = getAddress(state.token0) === WETH9 ? bal0 + nativeBal : bal0;
            const wrapable1 = getAddress(state.token1) === WETH9 ? bal1 + nativeBal : bal1;
            const oneLegNative =
              isNative(state.token0) ||
              getAddress(state.token0) === WETH9 ||
              isNative(state.token1) ||
              getAddress(state.token1) === WETH9;
            let mode: EntryDepositMode = "two-sided";
            if (bal0 >= amount0 && bal1 >= amount1) {
              // both legs fundable — two-sided
            } else if (nativeBal > 0n && oneLegNative) {
              // Native-only funding → swap_and_mint (the spec's mechanism):
              // swap the missing leg and mint two-sided WHEN the route is
              // proven liquid; a REVERTING route refuses the entry (a broken
              // buy leg usually means a broken sell leg — rule 5); a dead
              // route on a LIVE pool falls back to a single-sided native
              // entry (v3 WETH wrap); a dead pool refuses outright.
              if (state.liquidity <= 0n) {
                throw new Error(
                  `enterPosition: wallet can fund neither leg (pool has no liquidity: ${poolAddress})`,
                );
              }
              // dp8: pre-broadcast mint simulation — abort before the deficit
              // swap broadcasts when the mint cannot succeed with the
              // projected post-swap state. Prevents the gas bleed and
              // trapped-leg loss of a doomed entry (fork NPM quirk, hook
              // revert, token restriction): a reverting mint is now caught
              // here, before any swap/wrap/approve tx is sent.
              const nativeLike0 = isNative(state.token0) || getAddress(state.token0) === WETH9;
              const missingLeg = nativeLike0 ? state.token1 : state.token0;
              const missingLegAmount = nativeLike0 ? amount1 : amount0;
              const sim = await dryRunEntryMintSimulation({
                poolAddress,
                state,
                amount0,
                amount1,
                lowerBinId,
                upperBinId,
                isV4,
                owner,
                injectedTokenBalance: nativeLike0 ? amount1 : amount0,
                injectedWethBalance: nativeLike0 ? amount0 : amount1,
                deadline: Math.floor(Date.now() / 1000) + POSITION_DEADLINE_S,
              });
              if (!sim.ok) {
                throw new Error(
                  `enterPosition: mint simulation failed pre-broadcast — NOT swapping (${sim.reason})`,
                );
              }
              const fundedBySwap = await swapToFundDeficit({
                owner,
                state,
                amount0,
                amount1,
                halfUsd,
                nativeBal,
              });
              // Post-swap pre-mint balance proof: the sim injected the exact
              // required amounts, but the real deficit swap can land short
              // (execution slippage/price drift), so the mint would revert
              // AFTER the swap broadcast and strand the stray. Verify the
              // wallet actually holds the missing leg before the mint and
              // abort pre-broadcast (of the mint) when it fell short. The
              // swapped output stays in the wallet (recoverable by the sweep),
              // and this rejection is excluded from the failure count like
              // the sim marker.
              if (fundedBySwap === "swapped") {
                const heldAfter = await getBalance(missingLeg, owner).catch(() => 0n);
                if (heldAfter < missingLegAmount) {
                  throw new Error(
                    `enterPosition: deficit swap fell short pre-broadcast — ` +
                      `held ${heldAfter.toString()} < needed ${missingLegAmount.toString()} ` +
                      `(mint NOT broadcast; stray recoverable)`,
                  );
                }
              }
              if (fundedBySwap === "reverted") {
                throw new Error(
                  `enterPosition: wallet can fund neither leg (swap route reverts: ${poolAddress})`,
                );
              }
              if (fundedBySwap !== "swapped") {
                if (wrapable0 >= amount0) {
                  mode = "single-sided-x";
                  amount1 = 0n;
                  amount0 = usdToAtomic(positionSizeUsd, price0, state.token0Decimals);
                } else if (wrapable1 >= amount1) {
                  mode = "single-sided-y";
                  amount0 = 0n;
                  amount1 = usdToAtomic(positionSizeUsd, price1, state.token1Decimals);
                } else {
                  throw new Error(
                    `enterPosition: wallet can fund neither leg (need ${amount0} ${state.token0} / ${amount1} ${state.token1})`,
                  );
                }
              }
            } else if (wrapable0 >= amount0) {
              mode = "single-sided-x";
              amount1 = 0n;
              amount0 = usdToAtomic(positionSizeUsd, price0, state.token0Decimals);
            } else if (wrapable1 >= amount1) {
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
              // Re-read the pool state AFTER funding: the deficit swap moved
              // the price, and building the mint off the stale pre-swap sqrt
              // price makes the real mint revert on the live pool state
              // (observed v4 residual 2026-08-16 on pool 0x002da18d49a3 —
              // the sim passed, the real mint dry-run reverted). The amounts
              // (USD-sized) stand; the price/tick used for the SDK's
              // liquidity math must be current.
              const freshState = await v4PoolQuoteState(poolAddress, false);
              const key = await resolveV4PoolKey(poolAddress, false);
              const built = buildV4MintCalldata({
                poolKey: key,
                sqrtPriceX96: freshState.sqrtPriceX96,
                tickCurrent: freshState.tickCurrent,
                token0Decimals: freshState.token0Decimals,
                token1Decimals: freshState.token1Decimals,
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
              if (!positionPubKey)
                throw new Error("enterPosition: could not decode minted tokenId");
              return {
                positionPubKey,
                txSignature,
                depositMode: mode,
                amountXUsd: usdOf(built.amount0, state.token0Decimals, price0),
                amountYUsd: usdOf(built.amount1, state.token1Decimals, price1),
              };
            }
            // Native → WETH wrap for the funded leg BEFORE the mint: the v3
            // NPM transfers WETH, and the wallet holds native ETH. Wrap the
            // deficit (deposit into WETH9) so the mint's transfer succeeds.
            if (!isV4) {
              for (const [mint, amount] of [
                [state.token0, amount0],
                [state.token1, amount1],
              ] as const) {
                if (amount <= 0n || getAddress(mint) !== WETH9) continue;
                const wethBal = await getBalance(WETH9, owner);
                if (wethBal >= amount) continue;
                const deficit = amount - wethBal;
                await sendTx({
                  to: WETH9,
                  data: encodeFunctionData({
                    abi: weth9Abi,
                    functionName: "deposit",
                  }),
                  value: deficit,
                });
              }
            }
            // Re-read the pool state after the WETH wrap (same rationale as
            // the v4 branch: the deficit swap moved the price; build the mint
            // off the CURRENT sqrt price/tick so it matches the live pool).
            const freshState = await v3PoolQuoteState(getAddress(poolAddress));
            const built = buildV3MintCalldata({
              token0: state.token0,
              token1: state.token1,
              fee: state.fee,
              tickSpacing: state.tickSpacing,
              sqrtPriceX96: freshState.sqrtPriceX96,
              tickCurrent: freshState.tickCurrent,
              token0Decimals: freshState.token0Decimals,
              token1Decimals: freshState.token1Decimals,
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
            // Fail-closed pre-broadcast gate (ExitProofConfig.simulateBeforeExit,
            // default true): dry-run the exact burn+collect calldata — a
            // reverting exit must never broadcast (burned gas + stuck liquidity).
            if (simulateBeforeExitEnabled()) {
              const sim = await simulateWithdrawInternal(poolAddress, positionPubKey);
              if (!sim.ok) {
                throw new Error(
                  `exitPosition: withdraw dry-run failed — NOT broadcasting (${sim.reason ?? "unknown revert"})`,
                );
              }
            }
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
      simulateWithdraw: (poolAddress, positionPubKey) =>
        Effect.tryPromise({
          try: () => simulateWithdrawInternal(poolAddress, positionPubKey),
          catch: (e) => new Error(`simulateWithdraw: ${underlyingErrorMessage(e)}`),
        }),
      verifyExitRoute: (poolAddress, positionSizeUsd) =>
        Effect.tryPromise({
          try: async () => {
            requireWallet();
            const isV4 = poolAddress.length === 66;
            const state = isV4
              ? await v4PoolQuoteState(poolAddress)
              : await v3PoolQuoteState(getAddress(poolAddress));
            const [price0, price1] = await Promise.all([
              priceUsd(state.token0),
              priceUsd(state.token1),
            ]);
            const halfUsd = positionSizeUsd / 2;
            const legs = [
              {
                mint: state.token0,
                amount: usdToAtomic(halfUsd, price0, state.token0Decimals),
                decimals: state.token0Decimals,
              },
              {
                mint: state.token1,
                amount: usdToAtomic(halfUsd, price1, state.token1Decimals),
                decimals: state.token1Decimals,
              },
            ] as const;
            const failures: string[] = [];
            let proceedsNative = 0n;
            for (const leg of legs) {
              // WETH is native-equivalent: it unwraps 1:1 to ETH with a
              // trivial tx — no swap, counted directly in proceeds.
              if (isNative(leg.mint) || getAddress(leg.mint) === WETH9) {
                proceedsNative += leg.amount;
                continue;
              }
              if (leg.amount <= 0n) {
                failures.push(`${leg.mint.slice(0, 8)}: leg unpriceable (size 0)`);
                continue;
              }
              try {
                // Quote legs → ETH at realistic size through the working path.
                const { outAmountAtomic, route } = await quotePair(
                  leg.mint,
                  NATIVE_MINT,
                  leg.amount,
                );
                if (outAmountAtomic <= 0n) {
                  failures.push(`${leg.mint.slice(0, 8)}: zero quote to native`);
                  continue;
                }
                // eth_call-simulate the swap end-to-end WHEN the wallet holds
                // the leg; a balance-revert here is a funding limitation (the
                // wallet WILL hold the legs at exit time), not a route failure.
                const bal = await getBalance(leg.mint, requireWallet());
                if (bal >= leg.amount) {
                  const deadline = Math.floor(Date.now() / 1000) + 300;
                  const calldata = buildSwapCalldataV2(
                    route,
                    leg.mint,
                    NATIVE_MINT,
                    leg.amount,
                    outAmountAtomic,
                    deadline,
                  );
                  await publicClient.call({
                    account: requireWallet(),
                    to: route.target,
                    data: calldata,
                  });
                }
                proceedsNative += outAmountAtomic;
              } catch (e) {
                failures.push(`${leg.mint.slice(0, 8)}: ${underlyingErrorMessage(e)}`);
              }
            }
            const nativePrice = await priceUsd(NATIVE_MINT);
            return {
              ok: failures.length === 0,
              reason: failures.length > 0 ? failures.join("; ") : null,
              proceedsUsd: nativePrice > 0 ? usdOf(proceedsNative, 18, nativePrice) : null,
            };
          },
          catch: (e) => new Error(`verifyExitRoute: ${underlyingErrorMessage(e)}`),
        }),
      placeLimitOrder: (_poolAddress, _request) => NOT_IMPLEMENTED("placeLimitOrder"),
      cancelLimitOrder: (_poolAddress, _orderPubKey, _binIds) =>
        NOT_IMPLEMENTED("cancelLimitOrder"),
      rebalancePosition: (poolAddress, positionPubKey, newLowerBinId, newUpperBinId, topUp) =>
        Effect.tryPromise({
          try: async () => {
            const owner = requireWallet();
            // Fail-closed pre-broadcast gate (see exitPosition): a reverting
            // burn+collect must never broadcast.
            if (simulateBeforeExitEnabled()) {
              const sim = await simulateWithdrawInternal(poolAddress, positionPubKey);
              if (!sim.ok) {
                throw new Error(
                  `rebalancePosition: withdraw dry-run failed — NOT broadcasting (${sim.reason ?? "unknown revert"})`,
                );
              }
            }
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
              const key = await resolveV4PoolKey(poolAddress, false);
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
            // Gas leak guard (clawpatch audit + operator report): a collect on
            // a position with NO owed fees still burns gas. The v3 NPM's
            // positions() exposes tokensOwed0/tokensOwed1 — skip the broadcast
            // entirely when both are zero (v4 has no readable owed amounts on
            // this PM's info encoding; its claims are interval-gated anyway).
            if (!isV4 && expected0 === 0n && expected1 === 0n) {
              return {
                txSignature: "",
                feeX: 0,
                feeY: 0,
                platformFeeX: 0,
                platformFeeY: 0,
                netFeeX: 0,
                netFeeY: 0,
                netFeesUsd: 0,
                estimatedGasUsd: null,
              };
            }
            // Gas-budget harvest gate (harvestMaxGasPct): estimated gas × 2×
            // base fee (the sendTx gas strategy), priced in USD. null when
            // unavailable — the caller's gate treats null conservatively.
            let estimatedGasUsd: number | null = null;
            try {
              const gas = await publicClient.estimateGas({
                account: owner,
                to: isV4 ? V4_POSITION_MANAGER : V3_NPM,
                data: calldata,
                value,
              });
              const baseFee = (await publicClient.getBlock()).baseFeePerGas ?? 100_000_000n;
              const maxFeePerGas = baseFee * 2n;
              const nativePrice = await priceUsd(NATIVE_MINT);
              estimatedGasUsd =
                nativePrice > 0 ? (Number(gas) * Number(maxFeePerGas) * nativePrice) / 1e18 : null;
            } catch {
              estimatedGasUsd = null;
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
              estimatedGasUsd,
            };
          },
          catch: (e) => new Error(`claimFees: ${underlyingErrorMessage(e)}`),
        }),
      convertClaimedFees: (poolAddress, destination, feeX, feeY) =>
        Effect.tryPromise({
          try: async () => {
            const owner = requireWallet();
            const isV4 = poolAddress.length === 66;
            const state = isV4
              ? await v4PoolQuoteState(poolAddress)
              : await v3PoolQuoteState(getAddress(poolAddress));
            const dest = destination === "accumulate-native" ? NATIVE_MINT : STABLECOIN_MINT;
            const destDecimals = dest === NATIVE_MINT ? 18 : 6;
            const destAddr = dest.toLowerCase();
            // feeX ↔ token0, feeY ↔ token1 (claimFees token units).
            const legs = [
              {
                mint: state.token0,
                amount: BigInt(Math.round(feeX * 10 ** state.token0Decimals)),
              },
              {
                mint: state.token1,
                amount: BigInt(Math.round(feeY * 10 ** state.token1Decimals)),
              },
            ];
            const txs: string[] = [];
            let outputAtomic = 0n;
            for (const leg of legs) {
              if (leg.amount <= 0n) continue;
              const legIsNative = isNative(leg.mint);
              const legAddr = leg.mint.toLowerCase();
              // Already the destination asset.
              if (legAddr === destAddr || (legIsNative && destAddr === NATIVE_MINT.toLowerCase())) {
                outputAtomic += leg.amount;
                continue;
              }
              // WETH → native is a pure unwrap — no swap, no router.
              if (destAddr === NATIVE_MINT.toLowerCase() && getAddress(leg.mint) === WETH9) {
                const { txSignature } = await sendTx({
                  to: WETH9,
                  data: encodeFunctionData({
                    abi: weth9Abi,
                    functionName: "withdraw",
                    args: [leg.amount],
                  }),
                });
                txs.push(txSignature);
                outputAtomic += leg.amount;
                continue;
              }
              // Swap the leg → destination through the verified route
              // (sendTx dry-runs the eth_call before broadcasting). A failed
              // leg logs and continues (fail-open per leg, like
              // swapUSDCForNative) — the caller only logs the outcome.
              try {
                const { outAmountAtomic, route } = await quotePair(leg.mint, dest, leg.amount);
                const amountOutMinimum =
                  (outAmountAtomic * BigInt(10_000 - swapMintSlippageBps())) / 10_000n;
                const deadline = Math.floor(Date.now() / 1000) + 300;
                let calldata: Hex;
                let target: Address;
                if (destAddr === NATIVE_MINT.toLowerCase() && route.router === "swaprouter02") {
                  // v3 swap outputs WETH; unwrap to native in one multicall
                  // (the swapUSDCForNative pattern, v2 encoding).
                  const swapData = buildV3SwapCalldataForChain({
                    tokenIn: routerInputAddress(leg.mint, "swaprouter02"),
                    tokenOut: WETH9,
                    fee: route.fee,
                    recipient: V3_SWAP_ROUTER_02,
                    amountIn: leg.amount,
                    amountOutMinimum,
                  });
                  const unwrapData = buildUnwrapWETH9Calldata(amountOutMinimum, owner);
                  calldata = buildSwapRouterMulticallCalldata([swapData, unwrapData]);
                  target = V3_SWAP_ROUTER_02;
                } else {
                  calldata = buildSwapCalldataV2(
                    route,
                    leg.mint,
                    dest,
                    leg.amount,
                    amountOutMinimum,
                    deadline,
                  );
                  target = route.target;
                }
                const value = legIsNative ? leg.amount : 0n;
                if (!legIsNative) await approveInputForRoute(leg.mint, route, leg.amount);
                const { txSignature } = await sendTx({ to: target, data: calldata, value });
                txs.push(txSignature);
                outputAtomic += outAmountAtomic;
              } catch (e) {
                logger.warn("convertClaimedFees leg failed (fail-open)", {
                  leg: leg.mint.slice(0, 8),
                  error: underlyingErrorMessage(e),
                });
              }
            }
            const destPrice = await priceUsd(dest);
            return {
              destination,
              outputAtomic,
              outputUsd: destPrice > 0 ? usdOf(outputAtomic, destDecimals, destPrice) : null,
              txSignatures: txs,
            };
          },
          catch: (e) => new Error(`convertClaimedFees: ${underlyingErrorMessage(e)}`),
        }),
      getPendingFees: (poolAddress, positionId) =>
        Effect.tryPromise({
          try: async () => {
            const tokenId = BigInt(positionId);
            const isV4 = poolAddress.length === 66;
            if (isV4) {
              // Probe-verified (2026-08-10, selector scan of the live 4663
              // StateView 0xF333…): the deployment exposes only getSlot0 +
              // getLiquidity — no claimable-fee read — and the PositionManager
              // info encoding carries no owed amounts. Honest null (fail-open);
              // the v4 collect path stays interval-gated.
              return null;
            }
            const npm = v3Npm();
            const p = await npm.read.positions([tokenId]);
            const token0 = p[2];
            const token1 = p[3];
            const fee = Number(p[4]);
            const state = await v3PoolQuoteState(await v3PoolOf(token0, token1, fee));
            const feeX = p[10];
            const feeY = p[11];
            const [price0, price1] = await Promise.all([priceUsd(token0), priceUsd(token1)]);
            // Unpriceable leg → null (fail-closed gate: never harvest
            // unpriceable fees on a symbol-based estimate).
            if (!(price0 > 0) || !(price1 > 0)) return null;
            return {
              feeX,
              feeY,
              feeXUsd: usdOf(feeX, state.token0Decimals, price0),
              feeYUsd: usdOf(feeY, state.token1Decimals, price1),
            };
          },
          catch: (e) => new Error(`getPendingFees: ${underlyingErrorMessage(e)}`),
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
      unwrapWethToNative: () =>
        Effect.tryPromise({
          try: async () => {
            if (!walletAddress) return 0n;
            const wethBal = await getBalance(WETH9, walletAddress);
            if (wethBal <= 0n) return 0n;
            const { txSignature } = await sendTx({
              to: WETH9,
              data: encodeFunctionData({
                abi: weth9Abi,
                functionName: "withdraw",
                args: [wethBal],
              }),
            });
            logger.info("unwrapWethToNative", {
              txSignature,
              amountWei: wethBal.toString(),
            });
            return wethBal;
          },
          catch: (e) => {
            logger.warn("unwrapWethToNative failed (fail-open)", {
              error: underlyingErrorMessage(e),
            });
            return 0n;
          },
        }).pipe(Effect.catch(() => Effect.succeed(0n))),
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
            const desiredUsdg = BigInt(
              Math.round((swapAmountStable ?? GAS_TOP_UP_STABLECOIN) * 1e6),
            );
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
            const swapData = buildV3SwapCalldataForChain({
              tokenIn: STABLECOIN_MINT,
              tokenOut: WETH9,
              fee: route.fee,
              recipient: V3_SWAP_ROUTER_02,
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
        }).pipe(Effect.catch(() => Effect.void)),
      getTokenBalance: (mint) =>
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
            let calldata: Hex;
            if (isV4SwapQuoteRaw(raw)) {
              calldata = buildUniversalRouterV4SwapCalldata({
                poolKey: raw.poolKey,
                zeroForOne: raw.zeroForOne,
                amountIn: quote.request.amountAtomic,
                amountOutMinimum: quote.minimumOutAmountAtomic,
                deadline,
              });
            } else if (isV3SwapQuoteRaw(raw) && isNative(quote.request.outputMint)) {
              // v3 swap outputs WETH; unwrap to native so the settlement
              // actually lands ETH (gas-usable), one multicall — the
              // convertClaimedFees / swapUSDCForNative pattern.
              const swapData = buildV3SwapCalldataForChain({
                tokenIn: routerInputAddress(quote.request.inputMint, "swaprouter02"),
                tokenOut: WETH9,
                fee: raw.fee,
                recipient: V3_SWAP_ROUTER_02,
                amountIn: quote.request.amountAtomic,
                amountOutMinimum: quote.minimumOutAmountAtomic,
              });
              const unwrapData = buildUnwrapWETH9Calldata(quote.minimumOutAmountAtomic, owner);
              calldata = buildSwapRouterMulticallCalldata([swapData, unwrapData]);
            } else if (isV3SwapQuoteRaw(raw)) {
              calldata = buildV3SwapCalldataForChain({
                tokenIn: routerInputAddress(quote.request.inputMint, "swaprouter02"),
                tokenOut: routerInputAddress(quote.request.outputMint, "swaprouter02"),
                fee: raw.fee,
                recipient: owner,
                amountIn: quote.request.amountAtomic,
                amountOutMinimum: quote.minimumOutAmountAtomic,
              });
            } else {
              throw new Error("quote contains an invalid swap route");
            }
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
            if (!isV4SwapQuoteRaw(raw) && !isV3SwapQuoteRaw(raw)) {
              throw new Error("prepared quote contains an invalid swap route");
            }
            const calldata = decodePreparedCalldata(prepared.transactionBase64);
            const target = raw.router === "universalrouter" ? UNIVERSAL_ROUTER : V3_SWAP_ROUTER_02;
            await publicClient.call({ account: owner, to: target, data: calldata });
            return { successful: true, logs: [], unitsConsumed: null };
          },
          catch: (e) => new Error(`simulateSwap: ${underlyingErrorMessage(e)}`),
        }),
      submitSwap: (prepared, onBroadcast) =>
        Effect.gen(function* () {
          const raw = prepared.quote.rawQuote;
          if (!isV4SwapQuoteRaw(raw) && !isV3SwapQuoteRaw(raw)) {
            throw new Error("prepared quote contains an invalid swap route");
          }
          const calldata = decodePreparedCalldata(prepared.transactionBase64);
          const route: SwapRoute = isV4SwapQuoteRaw(raw)
            ? {
                router: "universalrouter",
                target: UNIVERSAL_ROUTER,
                poolId: raw.poolId,
                poolKey: raw.poolKey,
                zeroForOne: raw.zeroForOne,
                decimals0: 0,
                decimals1: 0,
              }
            : {
                router: "swaprouter02",
                target: V3_SWAP_ROUTER_02,
                pool: raw.pool,
                fee: raw.fee,
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
              .getTransactionReceipt({ hash: transactionHash(signature) })
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
              .getTransactionReceipt({ hash: transactionHash(signature) })
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
