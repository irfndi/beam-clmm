#!/usr/bin/env bash
set -euo pipefail

# Universal helper script for the Beam skill.
# Returns a short markdown summary suitable for Telegram/Discord/Slack/WhatsApp.

if ! command -v beam >/dev/null 2>&1; then
  echo "🔺 Beam CLI not found on PATH. Install Beam first." >&2
  exit 1
fi

beam status --message
