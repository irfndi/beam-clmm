#!/usr/bin/env bash
# `bun run lint` — typecheck and lint. Run both passes even when one fails so
# a red compiler can never mask oxlint findings (and vice versa); fail if
# either reports anything.
set -u

dirs_str="$(bun scripts/tool-dirs.mjs)" || {
  echo "lint: could not resolve lint target directories" >&2
  exit 1
}
read -r -a dirs <<<"$dirs_str"

tsc --noEmit
ts_status=$?

oxlint --deny-warnings "${dirs[@]}"
ox_status=$?

if [ "$ts_status" -ne 0 ]; then
  echo "lint: tsc --noEmit failed (exit $ts_status)" >&2
fi
if [ "$ox_status" -ne 0 ]; then
  echo "lint: oxlint failed (exit $ox_status)" >&2
fi

[ "$ts_status" -eq 0 ] && [ "$ox_status" -eq 0 ]
