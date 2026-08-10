#!/usr/bin/env bash
# Self-check for scripts/alert-flush.sh against a local mock HTTP server.
# Verifies: exit 0 on HTTP 200, exit 1 on HTTP 500, exit non-zero on curl
# failure, and sanitized output for both '::' and legacy '##[' command prefixes.
set -eu

cd "$(dirname "$0")/.."

MOCK_LOG="$(mktemp)"
SERVER_PID=""
FAILURES=0

start_mock() { # $1 = status code to serve
  python3 -c '
import http.server, socketserver, sys
port, code = int(sys.argv[1]), int(sys.argv[2])
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers()
    def do_POST(self):
        self.send_response(code); self.end_headers()
        self.wfile.write(b"::error::injected\n##[error]legacy\nok")
    def log_message(self, *a):
        pass
with socketserver.TCPServer(("127.0.0.1", port), Handler) as srv:
    srv.serve_forever()
' "$1" "$2" &
  SERVER_PID=$!
  for _ in $(seq 1 50); do
    if curl -s "http://127.0.0.1:$1/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "mock server on port $1 did not come up" >&2
  exit 1
}

stop_mock() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

run_flush() { # $1 = port (or "" for closed port), $2 = expected exit code
  local port="$1" expected="$2" out got
  set +e
  if [ -n "$port" ]; then
    out=$(FLUSH_URL="http://127.0.0.1:${port}/internal/flush-alerts" BOT_API_SECRET=test \
      bash scripts/alert-flush.sh 2>&1)
  else
    # Nothing listens on port 1 (privileged, reserved) → curl connection failure.
    out=$(FLUSH_URL="http://127.0.0.1:1/internal/flush-alerts" BOT_API_SECRET=test \
      bash scripts/alert-flush.sh 2>&1)
  fi
  got=$?
  set -e
  if [ "$expected" = "nonzero" ]; then
    if [ "$got" -eq 0 ]; then
      echo "FAIL: expected non-zero exit, got 0" >&2
      printf '%s\n' "$out" >&2
      FAILURES=$((FAILURES + 1))
    fi
  elif [ "$got" -ne "$expected" ]; then
    echo "FAIL: expected exit $expected, got $got" >&2
    printf '%s\n' "$out" >&2
    FAILURES=$((FAILURES + 1))
  fi
  printf '%s' "$out" > "$MOCK_LOG"
}

# HTTP 200 → success.
start_mock 18731 200
run_flush 18731 0
stop_mock
if grep -q ':: error::injected' "$MOCK_LOG" && grep -q '## \[error\]legacy' "$MOCK_LOG"; then
  : # sanitization worked
else
  echo "FAIL: workflow-command prefixes were not sanitized" >&2
  printf '%s\n' "$(cat "$MOCK_LOG")" >&2
  FAILURES=$((FAILURES + 1))
fi

# HTTP 500 → failure.
start_mock 18732 500
run_flush 18732 1
stop_mock

# curl failure (closed port) → non-zero exit.
run_flush "" nonzero

if [ "$FAILURES" -ne 0 ]; then
  echo "test-alert-flush: ${FAILURES} failure(s)" >&2
  exit 1
fi
echo "test-alert-flush: all checks passed"
