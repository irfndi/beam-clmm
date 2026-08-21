import { describe, expect, it } from "vitest";
import {
  rawRatioToUsd,
  rawTickToUsd,
  verifiedUsdPair,
  verifiedUsdPairFromMetadata,
} from "../ops/verified-usd-price.js";

describe("verified USD pool price conversion", () => {
  it("converts an ETH/USDG raw atomic ratio into ETH USD", () => {
    const pair = verifiedUsdPair("ETH", "USDG");
    expect(pair).not.toBeNull();
    expect(rawRatioToUsd(1.9e-9, pair!)).toBeCloseTo(1_900, 6);
  });

  it("inverts a USDG/ETH ratio into the token1 USD price", () => {
    const pair = verifiedUsdPair("USDG", "ETH");
    expect(pair).not.toBeNull();
    expect(rawRatioToUsd(1 / 1.9e-9, pair!)).toBeCloseTo(1_900, 6);
  });

  it("rejects pairs without an explicit stable leg", () => {
    expect(verifiedUsdPair("ETH", "TOKEN")).toBeNull();
    expect(verifiedUsdPair("TOKEN", "TOKEN")).toBeNull();
  });

  it("uses persisted stable addresses and leg price", () => {
    const pair = verifiedUsdPairFromMetadata({
      tokenXAddress: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
      tokenYAddress: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      tokenXDecimals: 18,
      tokenYDecimals: 6,
      tokenYPriceUsd: 0.99,
    });
    expect(pair).not.toBeNull();
    expect(rawRatioToUsd(1.9e-9, pair!)).toBeCloseTo(1_881, 6);
  });

  it("rejects symbol-only stable labels when an address is present but not allowlisted", () => {
    expect(
      verifiedUsdPairFromMetadata({
        tokenXAddress: "0x0000000000000000000000000000000000000001",
        tokenYAddress: "0x0000000000000000000000000000000000000002",
        tokenXSymbol: "ETH",
        tokenYSymbol: "USDC",
        tokenXDecimals: 18,
        tokenYDecimals: 6,
      }),
    ).toBeNull();
  });

  it("keeps the symbol fallback for legacy rows without addresses", () => {
    expect(
      verifiedUsdPairFromMetadata({ tokenXSymbol: "ETH", tokenYSymbol: "USDC" }),
    ).not.toBeNull();
  });

  it("converts tick bounds with the same decimal-aware unit", () => {
    const pair = verifiedUsdPair("ETH", "USDG");
    expect(pair).not.toBeNull();
    expect(rawTickToUsd(0, pair!)).toBeCloseTo(1e12, 3);
  });
});
