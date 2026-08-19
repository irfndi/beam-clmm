// ─── Chain registry: multi-chain support ─────────────────────────────────────
// ROBINHOOD was the only supported chain, hardwired through adapter-service.ts
// (CHAIN_ID/DEFAULT_RPC/addresses) and run-engine.ts (chain-verify). This
// registry makes a chain a RUNTIME selection driven by BEAM_CHAIN (env), so
// the same engine can scan/manage Base, Robinhood, or any registered EVM chain
// with its own verified Uniswap v3/v4 deployment addresses. Paper trading is
// chain-agnostic (no wallet); live trading needs a wallet funded on the
// selected chain.
//
// Address sources are the official Uniswap deployments (developers.uniswap.org
// /deployments.json) — verified by chain and recorded here. Do NOT assume an
// address transfers between chains: per Uniswap's warning, deployments differ
// per network. WETH (wrapped native) is chain-specific (Base: 0x4200…0006).

import type { Address } from "viem";
import { getAddress } from "viem";

export interface ChainDeployment {
  /** Machine key used by BEAM_CHAIN (e.g. "base", "robinhood"). Lowercase. */
  readonly key: string;
  /** EVM chain id, used for the viem chain object and Token ids. */
  readonly chainId: number;
  /** Public display name, e.g. "Base" / "Robinhood Chain". */
  readonly name: string;
  /** Default/public RPC. Users override via RPC_URL / BEAM_<CHAIN>_RPC_URL. */
  readonly defaultRpc: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  /** Uniswap v3 factory. */
  readonly v3Factory: Address;
  /** Uniswap v3 NonfungiblePositionManager. */
  readonly v3Npm: Address;
  readonly v3TickLens: Address;
  /** Multicall3 deployment used to batch read-only pool state. */
  readonly multicall3: Address;
  /** Uniswap v4 PositionManager + StateView (v4 pools). Required: every
   *  registered chain has an official v4 deployment. */
  readonly v4PositionManager: Address;
  readonly v4StateView: Address;
  /** Universal Router (swaps) + SwapRouter02 (v3 pure-swap encoding). */
  readonly universalRouter: Address;
  readonly v3SwapRouter02: Address;
  /** SwapRouter02 exactInputSingle encoding. Canonical deployments (Base, all
   *  official chains) use the 8-field struct WITH deadline (selector
   *  0x414bf389). Robinhood's custom fork carries the 7-field struct WITHOUT
   *  deadline (selector 0x04e45aaf, probe-verified 2026-08-10). The live swap
   *  path must use the chain's encoding or every v3 swap reverts. */
  readonly v3SwapRouterEncoding: "canonical-8f" | "fork-7f";
  /** Wrapped native gas token (WETH). Base: 0x4200…0006. */
  readonly weth9: Address;
  /** Canonical stablecoin mint (used as the STABLECOIN_MINTS default). */
  readonly defaultStablecoinMint: Address;
  /** GeckoTerminal network slug (stats source). */
  readonly geckoNetworkSlug: string;
  /** Enable live v4 ENTER on this chain. Default false (v4 mint verification
   *  is chain-specific; Base's official v4 deploy is proven, Robinhood's
   *  custom PM rejects mints — see LIVE_ENTRY_V4_ENABLED config). */
  readonly liveEntryV4Enabled: boolean;
}

/** Official Uniswap v3/v4 deployment for Base (chain 8453), 2026-07-15.
 *  Verified live on mainnet.base.org (WETH/USDC 0.05% pool is deep and
 *  mintable — unlike Robinhood's dead meme shells). */
const BASE: ChainDeployment = {
  key: "base",
  chainId: 8453,
  name: "Base",
  defaultRpc: "https://mainnet.base.org",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  // v3 (developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments)
  v3Factory: getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD"),
  v3Npm: getAddress("0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1"),
  v3TickLens: getAddress("0x0CdeE061c75D43c82520eD998C23ac2991c9ac6d"),
  multicall3: getAddress("0xcA11bde05977b3631167028862bE2a173976CA11"),
  v3SwapRouter02: getAddress("0x2626664c2603336E57B271c5C0b26F421741e481"),
  v3SwapRouterEncoding: "canonical-8f",
  // v4 (developers.uniswap.org/docs/protocols/v4/deployments — Base: 8453)
  v4PositionManager: getAddress("0x7c5f5a4bbd8fd63184577525326123b519429bdc"),
  v4StateView: getAddress("0xa3c0c9b65bad0b08107aa264b0f3db444b867a71"),
  universalRouter: getAddress("0x6ff5693b99212da76ad316178a184ab56d299b43"),
  // Wrapped native gas token (Base): WETH 0x4200…0006.
  weth9: getAddress("0x4200000000000000000000000000000000000006"),
  // Base bridged USDC (Circle).
  defaultStablecoinMint: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  geckoNetworkSlug: "base",
  liveEntryV4Enabled: true,
};

/** Official Uniswap v3/v4 deployment for Robinhood Chain (4663). Retained as a
 *  registered chain, but no longer the default. */
const ROBINHOOD: ChainDeployment = {
  key: "robinhood",
  chainId: 4663,
  name: "Robinhood Chain",
  defaultRpc: "https://rpc.mainnet.chain.robinhood.com",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  v3Factory: getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa"),
  v3Npm: getAddress("0x73991a25c818bf1f1128deaab1492d45638de0d3"),
  v3TickLens: getAddress("0x7dfd4f31be6814d2906bde155c3e1b146eac1468"),
  multicall3: getAddress("0xcA11bde05977b3631167028862bE2a173976CA11"),
  v4PositionManager: getAddress("0x58daec3116aae6d93017baaea7749052e8a04fa7"),
  v4StateView: getAddress("0xF3334192D15450CdD385c8B70e03f9A6bD9E673b"),
  universalRouter: getAddress("0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99"),
  v3SwapRouter02: getAddress("0xCaf681a66D020601342297493863E78C959E5cb2"),
  v3SwapRouterEncoding: "fork-7f",
  weth9: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  defaultStablecoinMint: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  geckoNetworkSlug: "robinhood",
  liveEntryV4Enabled: false,
};

/** ALL chains this engine can scan/manage. A chain here is "capable": paper
 *  trading can backtest any of them with no wallet; live trading needs a
 *  funded key on the selected chain. Add a new chain by appending its verified
 *  Uniswap deployment here. */
const CHAIN_DEPLOYMENTS: ReadonlyArray<ChainDeployment> = [BASE, ROBINHOOD];

/** The active chain, selected at process start by BEAM_CHAIN (default "base").
 *  Unknown/missing selects base. Add BEAM_CHAIN below to force a specific one. */
export const ACTIVE_CHAIN_KEY = (process.env.BEAM_CHAIN ?? "base").toLowerCase();

function requireChain(key: string): ChainDeployment {
  const found = CHAIN_DEPLOYMENTS.find((c) => c.key === key.toLowerCase());
  if (found) return found;
  // Unknown BEAM_CHAIN falls back to Base and warns loudly rather than silently
  // picking Robinhood (the previous hardcoded default).
  if (key !== "base") {
    // eslint-disable-next-line no-console
    console.warn(`BEAM_CHAIN="${key}" unknown — falling back to "base"`);
  }
  return BASE;
}

const DEPLOYMENT: ChainDeployment = requireChain(ACTIVE_CHAIN_KEY);

/** Chain-agnostic exports that the engine consumed as hardwired constants. */
export const CHAIN_ID = DEPLOYMENT.chainId;
/** Alias for Krystal/API consumers that key by chain id. */
export const ACTIVE_CHAIN_ID = DEPLOYMENT.chainId;
export const DEFAULT_RPC = DEPLOYMENT.defaultRpc;
export const BEAM_CHAIN_NAME = DEPLOYMENT.name;
export const V3_FACTORY = DEPLOYMENT.v3Factory;
export const V3_NPM = DEPLOYMENT.v3Npm;
export const V3_TICK_LENS = DEPLOYMENT.v3TickLens;
export const MULTICALL3 = DEPLOYMENT.multicall3;
export const V4_POSITION_MANAGER = DEPLOYMENT.v4PositionManager;
export const V4_STATE_VIEW = DEPLOYMENT.v4StateView;
export const UNIVERSAL_ROUTER = DEPLOYMENT.universalRouter;
export const V3_SWAP_ROUTER_02 = DEPLOYMENT.v3SwapRouter02;
export const V3_SWAP_ROUTER_ENCODING = DEPLOYMENT.v3SwapRouterEncoding;
export const WETH9 = DEPLOYMENT.weth9;
export const DEFAULT_STABLECOIN_MINT = DEPLOYMENT.defaultStablecoinMint;
export const GECKO_NETWORK_SLUG = DEPLOYMENT.geckoNetworkSlug;
/** GeckoTerminal network slug for the active chain (env-overridable at call sites). */
export const DEFAULT_GECKO_SLUG = DEPLOYMENT.geckoNetworkSlug;
export const LIVE_ENTRY_V4_ENABLED_CHAIN = DEPLOYMENT.liveEntryV4Enabled;

export const ROBINHOOD_CHAIN = {
  id: DEPLOYMENT.chainId,
  name: DEPLOYMENT.name,
  nativeCurrency: DEPLOYMENT.nativeCurrency,
  rpcUrls: { default: { http: [DEFAULT_RPC] } },
} as const;

/** List every registered chain (for setup/CLI surfaces). */
export function listChains(): ReadonlyArray<{
  readonly key: string;
  readonly chainId: number;
  readonly name: string;
}> {
  return CHAIN_DEPLOYMENTS.map((c) => ({
    key: c.key,
    chainId: c.chainId,
    name: c.name,
  }));
}

/** Convenience: get a deployment by key (used by setup/validation). */
export function getChainDeployment(key: string): ChainDeployment | null {
  return CHAIN_DEPLOYMENTS.find((c) => c.key === key.toLowerCase()) ?? null;
}
