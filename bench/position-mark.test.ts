import { describe, it, expect } from "vitest";
import { Pool, Position, TickMath } from "@uniswap/v3-sdk";
import { Token } from "@uniswap/sdk-core";
import JSBI from "jsbi";
import { positionAmountsAtSqrtPrice } from "../engine/adapter-service.js";

// The live position mark prices REAL holdings via positionAmountsAtSqrtPrice
// (sqrt-price-bounded amount math, Q64.96). Cross-check it against the
// @uniswap/v3-sdk's own Position.amount0/amount1 — the same math, independent
// implementation. The old liquidity-heuristic mark (liquidity/1e18 × price × 2)
// undervalued 18/6 pools ~20,000x and locked the challenge hard floor; this
// test pins the replacement.

const token0 = new Token(4663, "0x0bd7d308f8e1639fab988df18a8011f41eacad73", 18); // WETH-like
const token1 = new Token(4663, "0x5fc5360d0400a0fd4f2af552add042d716f1d168", 6); // USDG-like

// The installed v3-sdk build is JSBI-based (not native bigint): adapt at the
// boundary. tickCurrent is derived from the price so the Pool's PRICE_BOUNDS
// invariant holds for out-of-range prices too.
const sdkAmounts = (liquidity: bigint, tickLower: number, tickUpper: number, sqrtPriceX96: bigint) => {
  const j = (v: bigint) => JSBI.BigInt(v.toString());
  const tickCurrent = TickMath.getTickAtSqrtRatio(j(sqrtPriceX96));
  const pool = new Pool(token0, token1, 3000, j(sqrtPriceX96), j(liquidity), tickCurrent);
  const position = new Position({ pool, liquidity: j(liquidity), tickLower, tickUpper });
  return {
    amount0: BigInt(position.amount0.quotient.toString()),
    amount1: BigInt(position.amount1.quotient.toString()),
  };
};

describe("positionAmountsAtSqrtPrice (position mark math)", () => {
  it("matches the v3 SDK amounts across below/in/above range", () => {
    const liquidity = 1_000_000n;
    // Aligned to the 0.3% tier's 60-tick spacing (SDK Position requires it).
    const tickLower = -480;
    const tickUpper = 480;
    const pa = BigInt(TickMath.getSqrtRatioAtTick(tickLower).toString());
    const pb = BigInt(TickMath.getSqrtRatioAtTick(tickUpper).toString());

    // Below range (p well below pa): all token0. Points are chosen well
    // inside each region — the SDK branches on tickCurrent vs tick bounds,
    // this function on sqrt-price bounds, so they agree except within a
    // half-spacing of the boundary.
    const span = pb - pa;
    const belowP = pa - span / 4n;
    const below = positionAmountsAtSqrtPrice(liquidity, tickLower, tickUpper, belowP);
    expect(below.amount1).toBe(0n);
    expect(below.amount0).toBeGreaterThan(0n);
    expect(below).toEqual(sdkAmounts(liquidity, tickLower, tickUpper, belowP));

    // In range: both legs, amounts cross-checked against the SDK.
    const mid = pa + span / 2n;
    const inRange = positionAmountsAtSqrtPrice(liquidity, tickLower, tickUpper, mid);
    expect(inRange.amount0).toBeGreaterThan(0n);
    expect(inRange.amount1).toBeGreaterThan(0n);
    expect(inRange).toEqual(sdkAmounts(liquidity, tickLower, tickUpper, mid));

    // Above range (p well above pb): all token1.
    const aboveP = pb + span / 4n;
    const above = positionAmountsAtSqrtPrice(liquidity, tickLower, tickUpper, aboveP);
    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBeGreaterThan(0n);
    expect(above).toEqual(sdkAmounts(liquidity, tickLower, tickUpper, aboveP));
  });

  it("monotonic: raising the price shifts token0 into token1", () => {
    const liquidity = 5_000_000n;
    const tickLower = -1000;
    const tickUpper = 1000;
    const pa = BigInt(TickMath.getSqrtRatioAtTick(tickLower).toString());
    const pb = BigInt(TickMath.getSqrtRatioAtTick(tickUpper).toString());
    const p1 = pa + (pb - pa) / 3n;
    const p2 = pa + ((pb - pa) * 2n) / 3n;
    const a = positionAmountsAtSqrtPrice(liquidity, tickLower, tickUpper, p1);
    const b = positionAmountsAtSqrtPrice(liquidity, tickLower, tickUpper, p2);
    expect(b.amount0).toBeLessThan(a.amount0);
    expect(b.amount1).toBeGreaterThan(a.amount1);
  });

  it("produces sane USD-scale amounts for a WETH/USDG-style position", () => {
    // ~$10 position on the real WETH/USDG pool (tick -200723, price ~1919).
    const tick = -200723;
    const tickLower = tick - 300;
    const tickUpper = tick + 300;
    const sqrtPriceX96 = BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
    // Liquidity chosen so the position holds roughly $5-8 of each leg
    // (~$10-15 total at WETH $1919 / USDG $1 on this pool).
    const liquidity = 10_000_000_000_000n;
    const { amount0, amount1 } = positionAmountsAtSqrtPrice(
      liquidity,
      tickLower,
      tickUpper,
      sqrtPriceX96,
    );
    // WETH leg: 18 decimals, ~$1919; USDG leg: 6 decimals, $1.
    const usd0 = (Number(amount0) / 1e18) * 1919;
    const usd1 = Number(amount1) / 1e6;
    const total = usd0 + usd1;
    // The old heuristic returned (liquidity/1e18)*price*2 ≈ 2e9/1e18*1919*2 ≈ 7.7e-6.
    expect(total).toBeGreaterThan(1); // real dollars, not micro-dollars
    expect(total).toBeLessThan(1_000);
  });
});
