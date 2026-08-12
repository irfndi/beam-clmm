import { describe, it, expect } from "vitest";
import { parseRugCheckReport, getRugCheckReport } from "../engine/rugcheck-service.js";

// ─── parseRugCheckReport ──────────────────────────────────────────────────────

describe("parseRugCheckReport", () => {
  it("returns null for non-object payloads or a missing mint", () => {
    expect(parseRugCheckReport(null)).toBeNull();
    expect(parseRugCheckReport("x")).toBeNull();
    expect(parseRugCheckReport({})).toBeNull();
    expect(parseRugCheckReport({ mint: "" })).toBeNull();
  });

  it("parses a full report with risks, holders, authorities and meta", () => {
    const report = parseRugCheckReport({
      mint: "Mint123",
      score_normalised: "56",
      rugged: true,
      token: { mintAuthority: "Auth1", freezeAuthority: "Freeze1" },
      tokenMeta: { mutable: true },
      totalHolders: 100,
      risks: [
        { name: "mint-authority", value: "enabled", description: "risky", level: "danger" },
        { name: "low-liquidity", value: null, level: "warn" },
        { name: "benign", level: "info" },
        { name: 42, level: 7 }, // non-string fields degrade
      ],
      topHolders: [
        { address: "H1", owner: "Owner1", pct: "30", insider: true },
        { address: "H2", owner: null, pct: 20, insider: false },
        { address: "", pct: 10 }, // empty address → skipped
        null,
        { address: "H3", pct: "bad" }, // bad pct → skipped
      ],
    });
    expect(report).not.toBeNull();
    expect(report!.mint).toBe("Mint123");
    expect(report!.scoreNormalised).toBe(56);
    expect(report!.rugged).toBe(true);
    expect(report!.mintAuthority).toBe("Auth1");
    expect(report!.freezeAuthority).toBe("Freeze1");
    expect(report!.tokenMetaMutable).toBe(true);
    expect(report!.totalHolders).toBe(100);
    expect(report!.risks).toHaveLength(4);
    expect(report!.dangerRiskCount).toBe(1);
    expect(report!.topHolders).toHaveLength(2);
    expect(report!.top10HolderPct).toBe(50);
  });

  it("degrades absent/empty structures to nulls and empty lists", () => {
    const report = parseRugCheckReport({ mint: "MintX" });
    expect(report).not.toBeNull();
    expect(report!.scoreNormalised).toBeNull();
    expect(report!.rugged).toBe(false);
    expect(report!.mintAuthority).toBeNull();
    expect(report!.freezeAuthority).toBeNull();
    expect(report!.tokenMetaMutable).toBeNull();
    expect(report!.totalHolders).toBeNull();
    expect(report!.risks).toEqual([]);
    expect(report!.topHolders).toEqual([]);
    expect(report!.top10HolderPct).toBeNull();
    expect(report!.dangerRiskCount).toBe(0);
  });

  it("treats non-boolean rugged and non-object token/tokenMeta conservatively", () => {
    const report = parseRugCheckReport({
      mint: "MintY",
      rugged: "yes",
      token: "not-an-object",
      tokenMeta: null,
    });
    expect(report!.rugged).toBe(false);
    expect(report!.mintAuthority).toBeNull();
    expect(report!.tokenMetaMutable).toBeNull();
  });
});

// ─── getRugCheckReport ────────────────────────────────────────────────────────

describe("getRugCheckReport", () => {
  const okBody = {
    mint: "Mint123",
    score_normalised: 20,
    rugged: false,
    risks: [{ name: "x", level: "warn" }],
  };

  it("fetches and parses a report on success", async () => {
    const fetchImpl = async () => Response.json(okBody);
    const report = await getRugCheckReport("Mint123", { fetchImpl });
    expect(report).not.toBeNull();
    expect(report!.mint).toBe("Mint123");
    expect(report!.scoreNormalised).toBe(20);
  });

  it("returns null on a non-ok HTTP status", async () => {
    const fetchImpl = async () => new Response("nf", { status: 404 });
    const report = await getRugCheckReport("Mint123", { fetchImpl });
    expect(report).toBeNull();
  });

  it("returns null on an unparseable payload", async () => {
    const fetchImpl = async () => Response.json({ data: null });
    const report = await getRugCheckReport("Mint123", { fetchImpl });
    expect(report).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchImpl = async () => {
      throw new Error("down");
    };
    const report = await getRugCheckReport("Mint123", { fetchImpl });
    expect(report).toBeNull();
  });
});
