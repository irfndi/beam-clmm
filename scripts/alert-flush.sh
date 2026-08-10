#!/usr/bin/env bash
# Flush undelivered Telegram alerts via the bot's authenticated internal
# endpoint. Exit codes: 0 = flushed, 1 = curl failure, non-2xx HTTP status, or
# malformed status. The response body embeds alert-derived (user-influenced)
# text, so workflow-command prefixes in it are neutralized before echoing.
#
# Extracted from .github/workflows/alert-flush.yml so the shell logic is
# unit-testable (see scripts/test-alert-flush.sh).

set -u

FLUSH_URL="${FLUSH_URL:-https://beam-telegram-bot.irfndi.workers.dev/internal/flush-alerts}"
BOT_API_SECRET="${BOT_API_SECRET:-}"

# Keep the primary capture and the failure branch separate: on curl failure
# $status is empty, so normalize it to 000 (never concatenate status onto the
# body stream, which would let a server-side failure silently succeed).
status=$(curl -sS -o /tmp/beam-flush-body --max-time 60 -X POST \
  "${FLUSH_URL}" \
  -H "X-Bot-Api-Secret: ${BOT_API_SECRET}" \
  -w '%{http_code}')
code=$?
[ -n "$status" ] || status="000"

body=$(cat /tmp/beam-flush-body 2>/dev/null || true)

# Sanitize GitHub Actions workflow-command prefixes: '::' (current syntax) and
# the legacy '##[' form. The response body embeds alert-derived text, so a
# crafted value could otherwise inject log annotations / workflow commands.
clean=$(printf '%s\n' "$body" | sed -e 's/^::/:: /' -e 's/^##\[/## \[/')
echo "response body: ${clean}"
echo "curl exit code: ${code}"
echo "HTTP status: ${status}"

if [ "$code" -ne 0 ]; then
  echo "::error::alert flush failed (curl exit ${code})"
  exit "$code"
fi

# A server-side failure must not silently succeed: any non-2xx status fails.
if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
  echo "::error::alert flush returned HTTP ${status}"
  exit 1
fi
