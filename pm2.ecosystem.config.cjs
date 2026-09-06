const root = "/Users/irfandi/Coding/2026/beam-clmm";
const data = `${root}/.data/multichain`;

// Live canary: Base v3 addresses only (v4 poolIds need registry keys).
const LIVE_WATCHLIST = [
  "0x9fef0b7f3ed65cdb3366133719fd22ef2e853f84",
  "0xb2303c937a50dd0faabc0e831d916bdb910d71a5",
  "0xa541143f20d7b0643123064abf25f423e375b531",
  "0x52377cf95f7845650edfecd62792730406f38a30",
].join(",");

// Paper: restored v4 book + v3 candidates.
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
        BEAM_BASE_RPC_URL: "https://mainnet.base.org",
        RPC_FALLBACK_URLS: "https://base-rpc.publicnode.com,https://mainnet.base.org",
        RPC_RETRY_COUNT: "6",
        PAPER_TRADING: "true",
        BEAM_PM2_PAPER_TRADING: "true",
        AUTONOMOUS_TOKEN_MODE: "off",
        ENABLE_POOL_DISCOVERY: "false",
        MARKET_SCAN_ENABLED: "false",
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
        BEAM_BASE_RPC_URL: "https://mainnet.base.org",
        RPC_FALLBACK_URLS: "https://base-rpc.publicnode.com,https://mainnet.base.org",
        RPC_RETRY_COUNT: "6",
        PAPER_TRADING: "false",
        BEAM_PM2_PAPER_TRADING: "false",
        AUTONOMOUS_TOKEN_MODE: "off",
        ENABLE_POOL_DISCOVERY: "false",
        MARKET_SCAN_ENABLED: "false",
        WATCHLIST_POOLS: LIVE_WATCHLIST,
        CONFIDENCE_THRESHOLD: "0.55",
        MAX_OPEN_POSITIONS: "1",
        MAX_POSITIONS_PER_POOL: "1",
        MAX_ENTRY_SIZE_USD: "15",
        MAX_PER_POOL_ALLOCATION_PCT: "0.4",
        ENTRY_SIZE_FLOOR_USD: "6",
        SCAN_INTERVAL_MS: "20000",
        CHALLENGE_MODE: "true",
        CHALLENGE_BOOK_SIZE: "30",
        LIVE_ENTRY_V4_ENABLED: "true",
        LIVE_ENTRY_NATIVE_LEG_ONLY: "true",
        EXIT_ROUTE_PROOF_REQUIRED: "true",
        PAPER_VALIDATION_ENFORCE: "true",
      },
      out_file: `${data}/base-live.out.log`,
      error_file: `${data}/base-live.err.log`,
    },
  ],
};
