#!/usr/bin/env bash
# Wrapper for the beam CLI — always runs from the package install root.
# Symlinking cli/index.ts would let beam setup / dev operate on the
# caller's CWD (path.resolve('.env') / no cwd override respectively).
# This is the value of package.json's "bin" entry.
set -euo pipefail

# Follow symlinks so the wrapper works via global bin symlinks too.
SOURCE="${BASH_SOURCE[0]}"
hops=0
while [ -L "$SOURCE" ] && [ $hops -lt 40 ]; do
  DIR=$(dirname -- "$SOURCE")
  SOURCE=$(readlink "$SOURCE")
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
  hops=$((hops + 1))
done
if [ $hops -ge 40 ]; then
  echo "ERROR: Too many symlink levels" >&2
  exit 1
fi
PACKAGE_ROOT=$(cd -- "$(dirname -- "$SOURCE")/.." && pwd)

# Preserve the caller's directory so the CLI can resolve relative paths (e.g.
# `beam wallet import ./kp.json`) against it after we cd into the package root.
export BEAM_CALLER_CWD="$PWD"

cd "$PACKAGE_ROOT"
export BEAM_INSTALL_DIR="$PACKAGE_ROOT"

# Fail fast with a clear message on a broken install instead of letting bun
# report a cryptic module-not-found error from the exec below.
if [ ! -f "$PACKAGE_ROOT/cli/index.ts" ]; then
  echo "ERROR: beam install broken: cli/index.ts not found at $PACKAGE_ROOT/cli/index.ts" >&2
  exit 1
fi

# The Bun installer (bun.sh/install) puts bun under ~/.bun/bin but does not
# always persist it to a shell rc, so a fresh shell or systemd unit may not have
# it on PATH. Resolve PATH first, then the standard install location.
BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ] && [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi
if [ -z "$BUN_BIN" ]; then
  echo "ERROR: bun not found on PATH or at \$HOME/.bun/bin/bun" >&2
  echo "Install it with: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

# Enforce the engines.bun constraint from package.json — the single source of
# truth — so an old bun fails with an actionable message instead of a confusing
# runtime error, and the two can never drift apart. Pure bash (no external
# tools) so the gate works even with a stripped-down PATH.
MIN_BUN_VERSION=""
while IFS= read -r line; do
  case "$line" in
    *'"bun"'*)
      value="${line#*\"bun\": \"}"
      MIN_BUN_VERSION="${value%\"*}"
      break
      ;;
  esac
done < "$PACKAGE_ROOT/package.json"
# Strip a leading range operator (>=, ^, ~, ...) if one is declared.
MIN_BUN_VERSION="${MIN_BUN_VERSION#>=}"
MIN_BUN_VERSION="${MIN_BUN_VERSION#^}"
MIN_BUN_VERSION="${MIN_BUN_VERSION#~}"
if [ -z "$MIN_BUN_VERSION" ]; then
  echo "ERROR: could not read engines.bun from package.json (expected e.g. \">=1.4.0-canary.1\")" >&2
  exit 1
fi

BUN_VERSION_RAW="$("$BUN_BIN" --version 2>/dev/null || true)"
if [ -z "$BUN_VERSION_RAW" ]; then
  echo "ERROR: could not determine bun version from '$BUN_BIN'" >&2
  exit 1
fi

# Portable dotted-version comparison (awk, no GNU sort -V on macOS).
if ! command -v awk &>/dev/null; then
  echo "ERROR: awk is required for the bun version check but was not found on PATH" >&2
  exit 1
fi
# Prerelease-aware: X.Y.Z compares numerically; when equal, a version with a
# prerelease is lower than one without, and prerelease labels compare
# dot-segment by dot-segment (semver §11) — all-digit segments numerically
# (canary.10 > canary.9), anything else lexicographically.
if ! awk -v a="$BUN_VERSION_RAW" -v b="$MIN_BUN_VERSION" 'BEGIN {
  split(a, A, "."); split(b, B, ".");
  for (i = 1; i <= 3; i++) {
    na = (i in A) ? A[i] + 0 : 0;
    nb = (i in B) ? B[i] + 0 : 0;
    if (na < nb) exit 1;
    if (na > nb) exit 0;
  }
  pa = (index(a, "-") > 0) ? substr(a, index(a, "-") + 1) : "";
  pb = (index(b, "-") > 0) ? substr(b, index(b, "-") + 1) : "";
  if (pa == "" && pb != "") exit 0;
  if (pa != "" && pb == "") exit 1;
  npa = split(pa, PA, "."); npb = split(pb, PB, ".");
  for (i = 1; i <= (npa < npb ? npa : npb); i++) {
    a_num = (PA[i] ~ /^[0-9]+$/) ? 1 : 0;
    b_num = (PB[i] ~ /^[0-9]+$/) ? 1 : 0;
    if (a_num && b_num) {
      if (PA[i] + 0 < PB[i] + 0) exit 1;
      if (PA[i] + 0 > PB[i] + 0) exit 0;
    } else {
      if (PA[i] < PB[i]) exit 1;
      if (PA[i] > PB[i]) exit 0;
    }
  }
  if (npa < npb) exit 1;
  if (npa > npb) exit 0;
  exit 0;
}'; then
  echo "ERROR: bun $BUN_VERSION_RAW is too old; beam requires bun >= $MIN_BUN_VERSION" >&2
  echo "Upgrade it with: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

exec "$BUN_BIN" "$PACKAGE_ROOT/cli/index.ts" ${1+"$@"}
