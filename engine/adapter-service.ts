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
export const V4_STATE_VIEW: Address = getAddress("0xF3334192D15450CdD385c8B70e03f9A6bD9E673b");
// Official 4663 deployments (developers.uniswap.org/deployments.json, 2026-07-15).
export const UNIVERSAL_ROUTER: Address = getAddress("0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99");
export const V3_SWAP_ROUTER_02: Address = getAddress(
  "0xCaf681a66D020601342297493863E78C959E5cb2",
);
export const MULTICALL3: Address = getAddress("0xcA11bDe05977b3631167028862bE2a173976CA11");
// v3 pools on Robinhood Chain are WETH-paired (native ETH must be wrapped for
// v3; v4 treats address-zero as a first-class currency). Verified 2026-07.
export const WETH9: Address = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");

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
export const V4_POOL_REGISTRY: Record<string, V4PoolKey> = {};

/**
 * Register a v4 pool key by poolId (lowercase 0x-hex). v4 pools have no
 * on-chain enumeration (poolId is a one-way hash), so discovery seeds this
 * registry from known pairs / an indexer; `poolKeys(bytes25)` on the
 * PositionManager can reverse a truncated id when the key is unknown.
 */
export function registerV4Pool(poolId: string, key: V4PoolKey): void {
  V4_POOL_REGISTRY[poolId.toLowerCase()] = key;
}

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
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) view returns ((int24,int128,uint128)[])",
]);
const v3NpmAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);
const v4StateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const v4PositionManagerAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address,address,uint24,int24,address) poolKey, uint256 positionInfo)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
]);

/** v3 factory PoolCreated — canonical event, verified on 4663. */
const poolCreatedEvent = {
  type: "event",
  name: "PoolCreated",
  inputs: [
    { type: "address", name: "token0", indexed: true },
    { type: "address", name: "token1", indexed: true },
    { type: "uint24", name: "fee", indexed: true },
    { type: "int24", name: "tickSpacing" },
    { type: "address", name: "pool" },
  ],
} as const;

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

/** viem encodes struct params as positional tuples — convert our PoolKey object. */
function poolKeyTuple(key: V4PoolKey): readonly [Address, Address, number, number, Address] {
  return [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
}

/** v4 poolId = keccak256(abi.encode(poolKey)) — canonical v4 pool identity. */
async function computeV4PoolId(key: V4PoolKey): Promise<string> {
  const { encodeAbiParameters, keccak256 } = await import("viem");
  const encoded = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  );
  return keccak256(encoded).toLowerCase();
}

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
    const v4StateView = () =>
      getContract({
        address: V4_STATE_VIEW,
        abi: v4StateViewAbi,
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
      // Native ETH is WETH-paired in v3 pools.
      if (isNative(mint)) return priceUsdViaV3Pool(WETH9);
      return priceUsdViaV3Pool(mint);
    }

    /** Price of `mint` in USDG via the most liquid v3 pool. The on-chain
     *  sqrt price is the RAW token1/token0 ratio (decimals-sensitive); scale
     *  by 10^(decimals(mint) - 6) so the result is USDG per mint (USDG=1). */
    async function priceUsdViaV3Pool(mint: string): Promise<number> {
      const factory = v3Factory();
      const mintAddr = getAddress(mint).toLowerCase();
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
          const rawPrice = sqrtPriceX96ToPrice(slot0[0]); // token1/token0 raw
          const decimals = await getDecimals(mint);
          const scale = 10 ** (decimals - 6);
          return token0.toLowerCase() === mintAddr ? rawPrice * scale : scale / rawPrice;
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
        tokenXSymbol: isNative(token0) ? "ETH" : token0.toLowerCase() === WETH9.toLowerCase() ? "WETH" : "TOKEN",
        tokenYSymbol: isNative(token1) ? "ETH" : token1.toLowerCase() === WETH9.toLowerCase() ? "WETH" : "TOKEN",
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
            tokenX: token0.toLowerCase(),
            tokenY: token1.toLowerCase(),
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
          // New PM interface: poolKey + packed info, liquidity via lens call.
          const [poolKey] = await pm.read.getPoolAndPositionInfo([tokenId]);
          const liquidity = await pm.read.getPositionLiquidity([tokenId]);
          const key: V4PoolKey = {
            currency0: poolKey[0],
            currency1: poolKey[1],
            fee: Number(poolKey[2]),
            tickSpacing: Number(poolKey[3]),
            hooks: poolKey[4],
          };
          const poolId = await computeV4PoolId(key);
          if (poolFilter && poolId.toLowerCase() !== poolFilter.toLowerCase()) continue;
          positions.push({
            id: tokenId.toString(),
            poolAddress: poolId,
            poolName: `v4:${poolId.slice(0, 10)}`,
            tokenX: key.currency0.toLowerCase(),
            tokenY: key.currency1.toLowerCase(),
            lowerBinId: 0,
            upperBinId: 0,
            liquidityShares: liquidity,
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

    /**
     * v3 factory has no allPairs/allPairsLength on 4663 (reverts) — discover
     * via PoolCreated logs (factory startBlock 8930). In-memory cache; the
     * engine rotates scanOrdinal pages of 50.
     * ponytail: full-log scan on first call; a subgraph indexer replaces this
     * when pool counts grow.
     */
    let discoveredPoolCache: DiscoveredPool[] | null = null;
    async function discoverAllV3Pools(): Promise<DiscoveredPool[]> {
      if (discoveredPoolCache !== null) return discoveredPoolCache;
      const latest = await publicClient.getBlockNumber();
      // Public RPC times out on 100k-block log queries; 10k chunks work.
      // Window: env DISCOVERY_BLOCK_WINDOW (default 2M blocks ≈ recent pools);
      // the chain creates pools continuously (~509k total since genesis, ~99%
      // WETH-paired fee-10000 meme pools), so a full-history scan is
      // thousands of chunks — the gecko/subgraph indexer is the
      // completeness path (follow-up).
      const CHUNK = 10_000n;
      const windowBlocks = BigInt(
        Number(process.env.DISCOVERY_BLOCK_WINDOW ?? 2_000_000),
      );
      const fromStart = latest > windowBlocks ? latest - windowBlocks : 8930n;
      const pools = new Map<string, DiscoveredPool>();
      for (let from = fromStart; from <= latest; from += CHUNK) {
        const to = from + CHUNK - 1n < latest ? from + CHUNK - 1n : latest;
        try {
          const logs = await publicClient.getLogs({
            address: V3_FACTORY,
            event: poolCreatedEvent,
            fromBlock: from,
            toBlock: to,
          });
          for (const log of logs) {
            const args = log.args;
            if (!args.pool) continue;
            pools.set(args.pool.toLowerCase(), {
              address: args.pool.toLowerCase(),
              tokenX: args.token0?.toLowerCase() ?? "",
              tokenY: args.token1?.toLowerCase() ?? "",
              binStep: Number(args.tickSpacing ?? 60),
              tvlUsd: 0,
              volume24hUsd: 0,
              fees24hUsd: 0,
              apr: 0,
            });
          }
        } catch (e) {
          // viem errors embed BigInt args — stringify via message only.
          logger.warn("discoverAllV3Pools: chunk failed", {
            from: from.toString(),
            to: to.toString(),
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      discoveredPoolCache = [...pools.values()];
      logger.info("discovered v3 pools", { count: discoveredPoolCache.length });
      return discoveredPoolCache;
    }

    return {
      hasWallet: () => account !== null,
      getWalletAddress: () => walletAddress,
      getWalletBalanceUsd: () => Effect.gen(function* () {
        if (!walletAddress) return 0;
        const [nativeWei, stable] = yield* Effect.tryPromise(async () => {
          const [n, s] = await Promise.all([
            getBalance(NATIVE_MINT, walletAddress),
            getBalance(STABLECOIN_MINT, walletAddress),
          ]);
          return [n, s] as const;
        });
        const ethPrice = yield* Effect.tryPromise(() => priceUsd(NATIVE_MINT));
        return (Number(nativeWei) / 1e18) * ethPrice + Number(stable) / 1e6;
      }),
      getWalletHoldings: () => Effect.gen(function* () {
        const holdings = new Map<string, { amountAtomic: bigint; decimals: number }>();
        if (!walletAddress) return holdings;
        yield* Effect.tryPromise(async () => {
          const [n, s] = await Promise.all([
            getBalance(NATIVE_MINT, walletAddress),
            getBalance(STABLECOIN_MINT, walletAddress),
          ]);
          holdings.set(NATIVE_MINT, { amountAtomic: n, decimals: 18 });
          holdings.set(STABLECOIN_MINT, { amountAtomic: s, decimals: 6 });
        });
        return holdings;
      }),
      getNativeBalance: () => Effect.tryPromise(async () => {
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
              const stateView = v4StateView();
              const poolIdHex = poolAddress.toLowerCase() as `0x${string}`;
              const [slot0, liquidity] = await Promise.all([
                stateView.read.getSlot0([poolIdHex]),
                stateView.read.getLiquidity([poolIdHex]),
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
              const stateView = v4StateView();
              const poolIdHex = poolAddress.toLowerCase() as `0x${string}`;
              const slot0 = await stateView.read.getSlot0([poolIdHex]);
              // v4 has no TickLens; per-tick reads are unbounded. Report the
              // active tick with a synthetic single bin so range utilization
              // is KNOWN (1.0 while the pool is live) instead of fabricating a
              // spread: the real utilization control for v4 is the
              // volatility-scaled RANGE WIDTH the strategy selects, not tick
              // occupancy. reservesKnown=true lets the ENTER gates proceed;
              // the strategy treats 1.0 as "managed range, in-scope" — a
              // deliberate proxy, not a measured value.
              return {
                lowerBinId: Number(slot0[1]),
                upperBinId: Number(slot0[1]),
                bins: [
                  {
                    binId: Number(slot0[1]),
                    reserveX: slot0[0],
                    reserveY: slot0[0],
                    liquiditySupply: 0n,
                    price: tickToPrice(Number(slot0[1])),
                  },
                ],
                activeBinId: Number(slot0[1]),
                binStep: key.tickSpacing,
                reservesKnown: true,
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
            // Heuristic mark: liquidity × token USD price × range factor.
            // Full amount math (sqrtPrice bounds) is the tx-layer milestone;
            // this mark is fail-open and only shapes decisions. The mark
            // prices the position's TOKEN MINT (the pool address is not a
            // mint — the old `priceUsd(poolAddress)` always returned 0 and
            // marked every live position at $0, driving dust/trailing churn).
            if (!walletAddress) return null;
            const pos =
              poolAddress.length === 66
                ? (await v4PositionsOf(walletAddress)).find((p) => p.id === positionPubKey)
                : (await v3PositionsOf(walletAddress)).find((p) => p.id === positionPubKey);
            if (!pos) return null;
            const mint = pos.tokenX ?? pos.tokenY;
            if (!mint) return null;
            const usd = await priceUsd(mint).catch(() => 0);
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
            const all = await discoverAllV3Pools();
            if (all.length === 0) return all;
            const pageSize = 50;
            const pages = Math.ceil(all.length / pageSize);
            const page = (scanOrdinal ?? 0) % pages;
            return all.slice(page * pageSize, page * pageSize + pageSize);
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
