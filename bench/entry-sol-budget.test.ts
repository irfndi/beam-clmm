import { describe, it, expect } from "vitest";
import {
  hasNativeSolLeg,
  usdToLamports,
  estimateEntrySolLamports,
  freeEntrySolLamports,
} from "../engine/entry-sol-budget.js";
import { NATIVE_MINT } from "../engine/constants.js";

describe("hasNativeSolLeg", () => {
  it("is true when either leg is native ETH", () => {
    expect(hasNativeSolLeg({ tokenX: NATIVE_MINT, tokenY: "USDC" })).toBe(true);
    expect(hasNativeSolLeg({ tokenX: "USDC", tokenY: NATIVE_MINT })).toBe(true);
  });

  it("is false for non-native pairs and absent legs", () => {
    expect(hasNativeSolLeg({ tokenX: "USDC", tokenY: "USDT" })).toBe(false);
    expect(hasNativeSolLeg({ tokenX: null, tokenY: "USDC" })).toBe(false);
    expect(hasNativeSolLeg({})).toBe(false);
  });
});

describe("usdToLamports", () => {
  it("converts USD to wei at the given price, rounding up", () => {
    // $1 at $2000/ETH → 0.0005 ETH → 5e14 wei.
    expect(usdToLamports(1, 2000)).toBe(5n * 10n ** 14n);
  });

  it("converts via ceil, matching the double-precision rational", () => {
    // 1/3 ETH = 0.333… wei; the float product lands just BELOW the true
    // rational, so ceil keeps the exact float result (333333333333333312n).
    expect(usdToLamports(1, 3)).toBe(BigInt(Math.ceil((1 / 3) * 1e18)));
    // A cleanly-representable quotient stays exact.
    expect(usdToLamports(2, 4)).toBe(5n * 10n ** 17n);
  });

  it("returns 0n for non-positive or non-finite inputs", () => {
    expect(usdToLamports(0, 2000)).toBe(0n);
    expect(usdToLamports(-5, 2000)).toBe(0n);
    expect(usdToLamports(1, 0)).toBe(0n);
    expect(usdToLamports(1, Number.NaN)).toBe(0n);
  });
});

describe("estimateEntrySolLamports", () => {
  it("funds the full entry when solFunded (autonomous live)", () => {
    const lamports = estimateEntrySolLamports({
      positionSizeUsd: 1000,
      nativePriceUsd: 2000,
      poolHasSolLeg: false,
      solFunded: true,
    });
    // 1000 × 1.01 / 2000 ETH = 0.505 ETH
    expect(lamports).toBe((505n * 10n ** 15n) / 1n);
  });

  it("funds half when the pool has a native leg but is not solFunded", () => {
    const lamports = estimateEntrySolLamports({
      positionSizeUsd: 1000,
      nativePriceUsd: 2000,
      poolHasSolLeg: true,
      solFunded: false,
    });
    // 1000 × 0.5 × 1.01 / 2000 = 0.2525 ETH
    expect(lamports).toBe(252500000000000000n);
  });

  it("uses no native funds when neither condition holds", () => {
    expect(
      estimateEntrySolLamports({
        positionSizeUsd: 1000,
        nativePriceUsd: 2000,
        poolHasSolLeg: false,
        solFunded: false,
      }),
    ).toBe(0n);
  });
});

describe("freeEntrySolLamports", () => {
  it("returns the full native balance (no reserve subtraction)", () => {
    expect(freeEntrySolLamports(123n)).toBe(123n);
    expect(freeEntrySolLamports(0n)).toBe(0n);
  });
});
