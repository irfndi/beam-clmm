import { describe, it, expect } from "vitest";
import { tokenAmountToUsd, getTokenDecimals } from "../engine/risk-service.js";

describe("getTokenDecimals", () => {
  it("returns 9 for SOL and wrapped SOL", () => {
    expect(getTokenDecimals("SOL")).toBe(9);
    expect(getTokenDecimals("WSOL")).toBe(9);
  });

  it("returns 6 for USDC and USDT", () => {
    expect(getTokenDecimals("USDC")).toBe(6);
    expect(getTokenDecimals("USDT")).toBe(6);
  });

  it("returns -1 sentinel for unknown tokens (fail-closed)", () => {
    expect(getTokenDecimals("???")).toBe(-1);
    expect(getTokenDecimals("")).toBe(-1);
    expect(getTokenDecimals("BONK")).toBe(-1);
  });
});

describe("tokenAmountToUsd", () => {
  it("converts SOL raw amount to USD using nativePriceUsd", () => {
    // 1.5 SOL raw = 1.5e9 lamports; solPrice = $150 → $225
    expect(tokenAmountToUsd(1_500_000_000, "SOL", 150)).toBeCloseTo(225);
  });

  it("converts USDC raw amount using par ($1)", () => {
    // 100 USDC raw = 100e6 base units → $100
    expect(tokenAmountToUsd(100_000_000, "USDC", 150)).toBeCloseTo(100);
  });

  it("treats USDT same as USDC", () => {
    expect(tokenAmountToUsd(50_000_000, "USDT", 150)).toBeCloseTo(50);
  });

  it("returns 0 for unknown tokens (fail-closed — do not estimate)", () => {
    expect(tokenAmountToUsd(2_000_000_000, "???", 150)).toBe(0);
    expect(tokenAmountToUsd(1_000_000_000, "BONK", 150)).toBe(0);
  });

  it("returns 0 for zero raw amount", () => {
    expect(tokenAmountToUsd(0, "SOL", 150)).toBe(0);
  });
});
