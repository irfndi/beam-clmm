import { Effect, Layer } from "effect";
import {
  createPublicClient,
  getAddress,
  getContract,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ConfigService } from "./config-service.js";
import { AdapterService, type AdapterApi, type DiscoveredPool } from "./services.js";
import type { EntryDepositMode, EntryStrategyShape } from "./types.js";
import type { BinArray, BinData, PoolState, Position } from "./types.js";
import { NATIVE_MINT, STABLECOIN_MINT } from "./constants.js";
import { createLogger } from "./logger.js";
import { DiscoverPoolsError, underlyingErrorMessage } from "./errors.js";

const logger = createLogger("EVMAdapter");

// ─── Robinhood Chain verified addresses (2026-07; Uniswap deployment docs +
//     Blockscout cross-check). Do NOT assume other-chain addresses — the
//     Uniswap docs explicitly warn deployments differ per chain.
export const CHAIN_ID = 4663;
export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const V3_FACTORY: Address = getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
export const V3_NPM: Address = getAddress("0x73991a25c818bf1f1128deaab1492d45638de0d3");
export const V3_TICK_LENS: Address = getAddress("0x7dfd4f31be6814d2906bde155c3e1b146eac1468");
export const V3_QUOTER_V2: Address = getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
export const V4_POOL_MANAGER: Address = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
export const V4_POSITION_MANAGER: Address = getAddress(
  "0x58daec3116aae6d93017baaea7749052e8a04fa7",
);
export const UNIVERSAL_ROUTER: Address = getAddress("0x8876789976decbfcbbbe364623c63652db8c0904");

/**
 * v4 pools have no per-pool contract address — identity is the PoolKey struct
 * and the poolId is keccak256(abi.encode(key)), which cannot be reversed
 * on-chain. The engine's `poolAddress` for a v4 pool is therefore the poolId
 * (lowercase 0x-hex), resolved to a PoolKey through this registry. Populate
 * entries from the Uniswap UI / explorer for the pools you manage.
 * ponytail: static registry, add a pool-indexer when v4 discovery is needed.
 */
export interface V4PoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}
export const V4_POOL_REGISTRY: Readonly<Record<string, V4PoolKey>> = {};

// ─── Minimal ABIs (only the functions this adapter calls) ────────────────────

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const v3FactoryAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "function feeAmountTickSpacing(uint24) view returns (int24)",
]);
const v3PoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const tickLensAbi = parseAbi([
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) view returns (tuple(int24,int128,uint128)[])",
]);
const v3NpmAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
const v4PoolManagerAbi = parseAbi([
  "function getSlot0(tuple(address,address,uint24,int24,address) key) view returns (uint160,int24,uint16,uint24)",
  "function getLiquidity(tuple(address,address,uint24,int24,address) key) view returns (uint128)",
  "function getPool(tuple(address,address,uint24,int24,address) key) view returns (uint256)",
]);
const v4PositionManagerAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint256 poolId, uint64 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isNative(mint: string): boolean {
  return mint.toLowerCase() === NATIVE_MINT.toLowerCase();
}

/** Uniswap tick → price of token1 in token0 (1.0001^tick). */
function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

function sqrtPriceX96ToPrice(sqrtPriceX96: bigint): number {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio;
}

const decimalsCache = new Map<string, number>();

// ─── The adapter ──────────────────────────────────────────────────────────────

const NOT_IMPLEMENTED = (what: string) =>
  Effect.fail(
    new Error(
      `${what}: live EVM execution is not implemented in this scaffold. ` +
        `The agent runs read-only (observe/reason/decide) and paper mode; ` +
        `the Uniswap v3/v4 transaction layer is the next milestone.`,
    ),
  );

export const AdapterLive = Layer.effect(AdapterService,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const rpcUrl = config.rpcUrl || DEFAULT_RPC;
    const publicClient = createPublicClient({ transport: http(rpcUrl) });

    const account = config.walletPrivateKey
      ? (() => {
          try {
            return privateKeyToAccount(config.walletPrivateKey as `0x${string}`);
          } catch {
            return null;
          }
        })()
      : null;
    const walletAddress: Address | null = account?.address ?? null;

    const erc20 = (address: Address) =>
      getContract({ address, abi: erc20Abi, client: { public: publicClient } });
    const v3Factory = () =>
      getContract({ address: V3_FACTORY, abi: v3FactoryAbi, client: { public: publicClient } });
    const v3Pool = (address: Address) =>
      getContract({ address, abi: v3PoolAbi, client: { public: publicClient } });
    const v3Npm = () =>
      getContract({ address: V3_NPM, abi: v3NpmAbi, client: { public: publicClient } });
    const tickLens = () =>
      getContract({ address: V3_TICK_LENS, abi: tickLensAbi, client: { public: publicClient } });
    const v4PoolManager = () =>
      getContract({
        address: V4_POOL_MANAGER,
        abi: v4PoolManagerAbi,
        client: { public: publicClient },
      });
    const v4PositionManager = () =>
      getContract({
        address: V4_POSITION_MANAGER,
        abi: v4PositionManagerAbi,
        client: { public: publicClient },
      });

    async function getDecimals(mint: string): Promise<number> {
      if (isNative(mint)) return 18;
      const cached = decimalsCache.get(mint.toLowerCase());
      if (cached !== undefined) return cached;
      const decimals = await erc20(getAddress(mint))
        .read.decimals()
        .catch(() => 18);
      decimalsCache.set(mint.toLowerCase(), Number(decimals));
      return Number(decimals);
    }

    async function getBalance(mint: string, owner: Address): Promise<bigint> {
      if (isNative(mint)) return publicClient.getBalance({ address: owner });
      return erc20(getAddress(mint)).read.balanceOf([owner]);
    }

    /**
     * USD price of a mint. Stablecoin → 1. Otherwise derive from a v3 pool
     * against the stablecoin (3 fee tiers), then fall back to 0 (fail-open —
     * callers treat 0 as "unpriceable"). GeckoTerminal on Robinhood Chain is
     * a follow-up; pool-derived prices are real on-chain values.
     */
    async function priceUsd(mint: string): Promise<number> {
      if (mint.toLowerCase() === STABLECOIN_MINT.toLowerCase()) return 1;
      return priceUsdViaV3Pool(mint);
    }

    /** Price of `mint` in USDG via the most liquid v3 pool. */
    async function priceUsdViaV3Pool(mint: string): Promise<number> {
      const factory = v3Factory();
      for (const fee of [3000, 500, 10_000]) {
        try {
          const pool = await factory.read.getPool([
            getAddress(mint),
            getAddress(STABLECOIN_MINT),
            fee,
          ]);
          if (pool === "0x0000000000000000000000000000000000000000") continue;
          const poolContract = v3Pool(pool);
          const [token0, slot0] = await Promise.all([
            poolContract.read.token0(),
            poolContract.read.slot0(),
          ]);
          const price = sqrtPriceX96ToPrice(slot0[0]);
          return token0.toLowerCase() === getAddress(mint).toLowerCase() ? price : 1 / price;
        } catch {
          continue;
        }
      }
      return 0;
    }

    /** One v3 pool read → engine PoolState (statsSource heuristic until a
     *  GeckoTerminal integration for Robinhood Chain lands). */
    async function v3PoolState(poolAddress: Address): Promise<PoolState> {
      const poolContract = v3Pool(poolAddress);
      const [token0, token1, tickSpacing, slot0, liquidity] = await Promise.all([
        poolContract.read.token0(),
        poolContract.read.token1(),
        poolContract.read.tickSpacing(),
        poolContract.read.slot0(),
        poolContract.read.liquidity(),
      ]);
      const tick = Number(slot0[1]);
      const price0 = await priceUsd(token0).catch(() => 0);
      const tvlUsd = (Number(liquidity) / 1e18) * (price0 || 0) * 4; // rough reserve proxy
      return {
        address: poolAddress.toLowerCase(),
        tokenX: token0.toLowerCase(),
        tokenY: token1.toLowerCase(),
        tokenXSymbol: isNative(token0) ? "ETH" : "TOKEN",
        tokenYSymbol: isNative(token1) ? "ETH" : "TOKEN",
        tvlUsd: tvlUsd || 0,
        volume24hUsd: 0,
        fees24hUsd: 0,
        apr: 0,
        activeBinId: tick,
        binStep: Number(tickSpacing),
        currentPrice: tickToPrice(tick),
        timestamp: Date.now(),
        statsSource: "heuristic" as const,
      };
    }

    /** Bin array = populated ticks around the active tick via TickLens. */
    async function v3BinArray(poolAddress: Address): Promise<BinArray> {
      const poolContract = v3Pool(poolAddress);
      const [slot0, tickSpacing] = await Promise.all([
        poolContract.read.slot0(),
        poolContract.read.tickSpacing(),
      ]);
      const activeTick = Number(slot0[1]);
      const lens = tickLens();
      const word = activeTick >> 8;
      const bins: BinData[] = [];
      for (const w of [word - 1, word, word + 1]) {
        const populated = (await lens.read.getPopulatedTicksInWord([poolAddress, w])) as unknown as ReadonlyArray<
          readonly [number, bigint, bigint]
        >;
        for (const p of populated) {
          bins.push({
            binId: Number(p[0]),
            reserveX: p[2],
            reserveY: 0n,
            liquiditySupply: p[2],
            price: tickToPrice(Number(p[0])),
          });
        }
      }
      bins.sort((a, b) => a.binId - b.binId);
      return {
        lowerBinId: bins[0]?.binId ?? activeTick,
        upperBinId: bins[bins.length - 1]?.binId ?? activeTick,
        bins,
        activeBinId: activeTick,
        binStep: Number(tickSpacing),
        reservesKnown: bins.length > 0,
      };
    }

    /** v3 positions of an owner (NPM is an ERC721 enumerable). */
    async function v3PositionsOf(
      owner: Address,
      poolFilter?: string,
    ): Promise<ReadonlyArray<Position>> {
      const npm = v3Npm();
      const balance = Number(await npm.read.balanceOf([owner]));
      const positions: Position[] = [];
      for (let i = 0; i < balance; i++) {
        try {
          const tokenId = await npm.read.tokenOfOwnerByIndex([owner, BigInt(i)]);
          const p = await npm.read.positions([tokenId]);
          const token0 = p[2];
          const token1 = p[3];
          const pool = await v3PoolOf(token0, token1, p[4]);
          if (poolFilter && pool.toLowerCase() !== poolFilter.toLowerCase()) continue;
          positions.push({
            id: tokenId.toString(),
            poolAddress: pool.toLowerCase(),
            poolName: `${token0.slice(0, 6)}/${token1.slice(0, 6)}`,
            lowerBinId: Number(p[5]),
            upperBinId: Number(p[6]),
            liquidityShares: p[7],
            depositedUsd: 0,
            currentValueUsd: 0,
            unrealizedPnlUsd: 0,
            feesEarnedUsd: 0,
            openedAt: Date.now(),
          });
        } catch {
          continue;
        }
      }
      return positions;
    }

    async function v3PoolOf(token0: Address, token1: Address, fee: number): Promise<Address> {
      return v3Factory().read.getPool([token0, token1, fee]);
    }

    /** v4 positions of an owner via the PositionManager. */
    async function v4PositionsOf(
      owner: Address,
      poolFilter?: string,
    ): Promise<ReadonlyArray<Position>> {
      const pm = v4PositionManager();
      const balance = Number(await pm.read.balanceOf([owner]));
      const positions: Position[] = [];
      for (let i = 0; i < balance; i++) {
        try {
          const tokenId = await pm.read.tokenOfOwnerByIndex([owner, BigInt(i)]);
          const p = await pm.read.positions([tokenId]);
          const poolId = `0x${p[0].toString(16).padStart(64, "0")}`;
          if (poolFilter && poolId.toLowerCase() !== poolFilter.toLowerCase()) continue;
          positions.push({
            id: tokenId.toString(),
            poolAddress: poolId,
            poolName: `v4:${poolId.slice(0, 10)}`,
            lowerBinId: 0,
            upperBinId: 0,
            liquidityShares: p[1],
            depositedUsd: 0,
            currentValueUsd: 0,
            unrealizedPnlUsd: 0,
            feesEarnedUsd: 0,
            openedAt: Date.now(),
          });
        } catch {
          continue;
        }
      }
      return positions;
    }

    return {
      hasWallet: () => account !== null,
      getWalletAddress: () => walletAddress,
      getWalletBalanceUsd: () => Effect.gen(function* () {
        if (!walletAddress) return 0;
        const [nativeWei, stable] = yield* Effect.promise(async () => {
          const [n, s] = await Promise.all([
            getBalance(NATIVE_MINT, walletAddress),
            getBalance(STABLECOIN_MINT, walletAddress),
          ]);
          return [n, s] as const;
        });
        const ethPrice = yield* Effect.promise(() => priceUsd(NATIVE_MINT));
        return (Number(nativeWei) / 1e18) * ethPrice + Number(stable) / 1e6;
      }),
      getWalletHoldings: () => Effect.gen(function* () {
        const holdings = new Map<string, { amountAtomic: bigint; decimals: number }>();
        if (!walletAddress) return holdings;
        yield* Effect.promise(async () => {
          const [n, s] = await Promise.all([
            getBalance(NATIVE_MINT, walletAddress),
            getBalance(STABLECOIN_MINT, walletAddress),
          ]);
          holdings.set(NATIVE_MINT, { amountAtomic: n, decimals: 18 });
          holdings.set(STABLECOIN_MINT, { amountAtomic: s, decimals: 6 });
        });
        return holdings;
      }),
      getNativeBalance: () => Effect.promise(async () => {
        if (!walletAddress) return 0n;
        return publicClient.getBalance({ address: walletAddress });
      }),
      getPoolState: (poolAddress) =>
        Effect.tryPromise({
          try: async () => {
            // v4 poolIds are 66-char 0x-hex; v3 pools are 42-char addresses.
            if (poolAddress.length === 66) {
              const key = V4_POOL_REGISTRY[poolAddress.toLowerCase()];
              if (!key) {
                return {
                  address: poolAddress.toLowerCase(),
                  tokenX: "",
                  tokenY: "",
                  tokenXSymbol: "",
                  tokenYSymbol: "",
                  tvlUsd: 0,
                  volume24hUsd: 0,
                  fees24hUsd: 0,
                  apr: 0,
                  activeBinId: 0,
                  binStep: 0,
                  currentPrice: 0,
                  timestamp: Date.now(),
                  statsSource: "heuristic" as const,
                };
              }
              const pm = v4PoolManager();
              const [slot0, liquidity] = await Promise.all([
                pm.read.getSlot0([key]),
                pm.read.getLiquidity([key]),
              ]);
              const tick = Number(slot0[1]);
              return {
                address: poolAddress.toLowerCase(),
                tokenX: key.currency0.toLowerCase(),
                tokenY: key.currency1.toLowerCase(),
                tokenXSymbol: isNative(key.currency0) ? "ETH" : "TOKEN",
                tokenYSymbol: isNative(key.currency1) ? "ETH" : "TOKEN",
                tvlUsd: 0,
                volume24hUsd: 0,
                fees24hUsd: 0,
                apr: 0,
                activeBinId: tick,
                binStep: key.tickSpacing,
                currentPrice: tickToPrice(tick),
                timestamp: Date.now(),
                statsSource: "heuristic" as const,
              };
            }
            return v3PoolState(getAddress(poolAddress));
          },
          catch: (e) => new Error(`getPoolState(${poolAddress}): ${underlyingErrorMessage(e)}`),
        }),
      getBinArray: (poolAddress) =>
        Effect.tryPromise({
          try: async () => {
            if (poolAddress.length === 66) {
              const key = V4_POOL_REGISTRY[poolAddress.toLowerCase()];
              if (!key) {
                return {
                  lowerBinId: 0,
                  upperBinId: 0,
                  bins: [],
                  activeBinId: 0,
                  binStep: 0,
                  reservesKnown: false,
                };
              }
              const pm = v4PoolManager();
              const slot0 = await pm.read.getSlot0([key]);
              // v4 has no TickLens; per-tick reads are unbounded. Report the
              // active tick only and mark reserves unknown — the engine treats
              // bin signals as "unknown" rather than fabricating them.
              return {
                lowerBinId: Number(slot0[1]),
                upperBinId: Number(slot0[1]),
                bins: [],
                activeBinId: Number(slot0[1]),
                binStep: key.tickSpacing,
                reservesKnown: false,
              };
            }
            return v3BinArray(getAddress(poolAddress));
          },
          catch: (e) => new Error(`getBinArray(${poolAddress}): ${underlyingErrorMessage(e)}`),
        }),
      getPositions: (poolAddress, wallet) =>
        Effect.tryPromise({
          try: async () =>
            poolAddress.length === 66
              ? v4PositionsOf(getAddress(wallet), poolAddress)
              : v3PositionsOf(getAddress(wallet), poolAddress),
          catch: (e) => new Error(`getPositions: ${underlyingErrorMessage(e)}`),
        }),
      getAllWalletPositions: (wallet) =>
        Effect.tryPromise({
          try: async () => {
            const owner = getAddress(wallet);
            const [v3, v4] = await Promise.all([v3PositionsOf(owner), v4PositionsOf(owner)]);
            return v3.concat(v4).map((p) => ({
              poolAddress: p.poolAddress,
              positionPubKey: p.id,
              lowerBinId: p.lowerBinId,
              upperBinId: p.upperBinId,
            }));
          },
          catch: (e) => new Error(`getAllWalletPositions: ${underlyingErrorMessage(e)}`),
        }),
      getPositionValueUsd: (poolAddress, positionPubKey) =>
        Effect.tryPromise({
          try: async () => {
            // Position value = liquidity × current price × range factor.
            // Full amount math (sqrtPrice bounds) is the tx-layer milestone;
            // this heuristic mark is fail-open and only shapes decisions.
            if (!walletAddress) return null;
            const pos =
              poolAddress.length === 66
                ? (await v4PositionsOf(walletAddress)).find((p) => p.id === positionPubKey)
                : (await v3PositionsOf(walletAddress)).find((p) => p.id === positionPubKey);
            if (!pos) return null;
            const usd = await priceUsd(poolAddress).catch(() => 0);
            return (Number(pos.liquidityShares) / 1e18) * (usd || 0) * 2;
          },
          catch: () => null,
        }).pipe(Effect.catch(() => Effect.succeed(null))),
      simulateRebalance: (poolAddress, positionPubKey, newLowerBinId, newUpperBinId) =>
        Effect.succeed({
          estimatedFeesUsd: 0,
          estimatedCostUsd: 0,
          netBenefitUsd: 0,
          source: "pool-heuristic" as const,
        }),
      enterPosition: (poolAddress, lowerBinId, upperBinId, positionSizeUsd, options) =>
        NOT_IMPLEMENTED("enterPosition"),
      exitPosition: (poolAddress, positionPubKey) => NOT_IMPLEMENTED("exitPosition"),
      placeLimitOrder: (poolAddress, request) => NOT_IMPLEMENTED("placeLimitOrder"),
      cancelLimitOrder: (poolAddress, orderPubKey, binIds) => NOT_IMPLEMENTED("cancelLimitOrder"),
      rebalancePosition: (poolAddress, positionPubKey, newLowerBinId, newUpperBinId, topUp) =>
        NOT_IMPLEMENTED("rebalancePosition"),
      claimFees: (poolAddress, positionPubKey, ..._rest) => NOT_IMPLEMENTED("claimFees"),
      convertClaimedFees: (poolAddress, destination, feeX, feeY) =>
        NOT_IMPLEMENTED("convertClaimedFees"),
      claimRewards: (poolAddress, positionPubKey) => NOT_IMPLEMENTED("claimRewards"),
      discoverPools: (scanOrdinal) =>
        Effect.tryPromise({
          try: async () => {
            const factory = v3Factory();
            const total = Number(await factory.read.allPairsLength());
            // Cap discovery per scan; the engine rotates scanOrdinal pages.
            const start = (scanOrdinal ?? 0) * 50;
            const end = Math.min(total, start + 50);
            const pools: DiscoveredPool[] = [];
            for (let i = start; i < end; i++) {
              try {
                const pool = await factory.read.allPairs([BigInt(i)]);
                const pc = v3Pool(pool);
                const [token0, token1, tickSpacing] = await Promise.all([
                  pc.read.token0(),
                  pc.read.token1(),
                  pc.read.tickSpacing(),
                ]);
                pools.push({
                  address: pool.toLowerCase(),
                  tvlUsd: 0,
                  volume24hUsd: 0,
                  fees24hUsd: 0,
                  apr: 0,
                  binStep: Number(tickSpacing),
                  tokenX: token0.toLowerCase(),
                  tokenY: token1.toLowerCase(),
                });
              } catch {
                continue;
              }
            }
            return pools;
          },
          catch: (e) =>
            new DiscoverPoolsError({
              message: `discoverPools: ${underlyingErrorMessage(e)}`,
              url: rpcUrl,
            }),
        }),
      reportFeeCollection: () => Effect.void,
      // Original semantics: fail-open (never errors) — logs and continues.
      swapUSDCForNative: (minNativeThreshold, swapAmountStable) =>
        Effect.sync(() =>
          logger.warn("swapUSDCForNative skipped: live EVM execution not implemented in scaffold", {
            minNativeThreshold,
            swapAmountStable,
          }),
        ),
      getTokenBalance: (mint) =>
        Effect.tryPromise({
          try: async () => (walletAddress ? getBalance(mint, walletAddress) : 0n),
          catch: (e) => new Error(`getTokenBalance: ${underlyingErrorMessage(e)}`),
        }),
      getTokenPrices: (mints, opts) =>
        Effect.tryPromise({
          try: async () => {
            const out: Record<string, number> = {};
            for (const mint of mints) out[mint] = await priceUsd(mint);
            return out;
          },
          catch: (e) => new Error(`getTokenPrices: ${underlyingErrorMessage(e)}`),
        }),
      getTokenDecimals: (mint) =>
        Effect.tryPromise({
          try: () => getDecimals(mint),
          catch: (e) => new Error(`getTokenDecimals: ${underlyingErrorMessage(e)}`),
        }),
      // EVM ERC-20 has no on-chain mint/freeze authority registry; nulls are
      // the fail-open contract (callers treat absent authorities as unknown).
      getMintAuthorities: (mintAddress) =>
        Effect.succeed({ mintAuthority: null, freezeAuthority: null }),
      quoteSwapUSDCForToken: (outputMint, amountAtomic) => NOT_IMPLEMENTED("quoteSwapUSDCForToken"),
      swapUSDCForToken: (outputMint, amountAtomic, quoteData) =>
        NOT_IMPLEMENTED("swapUSDCForToken"),
      swapToken: (inputMint, outputMint, amountAtomic, quoteData) => NOT_IMPLEMENTED("swapToken"),
      quoteSwap: (request) => NOT_IMPLEMENTED("quoteSwap"),
      prepareSwap: (quote) => NOT_IMPLEMENTED("prepareSwap"),
      simulateSwap: (prepared) => NOT_IMPLEMENTED("simulateSwap"),
      submitSwap: (prepared, onBroadcast) => NOT_IMPLEMENTED("submitSwap"),
      getSwapStatus: (signature) => NOT_IMPLEMENTED("getSwapStatus"),
      getConfirmedSwapOutput: (signature) => NOT_IMPLEMENTED("getConfirmedSwapOutput"),
    } satisfies AdapterApi;
  }),
);
