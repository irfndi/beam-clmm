#!/usr/bin/env bash
set -euo pipefail

# Helper script for the Beam skill.
# Returns a JSON summary of current status, positions, and recent decisions.

if ! command -v beam >/dev/null 2>&1; then
  echo '{"error":"beam CLI not found on PATH"}' >&2
  exit 1
fi

beam status --json
