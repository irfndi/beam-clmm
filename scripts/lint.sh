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

# The anti-slop oxlint plugin (tools/oxlint/anti-slop) ships its own rule tests
# via oxlint's RuleTester harness, which refuses to run under Bun (it throws on
# "other runtimes") and falls outside the bench/** vitest include. Exercise them
# under plain Node here so the plugin's rules are actually validated by the lint
# gate instead of being silently untested tooling.
plugin_tests_status=0
for test_file in tools/oxlint/anti-slop/src/rules/*.test.ts; do
  if [ ! -f "$test_file" ]; then
    continue
  fi
  node "$test_file" || {
    echo "lint: anti-slop plugin test failed: $test_file" >&2
    plugin_tests_status=1
  }
done

# The anti-slop plugin under tools/ is linted AND typechecked (root tsconfig
# includes it) but deliberately kept OUT of the oxfmt format scope
# (tool-dirs.mjs): it is a vendored third-party copy whose upstream style oxfmt
# would rewrite wholesale. tsc still typechecks it, and oxlint covers it here.
oxlint --deny-warnings "${dirs[@]}" tools
ox_status=$?

if [ "$ts_status" -ne 0 ]; then
  echo "lint: tsc --noEmit failed (exit $ts_status)" >&2
fi
if [ "$ox_status" -ne 0 ]; then
  echo "lint: oxlint failed (exit $ox_status)" >&2
fi
if [ "$plugin_tests_status" -ne 0 ]; then
  echo "lint: anti-slop plugin tests failed" >&2
fi

[ "$ts_status" -eq 0 ] && [ "$ox_status" -eq 0 ] && [ "$plugin_tests_status" -eq 0 ]
