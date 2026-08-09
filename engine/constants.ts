// Robinhood Chain (EVM L2, chain id 4663) — native ETH is the gas token.
// The engine's "native" leg is ETH, and its settlement stablecoin is USDG
// (Paxos Global Dollar) — the canonical stablecoin on Robinhood Chain.
// Addresses cross-checked against Uniswap deployment docs + Blockscout (2026-07).

export const NATIVE_MINT = "0x0000000000000000000000000000000000000000"; // ETH (address zero, first-class in v4)
/** Native gas token decimals on Robinhood Chain (ETH, 18). The Solana-era
 *  settlement path priced native at 9 decimals (SOL) — every use of this
 *  constant must be chain-aware. */
export const NATIVE_DECIMALS = 18;
export const STABLECOIN_MINT = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // USDG, 6 decimals

// Pure gas + non-position fee floor (0.001 ETH). Arbitrum-class L2s need
// ~0.00001 ETH per tx; this reserve is far above realistic gas and exists to
// keep the ENTER gate from failing on a dust wallet.
export const MIN_NATIVE_FOR_GAS_WEI = 1_000_000_000_000_000n; // 0.001 ETH

// Minimum native ETH for a live ENTER (gas + token approval + position mint).
// Kept separate from the gas floor so the error message can decompose the
// reserve; the ENTER gate uses this value. 0.002 ETH (~$6) deliberately fits
// the $10-20 test-wallet plan: fund ~50/50 USDG/ETH and the gate passes
// without a top-up. Override per account via MIN_NATIVE_FOR_ENTRY_WEI.
export const MIN_NATIVE_FOR_ENTRY_WEI = 2_000_000_000_000_000n; // 0.002 ETH

// Native ETH threshold below which the entry gate tops the wallet up from the
// stablecoin leg (swap stablecoin -> ETH). Aliased to the entry reserve so the
// top-up trigger and the entry gate cannot drift.
export const NATIVE_GAS_TOP_UP_THRESHOLD_WEI = MIN_NATIVE_FOR_ENTRY_WEI;

// Fallback / floor amount of stablecoin the live-entry gas top-up swaps for
// ETH. program.ts computes a price-aware top-up sized to the entry reserve and
// uses this only as a minimum, so a flat $2 no longer blocks entry when the
// wallet has plenty of stablecoin.
export const GAS_TOP_UP_STABLECOIN = 2;
