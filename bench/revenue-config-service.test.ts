import { describe, it, expect } from "vitest";
import { parseRevenueConfig } from "../engine/revenue-config-service.js";

describe("parseRevenueConfig", () => {
  it("parses a full config with every field", () => {
    const cfg = parseRevenueConfig({
      tier: "pro",
      platformFeeRate: 0.05,
      revenueShareEnabled: true,
      revenueShareOperatorPct: 0.2,
      feeWalletAddress: "0xabc",
    });
    expect(cfg).toEqual({
      tier: "pro",
      platformFeeRate: 0.05,
      revenueShareEnabled: true,
      revenueShareOperatorPct: 0.2,
      feeWalletAddress: "0xabc",
    });
  });

  it("returns null for non-object payloads", () => {
    expect(parseRevenueConfig(null)).toBeNull();
    expect(parseRevenueConfig("x")).toBeNull();
    expect(parseRevenueConfig(42)).toBeNull();
  });

  it("defaults missing or wrong-typed fields to safe free-tier values", () => {
    const cfg = parseRevenueConfig({
      tier: 123,
      platformFeeRate: "nope",
      revenueShareEnabled: "yes",
      revenueShareOperatorPct: null,
      feeWalletAddress: 7,
    });
    expect(cfg).toEqual({
      tier: "free",
      platformFeeRate: 0,
      revenueShareEnabled: false,
      revenueShareOperatorPct: 0,
      feeWalletAddress: "",
    });
  });

  it("keeps valid fields while defaulting only the invalid ones", () => {
    const cfg = parseRevenueConfig({ tier: "fund", platformFeeRate: 0.1 });
    expect(cfg!.tier).toBe("fund");
    expect(cfg!.platformFeeRate).toBe(0.1);
    expect(cfg!.revenueShareEnabled).toBe(false);
    expect(cfg!.revenueShareOperatorPct).toBe(0);
    expect(cfg!.feeWalletAddress).toBe("");
  });
});