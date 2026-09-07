#!/usr/bin/env bash
# PM2 launcher for Beam. PM2 uses bash because its Bun fork container cannot
# require the TypeScript CLI entrypoint directly.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

# PM2 may merge values from the operator shell during `--update-env`. Reapply
# the profile's isolation-critical values here so a sourced project .env cannot
# silently switch chains, databases, instance locks, or paper/live mode.
# Generic rule: any BEAM_PM2_<KEY> shadows <KEY> (covers all pinned keys).
for __v in $(env | grep '^BEAM_PM2_' | cut -d= -f1); do
  __k=${__v#BEAM_PM2_}
  eval "export ${__k}=\"\${${__v}}\""
done
unset __v __k

exec "$ROOT/scripts/beam.sh" dev
