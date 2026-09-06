const root = "/Users/irfandi/Coding/2026/beam-clmm";
const data = `${root}/.data/multichain`;

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

const common = {
  script: `${root}/logs/beam-pm2.sh`,
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
        BEAM_BASE_RPC_URL: "https://base-rpc.publicnode.com",
        RPC_FALLBACK_URLS: "https://mainnet.base.org,https://base-rpc.publicnode.com",
        RPC_RETRY_COUNT: "6",
        PAPER_TRADING: "true",
        BEAM_PM2_PAPER_TRADING: "true",
        AUTONOMOUS_TOKEN_MODE: "off",
        ENABLE_POOL_DISCOVERY: "false",
        MARKET_SCAN_ENABLED: "false",
        CHALLENGE_MODE: "false",
        WATCHLIST_POOLS: PAPER_WATCHLIST,
        CONFIDENCE_THRESHOLD: "0.55",
        MAX_OPEN_POSITIONS: "4",
        SCAN_INTERVAL_MS: "15000",
        ENABLE_SNAPSHOT_CAPTURE: "true",
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
        BEAM_BASE_RPC_URL: "https://base-rpc.publicnode.com",
        RPC_FALLBACK_URLS: "https://mainnet.base.org,https://base-rpc.publicnode.com",
        RPC_RETRY_COUNT: "6",
        PAPER_TRADING: "false",
        BEAM_PM2_PAPER_TRADING: "false",
        AUTONOMOUS_TOKEN_MODE: "off",
        ENABLE_POOL_DISCOVERY: "false",
        MARKET_SCAN_ENABLED: "false",
        CHALLENGE_MODE: "false",
        WATCHLIST_POOLS: LIVE_WATCHLIST,
        CONFIDENCE_THRESHOLD: "0.55",
        MAX_OPEN_POSITIONS: "1",
        MAX_POSITIONS_PER_POOL: "1",
        MAX_ENTRY_SIZE_USD: "25",
        MAX_PER_POOL_ALLOCATION_PCT: "0.5",
        ENTRY_SIZE_FLOOR_USD: "20",
        SCAN_INTERVAL_MS: "20000",
        LIVE_ENTRY_V4_ENABLED: "true",
        LIVE_ENTRY_NATIVE_LEG_ONLY: "true",
        EXIT_ROUTE_PROOF_REQUIRED: "true",
        PAPER_VALIDATION_ENFORCE: "true",
        PAPER_VALIDATION_MIN_DAYS: "0",
        IL_PROTECTION_ENABLED: "false",
        ENTER_ROUND_TRIP_GAS_USD: "0",
        ENTRY_RANGE_HALF_WIDTH_BINS: "25",
        VOLATILITY_ADAPTIVE_RANGES: "false",
        ENTER_MIN_7D_FEE_OVER_GAS: "0",

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
