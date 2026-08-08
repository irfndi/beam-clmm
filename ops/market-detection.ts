/**
 * Market-detection validation harness (paper/read-only).
 *
 * Proves the EVM data layer end-to-end against Robinhood Chain mainnet:
 *   1. discovers v3 pools (PoolCreated logs)
 *   2. reads pool state for the most relevant pairs (USDG/WETH/ETH)
 *   3. prices tokens (USDG=1, WETH/ETH via v3 pool against USDG)
 *   4. reads a seeded v4 pool via StateView (getSlot0/getLiquidity)
 *
 * Run: bun ops/market-detection.ts   (needs .env with ROBINHOOD_RPC_URL)
 */
import { Effect, Layer } from "effect";
import { AdapterLive, registerV4Pool, type V4PoolKey } from "../engine/adapter-service.js";
import { ConfigLive } from "../engine/config-service.js";
import { AdapterService } from "../engine/services.js";
import { NATIVE_MINT, STABLECOIN_MINT } from "../engine/constants.js";
import { WETH9 } from "../engine/adapter-service.js";
import "../engine/load-env.js";

// Seed the verified live v4 pool (MANCER/USDG 4%, fee 39999, tickSpacing 400,
// hooks 0). PoolId computed with keccak256(abi.encode(key)) — verified
// on-chain + on GeckoTerminal (2026-08-08 research).
const V4_SEED: ReadonlyArray<{ poolId: string; key: V4PoolKey }> = [
  {
    poolId: "0x4240227225bf6704bac7e25264d6c495268462c597d2f3bb45eab93e868f2d58",
    key: {
      currency0: STABLECOIN_MINT,
      currency1: "0xc72F232a6869e6CF34dC06129AfFD07F8a2a246A",
      fee: 39999,
      tickSpacing: 400,
      hooks: "0x0000000000000000000000000000000000000000",
    },
  },
];

const program = Layer.provide(AdapterLive, ConfigLive);

await Effect.runPromise(
  Effect.gen(function* () {
    const adapter = yield* AdapterService;
    const t0 = Date.now();

    // 1. Discovery (v3 factory PoolCreated logs, full history, cached).
    const pools = yield* adapter.discoverPools(0);
    console.log(`[discovery] ${pools.length} v3 pools (${Date.now() - t0}ms)`);

    const interesting = pools
      .filter(
        (p) =>
          p.tokenX === STABLECOIN_MINT.toLowerCase() ||
          p.tokenY === STABLECOIN_MINT.toLowerCase() ||
          p.tokenX === WETH9.toLowerCase() ||
          p.tokenY === WETH9.toLowerCase() ||
          p.tokenX === NATIVE_MINT.toLowerCase() ||
          p.tokenY === NATIVE_MINT.toLowerCase(),
      )
      .sort((a, b) => b.binStep - a.binStep);

    console.log(`[discovery] ${interesting.length} USDG/WETH/ETH-paired pools`);
    for (const p of interesting.slice(0, 12)) {
      console.log(
        `  ${p.address.slice(0, 10)}… ${p.tokenX.slice(0, 6)}/${p.tokenY.slice(0, 6)} fee~${p.binStep}`,
      );
    }

    // 2. Pool state for the top candidates.
    console.log("\n[pool-state]");
    for (const p of interesting.slice(0, 6)) {
      const state = yield* adapter.getPoolState(p.address);
      console.log(
        `  ${state.address.slice(0, 10)}… ${state.tokenXSymbol}/${state.tokenYSymbol} ` +
          `tick=${state.activeBinId} price=${state.currentPrice.toFixed(6)} ` +
          `tvl≈$${Math.round(state.tvlUsd)}`,
      );
    }

    // 3. Token prices.
    const prices = yield* adapter.getTokenPrices([
      STABLECOIN_MINT,
      WETH9,
      NATIVE_MINT,
    ]);
    console.log("\n[prices]");
    for (const [mint, price] of Object.entries(prices)) {
      console.log(`  ${mint.slice(0, 8)}… = $${price}`);
    }

    // 4. v4 pool state via StateView (if seeded).
    for (const { poolId, key } of V4_SEED) {
      registerV4Pool(poolId, key);
      const state = yield* adapter.getPoolState(poolId);
      const bins = yield* adapter.getBinArray(poolId);
      console.log("\n[v4]");
      console.log(`  poolId ${poolId.slice(0, 12)}… tick=${state.activeBinId} price=${state.currentPrice.toFixed(6)}`);
      console.log(`  binArray: activeTick=${bins.activeBinId} reservesKnown=${bins.reservesKnown}`);
    }

    // 5. Wallet (paper default — likely no key configured).
    console.log(`\n[wallet] hasWallet=${adapter.hasWallet()} address=${adapter.getWalletAddress() ?? "none"}`);

    console.log(`\nOK — market detection data layer works (${Date.now() - t0}ms total)`);
  }).pipe(Effect.provide(program)),
);
