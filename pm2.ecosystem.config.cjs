const root = "/Users/irfandi/Coding/2026/beam-clmm";
const data = `${root}/.data/multichain`;

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
        AGENT_INSTANCE_ID: "beam-base",
        SQLITE_DB_PATH: `${data}/base.db`,
        BEAM_INSTALL_DIR: root,
        BEAM_BASE_RPC_URL: "https://mainnet.base.org",
        RPC_FALLBACK_URLS: "https://base-rpc.publicnode.com,https://mainnet.base.org",
        RPC_RETRY_COUNT: "6",
        PAPER_TRADING: "true",
      },
      out_file: `${data}/base.out.log`,
      error_file: `${data}/base.err.log`,
    },
    {
      ...common,
      name: "beam-robinhood",
      env: {
        BEAM_CHAIN: "robinhood",
        AGENT_INSTANCE_ID: "beam-robinhood",
        SQLITE_DB_PATH: `${data}/robinhood.db`,
        BEAM_INSTALL_DIR: root,
        BEAM_ROBINHOOD_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
        RPC_FALLBACK_URLS: "https://robinhood-rpc.publicnode.com",
        RPC_RETRY_COUNT: "6",
        PAPER_TRADING: "true",
      },
      out_file: `${data}/robinhood.out.log`,
      error_file: `${data}/robinhood.err.log`,
    },
  ],
};
