module.exports = {
  apps: [
    {
      name: "beam-agent",
      script: "/Users/irfandi/Coding/2026/beam-clmm/logs/beam-pm2.sh",
      interpreter: "/bin/bash",
      cwd: "/Users/irfandi/Coding/2026/beam-clmm",
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      exp_backoff_restart_delay: 100,
      out_file: "/Users/irfandi/Coding/2026/beam-clmm/logs/pm2-out.log",
      error_file: "/Users/irfandi/Coding/2026/beam-clmm/logs/pm2-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
