#!/usr/bin/env bash
# `bun run lint` — typecheck and lint. Run every pass even when one fails so a
# red compiler can never mask oxlint findings (and vice versa); fail if any
# reports anything.
set -u

dirs_str="$(bun scripts/tool-dirs.mjs)" || {
  echo "lint: could not resolve lint target directories" >&2
  exit 1
}
read -r -a dirs <<<"$dirs_str"

# Fast Rust typechecker first (~1.5s vs ~40s): a type error surfaces before the
# slow pass. tsrs is a beta port of TypeScript 7 aiming at 100% conformance, so
# `tsc` below stays authoritative and still gates the build.
bunx --bun tsrs --noEmit --fast
tsrs_status=$?

tsc --noEmit
ts_status=$?

# Effect's type-aware rules are only injected through `effect-tsgo`, which
# preloads the patched Oxlint binding via NODE_OPTIONS/BUN_OPTIONS. Plain
# `oxlint` loads the stock binding and rejects every `effecttsgo/*` rule as
# unknown. `--type-aware` also enables the tsgolint-backed rules the config
# expects.
bunx --bun effect-tsgo oxlint --type-aware --deny-warnings "${dirs[@]}"
ox_status=$?

if [ "$tsrs_status" -ne 0 ]; then
  echo "lint: tsrs --noEmit --fast failed (exit $tsrs_status)" >&2
fi
if [ "$ts_status" -ne 0 ]; then
  echo "lint: tsc --noEmit failed (exit $ts_status)" >&2
fi
if [ "$ox_status" -ne 0 ]; then
  echo "lint: oxlint failed (exit $ox_status)" >&2
fi

[ "$tsrs_status" -eq 0 ] && [ "$ts_status" -eq 0 ] && [ "$ox_status" -eq 0 ]
