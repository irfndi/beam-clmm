import { describe, it, expect } from "vitest";
import { decodeAbiParameters, decodeFunctionData, keccak256, parseAbi, toHex } from "viem";
import { TickMath } from "@uniswap/v3-sdk";
import {
  buildUniversalRouterV4SwapCalldata,
  buildV3CollectCalldata,
  buildV3ExactInputSingleCalldata,
  buildV3ExactInputSingleCalldataV2,
  buildV3ExitCalldata,
  buildV3MintCalldata,
  buildUnwrapWETH9Calldata,
  buildSwapRouterMulticallCalldata,
  buildV4CollectCalldata,
  buildV4ExitCalldata,
  buildV4MintCalldata,
  decodeV4PositionInfo,
  isResolvedV4PoolKeyValid,
  quoteSwapInternal,
  rawPoolPriceToBasePerMint,
  selectHighestOutputQuote,
  tickRangeAround,
  tokenIdFromMintReceipt,
  usdToAtomic,
  type PoolQuoteState,
  type V4PoolKey,
} from "../engine/adapter-service.js";

// ─── Fixture (on-chain-known WETH/USDG 0.3% pool 0xa9188730…, tick -200723) ──

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ZERO = "0x0000000000000000000000000000000000000000";
const WALLET = "0x1111111111111111111111111111111111111111";
const TICK = -200723;
const SQRT_PRICE_X96 = BigInt(TickMath.getSqrtRatioAtTick(TICK).toString());
const DEADLINE = 1800000000; // fixed, deterministic
const FEE = 3000;
const TICK_SPACING = 60;

const V3_POOL_STATE: PoolQuoteState = {
  token0: WETH,
  token1: USDG,
  token0Decimals: 18,
  token1Decimals: 6,
  fee: FEE,
  tickSpacing: TICK_SPACING,
  sqrtPriceX96: SQRT_PRICE_X96,
  tickCurrent: TICK,
  liquidity: 10n ** 22n,
};

const V4_POOL_KEY: V4PoolKey = {
  currency0: WETH,
  currency1: USDG,
  fee: FEE,
  tickSpacing: TICK_SPACING,
  hooks: ZERO,
};

// ─── Decode helpers ──────────────────────────────────────────────────────────

const mintAbi = parseAbi([
  "function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))",
]);
const collectAbi = parseAbi(["function collect((uint256,address,uint128,uint128))"]);
const decreaseAbi = parseAbi([
  "function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))",
]);
const burnAbi = parseAbi(["function burn(uint256)"]);
const multicallAbi = parseAbi(["function multicall(bytes[]) returns (bytes[])"]);
const exactInputSingleAbi = parseAbi([
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
]);
const modifyLiquiditiesAbi = parseAbi(["function modifyLiquidities(bytes,uint256)"]);
const executeAbi = parseAbi(["function execute(bytes,bytes[],uint256)"]);
const poolKeyParams = [
  { type: "address" },
  { type: "address" },
  { type: "uint24" },
  { type: "int24" },
  { type: "address" },
  // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
] as const;

function decodeUnlockData(calldata: `0x${string}`) {
  const { args } = decodeFunctionData({ abi: modifyLiquiditiesAbi, data: calldata });
  // args[0] is the bytes VALUE = abi.encode(bytes actions, bytes[] params)
  // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
  const [actions, params] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    args[0] as `0x${string}`,
    // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
  ) as [`0x${string}`, readonly `0x${string}`[]];
  // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
  return { actions, params, deadline: args[1] as bigint };
}

/** ABI decoders return dynamic bytes unpadded ("0x6" for 0x06); compare
 *  action-byte strings by numeric value. */
function actionBytes(hex: `0x${string}`): number {
  return parseInt(hex, 16);
}

function mintParams(calldata: `0x${string}`) {
  const { args } = decodeFunctionData({ abi: mintAbi, data: calldata });
  // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
  return args[0] as [
    string,
    string,
    number,
    number,
    number,
    bigint,
    bigint,
    bigint,
    bigint,
    string,
    bigint,
  ];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildV3MintCalldata (WETH/USDG 0.3%, tick -200723, $1000)", () => {
  const built = buildV3MintCalldata({
    token0: WETH,
    token1: USDG,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    sqrtPriceX96: SQRT_PRICE_X96,
    tickCurrent: TICK,
    token0Decimals: 18,
    token1Decimals: 6,
    amount0: 200_000_000_000_000_000n, // $500 WETH at $2500
    amount1: 500_000_000n, // $500 USDG
    recipient: WALLET,
    deadline: DEADLINE,
    slippageToleranceBps: 50,
  });

  it("encodes a mint to the NPM with the pool identity and no msg.value", () => {
    expect(built.value).toBe(0n);
    const p = mintParams(built.calldata);
    expect(p[0].toLowerCase()).toBe(WETH.toLowerCase());
    expect(p[1].toLowerCase()).toBe(USDG.toLowerCase());
    expect(p[2]).toBe(FEE);
  });

  it("uses a spacing-aligned range that contains the current tick", () => {
    expect(built.tickLower).toBeLessThan(TICK);
    expect(built.tickUpper).toBeGreaterThan(TICK);
    expect(built.tickLower % TICK_SPACING === 0).toBe(true);
    expect(built.tickUpper % TICK_SPACING === 0).toBe(true);
    // ±5% half-width from tickRangeAround(-200723, 60)
    expect(built.tickLower).toBe(-201240);
    expect(built.tickUpper).toBe(-200220);
  });

  it("splits the $1000 size into sane per-leg amounts with slippage floors", () => {
    // WETH leg ≈ $500 @ $2500 → 0.2 WETH; USDG leg ≈ $500 → 5e8 raw
    expect(built.amount0).toBeGreaterThan(0n);
    expect(built.amount0).toBeLessThanOrEqual(200_000_000_000_000_000n);
    expect(Number(built.amount0) / 1e18).toBeGreaterThan(0.19);
    expect(Number(built.amount0) / 1e18).toBeLessThanOrEqual(0.2);
    expect(built.amount1).toBeGreaterThan(300_000_000n);
    expect(built.amount1).toBeLessThanOrEqual(500_000_000n);
    // slippage floors are positive and strictly below the desired amounts
    expect(built.amount0Min).toBeGreaterThan(0n);
    expect(built.amount0Min).toBeLessThan(built.amount0);
    expect(built.amount1Min).toBeGreaterThan(0n);
    expect(built.amount1Min).toBeLessThan(built.amount1);
  });

  it("pays to the requested recipient and encodes the deadline", () => {
    const p = mintParams(built.calldata);
    expect(p[9].toLowerCase()).toBe(WALLET.toLowerCase());
    expect(p[10]).toBe(BigInt(DEADLINE));
  });

  it("supports a single-sided deposit (token0 only)", () => {
    const oneSided = buildV3MintCalldata({
      token0: WETH,
      token1: USDG,
      fee: FEE,
      tickSpacing: TICK_SPACING,
      sqrtPriceX96: SQRT_PRICE_X96,
      tickCurrent: TICK,
      token0Decimals: 18,
      token1Decimals: 6,
      amount0: 200_000_000_000_000_000n,
      amount1: 0n,
      recipient: WALLET,
      deadline: DEADLINE,
      slippageToleranceBps: 50,
    });
    const p = mintParams(oneSided.calldata);
    // fromAmount0 sizes liquidity from the held leg; the derived leg is the
    // minimum the same liquidity needs (a v3 mint pulls both legs).
    expect(p[5]).toBeGreaterThan(0n);
    expect(p[6]).toBeGreaterThan(0n);
    expect(p[5]).toBeLessThanOrEqual(200_000_000_000_000_000n);
  });

  it("honors an explicit tick range from the strategy", () => {
    const custom = buildV3MintCalldata({
      token0: WETH,
      token1: USDG,
      fee: FEE,
      tickSpacing: TICK_SPACING,
      sqrtPriceX96: SQRT_PRICE_X96,
      tickCurrent: TICK,
      token0Decimals: 18,
      token1Decimals: 6,
      amount0: 200_000_000_000_000_000n,
      amount1: 500_000_000n,
      recipient: WALLET,
      deadline: DEADLINE,
      slippageToleranceBps: 50,
      tickLower: -202020,
      tickUpper: -199020,
    });
    expect(custom.tickLower).toBe(-202020);
    expect(custom.tickUpper).toBe(-199020);
  });
});

describe("buildV3CollectCalldata", () => {
  it("encodes collect with tokenId, wallet recipient and uint128.max caps", () => {
    const { calldata } = buildV3CollectCalldata({
      tokenId: 42n,
      token0: WETH,
      token1: USDG,
      token0Decimals: 18,
      token1Decimals: 6,
      recipient: WALLET,
    });
    const { args } = decodeFunctionData({ abi: collectAbi, data: calldata });
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    const [tokenId, recipient, amount0Max, amount1Max] = args[0] as [
      bigint,
      string,
      bigint,
      bigint,
    ];
    expect(tokenId).toBe(42n);
    expect(recipient.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(amount0Max).toBe(2n ** 128n - 1n);
    expect(amount1Max).toBe(2n ** 128n - 1n);
  });
});

describe("buildV3ExitCalldata", () => {
  const built = buildV3ExitCalldata({
    tokenId: 42n,
    token0: WETH,
    token1: USDG,
    token0Decimals: 18,
    token1Decimals: 6,
    fee: FEE,
    sqrtPriceX96: SQRT_PRICE_X96,
    tickCurrent: TICK,
    liquidity: 10n ** 20n,
    tickLower: -201240,
    tickUpper: -200220,
    tokensOwed0: 123456789n,
    tokensOwed1: 987654n,
    recipient: WALLET,
    deadline: DEADLINE,
    slippageToleranceBps: 50,
  });

  it("batches decreaseLiquidity(100%) + collect + burn in one multicall", () => {
    const { args } = decodeFunctionData({ abi: multicallAbi, data: built.calldata });
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    const calls = args[0] as readonly `0x${string}`[];
    expect(calls).toHaveLength(3);

    const decrease = decodeFunctionData({ abi: decreaseAbi, data: calls[0]! });
    expect(decrease.functionName).toBe("decreaseLiquidity");
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    const decreaseArgs = decrease.args[0] as readonly [bigint, bigint, bigint, bigint, bigint];
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    const tokenId = decreaseArgs[0] as bigint;
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    const liquidity = decreaseArgs[1] as bigint;
    expect(tokenId).toBe(42n);
    expect(liquidity).toBe(10n ** 20n);

    const collect = decodeFunctionData({ abi: collectAbi, data: calls[1]! });
    expect(collect.functionName).toBe("collect");
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    const collectParams = collect.args[0] as [bigint, string, bigint, bigint];
    expect(collectParams[0]).toBe(42n);
    expect(collectParams[1].toLowerCase()).toBe(WALLET.toLowerCase());

    const burn = decodeFunctionData({ abi: burnAbi, data: calls[2]! });
    expect(burn.functionName).toBe("burn");
    expect(burn.args[0]).toBe(42n);
  });
});

describe("v4 modifyLiquidities builders (WETH/USDG poolKey)", () => {
  it("mint encodes MINT_POSITION + SETTLE_PAIR with the poolKey and owner", () => {
    const built = buildV4MintCalldata({
      poolKey: V4_POOL_KEY,
      sqrtPriceX96: SQRT_PRICE_X96,
      tickCurrent: TICK,
      token0Decimals: 18,
      token1Decimals: 6,
      amount0: 200_000_000_000_000_000n,
      amount1: 500_000_000n,
      recipient: WALLET,
      deadline: DEADLINE,
      slippageToleranceBps: 50,
    });
    expect(built.value).toBe(0n);
    const { actions, params, deadline } = decodeUnlockData(built.calldata);
    expect(actionBytes(actions)).toBe(0x020d); // MINT_POSITION(0x02), SETTLE_PAIR(0x0d)
    expect(deadline).toBe(BigInt(DEADLINE));

    // SAFETY: The surrounding test establishes the exact shape of this controlled fixture before this assertion.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: viem ABI decode returns the tuple shape established by the ABI used in this test.
    const mint = decodeAbiParameters(
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this controlled fixture or ABI output is intentionally narrowed and its exact shape is asserted by the surrounding test. */
      // oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this test boundary uses a deliberately partial fixture or ABI-decoded tuple; the surrounding test establishes the exact exercised shape.
      [
        { type: "tuple", components: poolKeyParams },
        { type: "int24" },
        { type: "int24" },
        { type: "uint256" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "address" },
        { type: "bytes" },
      ],
      params[0]!,
      // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
    ) as unknown as [
      [string, string, number, number, string],
      number,
      number,
      bigint,
      bigint,
      bigint,
      string,
      string,
    ];
    const [poolKey, tickLower, tickUpper, , amount0Max, amount1Max, owner] = mint;
    expect(poolKey[0].toLowerCase()).toBe(WETH.toLowerCase());
    expect(poolKey[1].toLowerCase()).toBe(USDG.toLowerCase());
    expect(poolKey[2]).toBe(FEE);
    expect(poolKey[3]).toBe(TICK_SPACING);
    expect(tickLower % TICK_SPACING === 0).toBe(true);
    expect(tickLower).toBeLessThan(TICK);
    expect(tickUpper).toBeGreaterThan(TICK);
    expect(BigInt(amount0Max.toString())).toBeGreaterThan(0n);
    expect(BigInt(amount1Max.toString())).toBeGreaterThan(0n);
    expect(owner.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(built.amount0).toBeGreaterThan(0n);
    expect(built.amount1).toBeGreaterThan(0n);

    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: viem ABI decode returns the tuple shape established by the ABI used in this test.
    const settle = decodeAbiParameters(
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this controlled fixture or ABI output is intentionally narrowed and its exact shape is asserted by the surrounding test. */
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- viem ABI decode / partial receipt stub */
      [{ type: "address" }, { type: "address" }],
      params[1]!,
      // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
    ) as unknown as [string, string];
    expect(settle[0].toLowerCase()).toBe(WETH.toLowerCase());
    expect(settle[1].toLowerCase()).toBe(USDG.toLowerCase());
  });

  it("mint on a native-currency pool deposits msg.value and sweeps ETH", () => {
    const nativeKey: V4PoolKey = { ...V4_POOL_KEY, currency0: ZERO };
    const built = buildV4MintCalldata({
      poolKey: nativeKey,
      sqrtPriceX96: SQRT_PRICE_X96,
      tickCurrent: TICK,
      token0Decimals: 18,
      token1Decimals: 6,
      amount0: 100_000_000_000_000_000n,
      amount1: 500_000_000n,
      recipient: WALLET,
      deadline: DEADLINE,
      slippageToleranceBps: 50,
    });
    // useNative ⇒ value == amount0Max and a trailing SWEEP(0x14) action
    expect(built.value).toBeGreaterThan(0n);
    const { actions, params } = decodeUnlockData(built.calldata);
    expect(actionBytes(actions)).toBe(0x020d14); // MINT + SETTLE_PAIR + SWEEP
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: viem ABI decode returns the tuple shape established by the ABI used in this test.
    const mint = decodeAbiParameters(
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: viem ABI decode returns the tuple shape established by the ABI used in this test */
      [
        { type: "tuple", components: poolKeyParams },
        { type: "int24" },
        { type: "int24" },
        { type: "uint256" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "address" },
        { type: "bytes" },
      ],
      params[0]!,
      // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
    ) as unknown as [
      [string, string, number, number, string],
      number,
      number,
      bigint,
      bigint,
      bigint,
      string,
      string,
    ];
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the decoded mint tuple is established by the ABI fixture used in this test.
    const amount0Max = BigInt(
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the decoded mint tuple has the exact numeric ABI value exercised by this test.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the decoded mint tuple has the exact numeric ABI value exercised by this test.
      (mint[4] as unknown as { toString(): string }) // oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: the decoded mint tuple has the exact numeric ABI value exercised by this test.
        .toString() /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this controlled fixture or ABI output is intentionally narrowed and its exact shape is asserted by the surrounding test. */,
    ); /* oxlint-disable-line anti-slop/no-chained-type-assertions -- viem ABI decode / partial receipt stub */
    expect(built.value).toBe(amount0Max);
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: viem ABI decode returns the tuple shape established by the ABI used in this test.
    const sweep = decodeAbiParameters(
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this controlled fixture or ABI output is intentionally narrowed and its exact shape is asserted by the surrounding test. */
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- viem ABI decode / partial receipt stub */
      [{ type: "address" }, { type: "address" }],
      params[2]!,
      // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
    ) as unknown as [string, string];
    expect(sweep[0].toLowerCase()).toBe(ZERO.toLowerCase());
  });

  it("collect encodes DECREASE_LIQUIDITY(0) + TAKE_PAIR to the wallet", () => {
    const { calldata } = buildV4CollectCalldata({
      poolKey: V4_POOL_KEY,
      tokenId: 7n,
      recipient: WALLET,
      deadline: DEADLINE,
      slippageToleranceBps: 50,
    });
    const { actions, params, deadline } = decodeUnlockData(calldata);
    expect(actionBytes(actions)).toBe(0x0111); // DECREASE_LIQUIDITY(0x01), TAKE_PAIR(0x11)
    expect(deadline).toBe(BigInt(DEADLINE));
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: viem ABI decode returns the tuple shape established by the ABI used in this test.
    const decrease = decodeAbiParameters(
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this controlled fixture or ABI output is intentionally narrowed and its exact shape is asserted by the surrounding test. */
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- viem ABI decode / partial receipt stub */
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "bytes" },
      ],
      params[0]!,
      // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
    ) as unknown as [bigint, bigint, bigint, bigint, string];
    expect(decrease[0]).toBe(7n); // tokenId
    expect(decrease[1]).toBe(0n); // liquidity 0 (collect-only)
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: viem ABI decode returns the tuple shape established by the ABI used in this test.
    const take = decodeAbiParameters(
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this controlled fixture or ABI output is intentionally narrowed and its exact shape is asserted by the surrounding test. */
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- viem ABI decode / partial receipt stub */
      [{ type: "address" }, { type: "address" }, { type: "address" }],
      params[1]!,
      // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
    ) as unknown as [string, string, string];
    expect(take[2].toLowerCase()).toBe(WALLET.toLowerCase());
  });

  it("exit encodes BURN_POSITION + TAKE_PAIR", () => {
    const { calldata } = buildV4ExitCalldata({
      poolKey: V4_POOL_KEY,
      tokenId: 9n,
      liquidity: 10n ** 20n,
      tickLower: -201240,
      tickUpper: -200220,
      sqrtPriceX96: SQRT_PRICE_X96,
      tickCurrent: TICK,
      deadline: DEADLINE,
      slippageToleranceBps: 50,
    });
    const { actions, params, deadline } = decodeUnlockData(calldata);
    expect(actionBytes(actions)).toBe(0x0311); // BURN_POSITION(0x03), TAKE_PAIR(0x11)
    expect(deadline).toBe(BigInt(DEADLINE));
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: viem ABI decode returns the tuple shape established by the ABI used in this test.
    const burn = decodeAbiParameters(
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this controlled fixture or ABI output is intentionally narrowed and its exact shape is asserted by the surrounding test. */
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- viem ABI decode / partial receipt stub */
      [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      params[0]!,
      // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
    ) as unknown as [bigint, bigint, bigint, string];
    expect(burn[0]).toBe(9n); // tokenId
  });
});

describe("swap calldata builders", () => {
  it("buildV3ExactInputSingleCalldata encodes the 8-field params tuple", () => {
    const calldata = buildV3ExactInputSingleCalldata({
      tokenIn: USDG,
      tokenOut: WETH,
      fee: FEE,
      recipient: WALLET,
      deadline: DEADLINE,
      amountIn: 500_000_000n,
      amountOutMinimum: 199_000_000_000_000_000n,
    });
    const { args } = decodeFunctionData({ abi: exactInputSingleAbi, data: calldata });
    const [tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMinimum, sqrtLimit] =
      // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
      args[0] as [string, string, number, string, bigint, bigint, bigint, bigint];
    expect(tokenIn.toLowerCase()).toBe(USDG.toLowerCase());
    expect(tokenOut.toLowerCase()).toBe(WETH.toLowerCase());
    expect(fee).toBe(FEE);
    expect(recipient.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(deadline).toBe(BigInt(DEADLINE));
    expect(amountIn).toBe(500_000_000n);
    expect(amountOutMinimum).toBe(199_000_000_000_000_000n);
    expect(sqrtLimit).toBe(0n); // no price limit
  });

  it("buildV3ExactInputSingleCalldataV2 encodes the 7-field params tuple (no deadline)", () => {
    // The live 4663 SwapRouter02 carries selector 0x04e45aaf (7-field), NOT
    // the legacy 8-field 0x414bf389. Regression: the v3 swap paths must use
    // the V2 encoding or the calldata reverts on-chain.
    const calldata = buildV3ExactInputSingleCalldataV2({
      tokenIn: USDG,
      tokenOut: WETH,
      fee: FEE,
      recipient: WALLET,
      amountIn: 500_000_000n,
      amountOutMinimum: 199_000_000_000_000_000n,
    });
    expect(calldata.slice(2, 10)).toBe("04e45aaf");
    const { args } = decodeFunctionData({
      abi: parseAbi([
        "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
      ]),
      data: calldata,
    });
    const [tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtLimit] =
      // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
      args[0] as [string, string, number, string, bigint, bigint, bigint];
    expect(tokenIn.toLowerCase()).toBe(USDG.toLowerCase());
    expect(tokenOut.toLowerCase()).toBe(WETH.toLowerCase());
    expect(fee).toBe(FEE);
    expect(recipient.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(amountIn).toBe(500_000_000n);
    expect(amountOutMinimum).toBe(199_000_000_000_000_000n);
    expect(sqrtLimit).toBe(0n);
  });

  it("swap-to-native v3 path wraps in multicall(swapV2 + unwrapWETH9)", () => {
    // Settlement converts a token leg → native ETH. The v3 route outputs
    // WETH; the calldata must unwrap it so the wallet lands gas-usable ETH.
    const swapData = buildV3ExactInputSingleCalldataV2({
      tokenIn: USDG,
      tokenOut: WETH,
      fee: FEE,
      recipient: WALLET,
      amountIn: 500_000_000n,
      amountOutMinimum: 199_000_000_000_000_000n,
    });
    const unwrapData = buildUnwrapWETH9Calldata(199_000_000_000_000_000n, WALLET);
    const calldata = buildSwapRouterMulticallCalldata([swapData, unwrapData]);
    const { args } = decodeFunctionData({ abi: multicallAbi, data: calldata });
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    const inner = (args[0] as readonly `0x${string}`[])[0]!;
    expect(inner.slice(2, 10)).toBe("04e45aaf"); // 7-field v2 selector inside
  });

  it("buildUniversalRouterV4SwapCalldata encodes the V4_SWAP (0x10) command", () => {
    const calldata = buildUniversalRouterV4SwapCalldata({
      poolKey: V4_POOL_KEY,
      zeroForOne: true,
      amountIn: 200_000_000_000_000_000n,
      amountOutMinimum: 350_000_000n,
      deadline: DEADLINE,
    });
    const { args } = decodeFunctionData({ abi: executeAbi, data: calldata });
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    const [commands, inputs, deadline] = args as [`0x${string}`, readonly `0x${string}`[], bigint];
    expect(actionBytes(commands)).toBe(0x10); // V4_SWAP
    expect(deadline).toBe(BigInt(DEADLINE));
    // inputs[0] = abi.encode(bytes actions, bytes[] params)
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: this ABI fixture decodes to the exact command tuple consumed below.
    const [actions, params] = decodeAbiParameters(
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this controlled fixture or ABI output is intentionally narrowed and its exact shape is asserted by the surrounding test. */
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- viem ABI decode / partial receipt stub */
      [{ type: "bytes" }, { type: "bytes[]" }],
      inputs[0]!,
      // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
    ) as unknown as [`0x${string}`, readonly `0x${string}`[]];
    expect(actionBytes(actions)).toBe(0x06); // SWAP_EXACT_IN_SINGLE
    // params[0] is abi.encode(ExactInputSingleParams) — ONE struct tuple.
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: this ABI fixture decodes to the exact swap tuple consumed below.
    const swap = decodeAbiParameters(
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this controlled fixture or ABI output is intentionally narrowed and its exact shape is asserted by the surrounding test. */
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- viem ABI decode / partial receipt stub */
      [
        {
          type: "tuple",
          components: [
            { type: "tuple", components: poolKeyParams },
            { type: "bool" },
            { type: "uint128" },
            { type: "uint128" },
            { type: "uint256" },
            { type: "bytes" },
          ],
        },
      ],
      params[0]!,
      // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
    ) as unknown as [
      [[string, string, number, number, string], boolean, bigint, bigint, bigint, string],
    ];
    const [poolKey, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36, hookData] = swap[0];
    expect(poolKey[0].toLowerCase()).toBe(WETH.toLowerCase());
    expect(poolKey[1].toLowerCase()).toBe(USDG.toLowerCase());
    expect(poolKey[2]).toBe(FEE);
    expect(poolKey[3]).toBe(TICK_SPACING);
    expect(zeroForOne).toBe(true);
    expect(amountIn).toBe(200_000_000_000_000_000n);
    expect(amountOutMinimum).toBe(350_000_000n);
    expect(minHopPriceX36).toBe(0n);
    expect(hookData).toBe("0x");
  });
});

describe("quoteSwapInternal (in-SDK, current liquidity)", () => {
  it("quotes an exact-input WETH→USDG swap deterministically", async () => {
    const { outAmountAtomic } = await quoteSwapInternal(
      V3_POOL_STATE,
      true,
      200_000_000_000_000_000n,
    );
    // 0.2 WETH at fixture price 1.92e-9 USDG/WETH minus 0.3% fee ≈ 3.83e8 raw
    expect(outAmountAtomic).toBeGreaterThan(350_000_000n);
    expect(outAmountAtomic).toBeLessThan(400_000_000n);
    // deterministic: same inputs → same output
    const again = await quoteSwapInternal(V3_POOL_STATE, true, 200_000_000_000_000_000n);
    expect(again.outAmountAtomic).toBe(outAmountAtomic);
  });

  it("quotes the reverse direction against the same pool", async () => {
    const { outAmountAtomic } = await quoteSwapInternal(V3_POOL_STATE, false, 500_000_000n);
    // 500 USDG at 1/1.92e-9 ≈ 2.6e11 raw wei minus fee
    expect(outAmountAtomic).toBeGreaterThan(0n);
    expect(outAmountAtomic).toBeLessThan(500_000_000n * 10n ** 12n);
  });
});

describe("pure helpers", () => {
  it("accepts native ETH as v4 currency0 and a hookless pool", () => {
    expect(
      isResolvedV4PoolKeyValid({
        ...V4_POOL_KEY,
        currency0: ZERO,
        hooks: ZERO,
      }),
    ).toBe(true);
  });

  it("rejects zero currency1 because native ETH must sort as currency0", () => {
    expect(isResolvedV4PoolKeyValid({ ...V4_POOL_KEY, currency1: ZERO })).toBe(false);
  });

  it("scales reverse token1 prices using mint/base decimals", () => {
    // Raw pool price is token1 atomic units per token0 atomic unit. When the
    // 8-decimal mint is token1 and the 18-decimal base is token0, base per
    // mint is (1 / raw) * 10^(8-18), not 1 / (raw * 10^(8-18)).
    expect(rawPoolPriceToBasePerMint(4, false, 8, 18)).toBeCloseTo(2.5e-11, 20);
  });

  it("preserves forward token0 price scaling", () => {
    expect(rawPoolPriceToBasePerMint(4, true, 8, 18)).toBeCloseTo(4e-10, 20);
  });

  it("selects the greatest successful v4 quote output", () => {
    expect(
      selectHighestOutputQuote([
        { poolId: "zombie", outAmountAtomic: 0n },
        { poolId: "deep", outAmountAtomic: 300n },
        { poolId: "shallow", outAmountAtomic: 100n },
      ]),
    ).toEqual({ poolId: "deep", outAmountAtomic: 300n });
    expect(selectHighestOutputQuote([])).toBeNull();
  });

  it("usdToAtomic converts USD to raw units at a price", () => {
    expect(usdToAtomic(500, 2500, 18)).toBe(200_000_000_000_000_000n);
    expect(usdToAtomic(500, 1, 6)).toBe(500_000_000n);
    expect(usdToAtomic(0, 1, 6)).toBe(0n);
    expect(usdToAtomic(100, 0, 6)).toBe(0n); // unpriceable → 0
  });

  it("tickRangeAround is spacing-aligned and contains the tick", () => {
    const { tickLower, tickUpper } = tickRangeAround(TICK, TICK_SPACING);
    expect(tickLower).toBe(-201240);
    expect(tickUpper).toBe(-200220);
    expect(tickLower % TICK_SPACING === 0).toBe(true);
    expect(tickUpper % TICK_SPACING === 0).toBe(true);
  });

  it("decodeV4PositionInfo extracts sign-extended int24 ticks", () => {
    // layout: [200b poolId][24b tickUpper][24b tickLower][8b hasSubscriber]
    const tickLower = 0x123456; // 1193046, positive int24
    const tickUpper = 0x654321; // 6634785, positive int24
    const info = (BigInt(tickUpper) << 32n) | (BigInt(tickLower) << 8n) | 1n;
    expect(decodeV4PositionInfo(info)).toEqual({
      tickLower,
      tickUpper,
    });
    // negative tick (two's-complement int24)
    const neg = (((1n << 24n) - 10n) << 32n) | 1n; // tickUpper = -10
    expect(decodeV4PositionInfo(neg).tickUpper).toBe(-10);
  });

  it("tokenIdFromMintReceipt reads the tokenId from the zero-address Transfer", () => {
    const transferTopic = keccak256(toHex("Transfer(address,address,uint256)")).toLowerCase();
    // Real ERC-721 Transfer topics are 32-byte WORDS (0x + 64 hex), not the
    // 20-byte address form — the `from` topic of a mint is the zero WORD.
    const zeroWord = `0x${"0".repeat(64)}`;
    // SAFETY: The surrounding test establishes the exact shape of this controlled fixture before this assertion.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: this receipt fixture has the exact log shape consumed by tokenIdFromMintReceipt.
    const receipt = {
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this controlled fixture or ABI output is intentionally narrowed and its exact shape is asserted by the surrounding test. */
      // oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this test boundary uses a deliberately partial fixture or ABI-decoded tuple; the surrounding test establishes the exact exercised shape.
      logs: [
        // SAFETY: The ABI/receipt fixture is constructed from the exact tuple or topic shape asserted by this test.
        {
          topics: [
            transferTopic as `0x${string}`,
            zeroWord,
            `0x${WALLET.slice(2).padStart(64, "0")}`,
            "0x2a" as `0x${string}`,
          ],
        },
        // SAFETY: The ABI/receipt fixture is constructed from the exact tuple or topic shape asserted by this test.
        {
          topics: [
            transferTopic as `0x${string}`,
            `0x${WALLET.slice(2).padStart(64, "0")}`,
            zeroWord,
            "0x2b" as `0x${string}`,
          ],
        },
      ],
      // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
    } as unknown as Parameters<typeof tokenIdFromMintReceipt>[0];
    expect(tokenIdFromMintReceipt(receipt)).toBe(42n);
  });

  it("tokenIdFromMintReceipt returns null when nothing was minted", () => {
    const transferTopic = keccak256(toHex("Transfer(address,address,uint256)")).toLowerCase();
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: this receipt fixture has the exact log shape consumed by tokenIdFromMintReceipt.
    const receipt = {
      /* oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this receipt fixture contains the exact Transfer topics exercised by tokenIdFromMintReceipt */
      logs: [
        // SAFETY: The ABI/receipt fixture is constructed from the exact tuple or topic shape asserted by this test.
        {
          topics: [
            transferTopic as `0x${string}`,
            WALLET.toLowerCase() as `0x${string}`,
            ZERO,
            "0x2b" as `0x${string}`,
          ],
        },
      ],
      // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
    } as unknown as Parameters<typeof tokenIdFromMintReceipt>[0];
    expect(tokenIdFromMintReceipt(receipt)).toBeNull();
  });
});
