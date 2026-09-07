const path = require("path");
const root = path.resolve(__dirname);
const data = `${root}/.data/multichain`;
// Ops: launch from a clean env and never use `pm2 restart --update-env` for
// live — operator shell exports + project .env merge into children (seen in
// `pm2 jlist`). Preferred: `pm2 delete --all; env -i PATH=$PATH HOME=$HOME pm2 start pm2.ecosystem.config.cjs`.
// The BEAM_PM2_* shadows + scripts/beam-pm2.sh generic re-pin guard the
// pinned keys when --update-env is accidentally used.
// Verified on-chain Uniswap v3 Base WETH/USDC pools (factory getPool 2026-09-06).
const LIVE_WATCHLIST = [
  "0xd0b53D9277642d899DF5C87A3966A349A798F224", // 0.05%
  "0xb4CB800910B228ED3d0834cF79D697127BBB00e5", // 0.01%
  "0x6c561B446416E1A00E8E93E221854d6eA4171372", // 0.30%
].join(",");

// Paper keeps restored v4 book ids + live v3 set.
const PAPER_WATCHLIST = [
  "0x0590e03f159b40055b4f9423f23bdd814edac2f340d6afed1280dee36c30effe",
  "0x4bd3a3f164decfcbe92e15afe8af000c457addd2592db07efc7f5f41776b4cfc",
  "0xe82fa069a5e01a6dc36c6736b5de4f721d726291b080c69b48e21b9c5a11a2ad",
  "0xf2e0472bd19f262411d8be221676371ec37822578a0a4c4b6464489b42c858eb",
  ...LIVE_WATCHLIST.split(","),
].join(",");

const FREE_BASE_RPCS = [
  // Prefer endpoints that accept eth_call stateOverride (mint pre-sim).
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.gateway.tenderly.co",
].join(",");
const common = {
  script: `${root}/scripts/beam-pm2.sh`,
  interpreter: "/bin/bash",
  cwd: root,
  autorestart: true,
  restart_delay: 5000,
  max_restarts: 20,
  exp_backoff_restart_delay: 100,
  merge_logs: true,
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: "beam-base",
      env: {
        BEAM_CHAIN: "base",
        BEAM_PM2_CHAIN: "base",
        AGENT_INSTANCE_ID: "beam-base",
        BEAM_PM2_AGENT_INSTANCE_ID: "beam-base",
        SQLITE_DB_PATH: `${data}/base.db`,
        BEAM_PM2_SQLITE_DB_PATH: `${data}/base.db`,
        BEAM_INSTALL_DIR: root,
        BEAM_BASE_RPC_URL: "https://mainnet.base.org",
        BEAM_PM2_BEAM_BASE_RPC_URL: "https://mainnet.base.org",
        RPC_FALLBACK_URLS: FREE_BASE_RPCS,
        BEAM_PM2_RPC_FALLBACK_URLS: FREE_BASE_RPCS,
        RPC_RETRY_COUNT: "6",
        BEAM_PM2_RPC_RETRY_COUNT: "6",
        PAPER_TRADING: "true",
        BEAM_PM2_PAPER_TRADING: "true",
        AUTONOMOUS_TOKEN_MODE: "off",
        BEAM_PM2_AUTONOMOUS_TOKEN_MODE: "off",
        ENABLE_POOL_DISCOVERY: "false",
        MARKET_SCAN_ENABLED: "false",
        CHALLENGE_MODE: "false",
        BEAM_PM2_CHALLENGE_MODE: "false",
        WATCHLIST_POOLS: PAPER_WATCHLIST,
        BEAM_PM2_WATCHLIST_POOLS: PAPER_WATCHLIST,
        CONFIDENCE_THRESHOLD: "0.55",
        MAX_OPEN_POSITIONS: "4",
        // Slow paper so free public RPCs have headroom for live mint sims.
        SCAN_INTERVAL_MS: "120000",
        BEAM_PM2_SCAN_INTERVAL_MS: "120000",
        ENABLE_SNAPSHOT_CAPTURE: "true",
        // Paper-validation relaxations (explicit — was implicitly inherited
        // from project .env; cleaning .env must not silently stop ENTERs).
        MIN_FEE_IL_RATIO: "0.5",
        BEAM_PM2_MIN_FEE_IL_RATIO: "0.5",
        ENTRY_SIZE_FLOOR_USD: "6",
        BEAM_PM2_ENTRY_SIZE_FLOOR_USD: "6",
        FEE_PERSISTENCE_MIN_POSITIVE_DAYS: "1",
        BEAM_PM2_FEE_PERSISTENCE_MIN_POSITIVE_DAYS: "1",
        EXIT_ROUTE_PROOF_REQUIRED: "false",
        BEAM_PM2_EXIT_ROUTE_PROOF_REQUIRED: "false",
        PAPER_VALIDATION_ENFORCE: "false",
        BEAM_PM2_PAPER_VALIDATION_ENFORCE: "false",
        CHALLENGE_MIN_SCORE: "1",
        BEAM_PM2_CHALLENGE_MIN_SCORE: "1",
      },
      out_file: `${data}/base.out.log`,
      error_file: `${data}/base.err.log`,
    },
    {
      ...common,
      name: "beam-base-live",
      env: {
        BEAM_CHAIN: "base",
        BEAM_PM2_CHAIN: "base",
        AGENT_INSTANCE_ID: "beam-base-live",
        BEAM_PM2_AGENT_INSTANCE_ID: "beam-base-live",
        SQLITE_DB_PATH: `${data}/base-live.db`,
        BEAM_PM2_SQLITE_DB_PATH: `${data}/base-live.db`,
        BEAM_INSTALL_DIR: root,
        BEAM_BASE_RPC_URL: "https://mainnet.base.org",
        BEAM_PM2_BEAM_BASE_RPC_URL: "https://mainnet.base.org",
        RPC_FALLBACK_URLS: FREE_BASE_RPCS,
        BEAM_PM2_RPC_FALLBACK_URLS: FREE_BASE_RPCS,
        RPC_RETRY_COUNT: "8",
        BEAM_PM2_RPC_RETRY_COUNT: "8",
        PAPER_TRADING: "false",
        BEAM_PM2_PAPER_TRADING: "false",
        // Pin off: project .env has CHALLENGE_MODE=true (paper harvest book).
        CHALLENGE_MODE: "false",
        BEAM_PM2_CHALLENGE_MODE: "false",
        AUTONOMOUS_TOKEN_MODE: "off",
        BEAM_PM2_AUTONOMOUS_TOKEN_MODE: "off",
        ENABLE_POOL_DISCOVERY: "false",
        BEAM_PM2_ENABLE_POOL_DISCOVERY: "false",
        // Ranking code is live; for fee canary prefer one mid-TVL swappable book
        // (meme top-K mostly fails token-risk / swap). Re-enable scan once fills stick.
        MARKET_SCAN_ENABLED: "false",
        MARKET_SCAN_RANK_MODE: "capitalFit",
        MARKET_SCAN_MIN_TVL_USD: "15000",
        MARKET_SCAN_MAX_TVL_USD: "800000",
        MARKET_SCAN_TARGET_TVL_USD: "100000",
        MARKET_SCAN_MIN_FEE_APR: "25",
        MARKET_SCAN_TOP_K: "15",
        MARKET_SCAN_MAX_POOLS: "25",
        MARKET_SCAN_REFRESH_INTERVAL_MS: "300000",
        MARKET_SCAN_MIN_BIN_STEP: "1",
        MARKET_SCAN_MAX_BIN_STEP: "200",
        MARKET_SCAN_MIN_HOLDERS: "0",
        // Mid-TVL WETH/USDC 0.01% (~$360k) — capital-fit vs $8M mega 0.05%.
        WATCHLIST_POOLS: "0xb4CB800910B228ED3d0834cF79D697127BBB00e5",
        BEAM_PM2_WATCHLIST_POOLS: "0xb4CB800910B228ED3d0834cF79D697127BBB00e5",
        CONFIDENCE_THRESHOLD: "0.55",
        MAX_OPEN_POSITIONS: "1",
        MAX_POSITIONS_PER_POOL: "1",
        MAX_ENTRY_SIZE_USD: "20",
        MAX_PER_POOL_ALLOCATION_PCT: "0.5",
        // After gas + leftover WETH, sized entries sit ~$14 — floor must allow that.
        ENTRY_SIZE_FLOOR_USD: "10",
        ENTRY_SIZE_EQUITY_FRACTION: "0.55",
        // Canary wallet ~0.003 ETH: fit ENTER inside balance−gas-reserve.
        MIN_NATIVE_FOR_ENTRY_WEI: "1500000000000000",
        MIN_NATIVE_FOR_GAS_WEI: "800000000000000",
        // Free RPCs: fewer cycles/min beats paid throughput for canary fills.
        SCAN_INTERVAL_MS: "90000",
        BEAM_PM2_SCAN_INTERVAL_MS: "90000",
        LIVE_ENTRY_V4_ENABLED: "true",
        LIVE_ENTRY_NATIVE_LEG_ONLY: "true",
        EXIT_ROUTE_PROOF_REQUIRED: "true",
        PAPER_VALIDATION_ENFORCE: "true",
        PAPER_VALIDATION_MIN_DAYS: "0",
        IL_PROTECTION_ENABLED: "false",
        ENTER_ROUND_TRIP_GAS_USD: "0",
        // Tight fee canary: don't let ENTRY_MIN_RANGE_PCT=20% blow halfWidth to ~950 ticks.
        ENTRY_RANGE_HALF_WIDTH_BINS: "50",
        ENTRY_MIN_RANGE_PCT: "0.02",
        VOLATILITY_ADAPTIVE_RANGES: "false",
        ENTER_MIN_7D_FEE_OVER_GAS: "0",
        // Canary: don't sit idle 4h after an OOR/vol exit; re-enter in-range.
        // OOR=1 (not 0): fee-density floor must sit strictly below OOR or
        // ConfigService warns every cycle; 1ms behaves like 0.
        OOR_COOLDOWN_MS: "1",
        REPEAT_OOR_COOLDOWN_MS: "0",
        FEE_DENSITY_COOLDOWN_MIN_MS: "0",
        // Wider vol gate — tickSpacing=1 noise + lastRebalanceAt=0 was churning
        // overnight (σ≈15–22 vs 12). Hold through normal WETH tick chatter.
        VOLATILITY_EXIT_STDDEV: "40",
        // Fee canary: USDC→WETH swap then in-range two-sided; never park OOR.
        ENTRY_REQUIRE_TWO_SIDED: "true",
        // One-shot flush done — keep age-stop off for fee canary holds.
        MAX_POSITION_AGE_MS: "0",
        // Krystal top-500 dropped 0xb4CB (feed-dead baseline guard holds); gecko
        // is the fallback stats source. Modeled-fee pools now face the env
        // volume bar (0.5), not the measured 0.8 — see candidate-gate fix.
        GECKO_TERMINAL_ENABLED: "true",

        MIN_FEE_IL_RATIO: "0.1",
        VOLUME_AUTH_THRESHOLD: "0.5",
        WEIGHTED_ENTRY_SCORE_THRESHOLD: "0.3",
        KRYSTAL_ENABLED: "true",
      },
      out_file: `${data}/base-live.out.log`,
      error_file: `${data}/base-live.err.log`,
    },
  ],
};
