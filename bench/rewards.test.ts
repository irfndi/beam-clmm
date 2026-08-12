import { describe, it, expect } from "vitest";
import {
  summarizeRewardClaim,
  buildRewardClaimMetadata,
  type ClaimedReward,
} from "../engine/rewards.js";

describe("summarizeRewardClaim", () => {
  it("sums USD-priced rewards and counts unpriced ones", () => {
    const rewards: ClaimedReward[] = [
      { mint: "A", amountAtomic: 100, amountUsd: 10 },
      { mint: "B", amountAtomic: 5, amountUsd: 7.5 },
      { mint: "C", amountAtomic: 1, amountUsd: null },
    ];
    const summary = summarizeRewardClaim(rewards);
    expect(summary.totalUsd).toBeCloseTo(17.5, 8);
    expect(summary.unpricedCount).toBe(1);
    expect(summary.totalCount).toBe(3);
  });

  it("handles all-priced and all-unpriced inputs", () => {
    expect(
      summarizeRewardClaim([
        { mint: "A", amountAtomic: 1, amountUsd: 2 },
        { mint: "B", amountAtomic: 1, amountUsd: 3 },
      ]),
    ).toEqual({ totalUsd: 5, unpricedCount: 0, totalCount: 2 });

    expect(
      summarizeRewardClaim([
        { mint: "A", amountAtomic: 1, amountUsd: null },
        { mint: "B", amountAtomic: 1, amountUsd: null },
      ]),
    ).toEqual({ totalUsd: 0, unpricedCount: 2, totalCount: 2 });
  });

  it("returns zeros for an empty reward list", () => {
    expect(summarizeRewardClaim([])).toEqual({
      totalUsd: 0,
      unpricedCount: 0,
      totalCount: 0,
    });
  });
});

describe("buildRewardClaimMetadata", () => {
  it("builds an lm_reward payload with tx signatures and reward slots", () => {
    const meta = buildRewardClaimMetadata({
      txSignatures: ["tx-1", "tx-2"],
      rewards: [
        { mint: "Mint1", amountAtomic: 500, amountUsd: 3 },
        { mint: "Mint2", amountAtomic: 1000, amountUsd: null },
      ],
    });
    expect(meta.kind).toBe("lm_reward");
    expect(meta.txSignatures).toEqual(["tx-1", "tx-2"]);
    expect(meta.rewards).toEqual([
      { mint: "Mint1", amountAtomic: 500, amountUsd: 3 },
      { mint: "Mint2", amountAtomic: 1000, amountUsd: null },
    ]);
  });

  it("copies inputs (no shared references) and tolerates empty claims", () => {
    const rewards = [{ mint: "M", amountAtomic: 1, amountUsd: 1 }];
    const meta = buildRewardClaimMetadata({ txSignatures: [], rewards });
    rewards[0]!.amountAtomic = 999;
    expect(meta.rewards).toEqual([{ mint: "M", amountAtomic: 1, amountUsd: 1 }]);
    expect(meta.txSignatures).toEqual([]);
  });
});