#!/usr/bin/env bash
# PM2 launcher for Beam. PM2 uses bash because its Bun fork container cannot
# require the TypeScript CLI entrypoint directly.
set -euo pipefail

ROOT=/Users/irfandi/Coding/2026/beam-clmm
cd "$ROOT"

# PM2 may merge values from the operator shell during `--update-env`. Reapply
# the profile's isolation-critical values here so a sourced project .env cannot
# silently switch chains, databases, instance locks, or paper/live mode.
if [ -n "${BEAM_PM2_CHAIN:-}" ]; then
  export BEAM_CHAIN="$BEAM_PM2_CHAIN"
fi
if [ -n "${BEAM_PM2_AGENT_INSTANCE_ID:-}" ]; then
  export AGENT_INSTANCE_ID="$BEAM_PM2_AGENT_INSTANCE_ID"
fi
if [ -n "${BEAM_PM2_SQLITE_DB_PATH:-}" ]; then
  export SQLITE_DB_PATH="$BEAM_PM2_SQLITE_DB_PATH"
fi
if [ -n "${BEAM_PM2_PAPER_TRADING:-}" ]; then
  export PAPER_TRADING="$BEAM_PM2_PAPER_TRADING"
fi

exec "$ROOT/scripts/beam.sh" dev
