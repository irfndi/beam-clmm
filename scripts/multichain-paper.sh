#!/usr/bin/env bash
# Launch Beam paper agents on Base + Robinhood in parallel.
#
# Multi-chain isolation model: the engine selects its chain via BEAM_CHAIN and
# uses a per-process SQLite DB (SQLITE_DB_PATH) + agent instance id + RPC vars.
# Running two pm2 processes gives the parallel-on-2-chains setup the user
# asked for; adding a 3rd chain is another pm2 block with its own env.
#
# Both are PAPER mode (no wallet/broadcast). Live mode = flip PAPER_TRADING=false
# and fund the per-chain wallet key.
set -euo pipefail
cd /Users/irfandi/Coding/2026/beam-clmm

ROOT=/Users/irfandi/Coding/2026/beam-clmm
DATA="$ROOT/.data/multichain"
mkdir -p "$DATA"

# ── Base paper agent ─────────────────────────────────────────────────────────
pm2 delete beam-base >/dev/null 2>&1 || true
# Guard against cross-chain env leakage: the operator shell may have sourced
# .env (Base vars). Unset the other chain's RPC vars so each agent's pm2
# snapshot is exactly its own chain's endpoints.
unset BEAM_ROBINHOOD_RPC_URL ROBINHOOD_RPC_URL ROBINHOOD_RPC_FALLBACK_URL 2>/dev/null || true
BEAM_CHAIN=base \
AGENT_INSTANCE_ID=beam-base \
SQLITE_DB_PATH="$DATA/base.db" \
BEAM_INSTALL_DIR="$ROOT" \
BEAM_BASE_RPC_URL=https://mainnet.base.org \
RPC_FALLBACK_URLS=https://base-rpc.publicnode.com,https://mainnet.base.org \
RPC_RETRY_COUNT=6 \
PAPER_TRADING=true \
pm2 start "$ROOT/logs/beam-pm2.sh" --name beam-base --cwd "$ROOT" \
  --log "$DATA/base.out.log" --error "$DATA/base.err.log" \
  --merge-logs

# ── Robinhood paper agent ────────────────────────────────────────────────────
pm2 delete beam-robinhood >/dev/null 2>&1 || true
# Guard against cross-chain env leakage: unset Base RPC vars before this start.
unset BEAM_BASE_RPC_URL RPC_FALLBACK_URL 2>/dev/null || true
BEAM_CHAIN=robinhood \
AGENT_INSTANCE_ID=beam-robinhood \
SQLITE_DB_PATH="$DATA/robinhood.db" \
BEAM_INSTALL_DIR="$ROOT" \
BEAM_ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
# Keyless free-tier fallbacks (no API key needed): PublicNode is verified to
# serve eth_call + eth_getBalance on chain 4663. dRPC's free tier blocks those
# methods so it is deliberately NOT listed here. Both are fallbacks only — the
# official Robinhood endpoint stays primary.
RPC_FALLBACK_URLS=https://robinhood-rpc.publicnode.com \
RPC_RETRY_COUNT=6 \
PAPER_TRADING=true \
pm2 start "$ROOT/logs/beam-pm2.sh" --name beam-robinhood --cwd "$ROOT" \
  --log "$DATA/robinhood.out.log" --error "$DATA/robinhood.err.log" \
  --merge-logs

# Retire the old single-chain beam-agent (superseded by the two parallel ones).
pm2 delete beam-agent >/dev/null 2>&1 || true

sleep 3
pm2 list 2>/dev/null | grep -E "beam-(base|robinhood)|beam-agent"
echo "Both paper agents launched. Logs: $DATA/"
