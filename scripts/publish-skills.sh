#!/usr/bin/env bash
# Publish Beam skills to npm and PyPI registries.
# Usage: ./scripts/publish-skills.sh [--dry-run]

set -euo pipefail

# Reject any invocation with more than one positional argument so an extra
# argument can never silently switch the run from dry-run to real publishing.
if [ "$#" -gt 1 ]; then
  echo "ERROR: unexpected extra arguments" >&2
  echo "Usage: ./scripts/publish-skills.sh [--dry-run]" >&2
  exit 2
fi

# Validate the single positional argument: only an empty value or --dry-run is
# accepted. Anything else is a usage error — a typo must never silently switch
# the run from dry-run to real publishing.
case "${1:-}" in
  "" | "--dry-run") DRY_RUN="${1:-}" ;;
  *)
    echo "ERROR: unknown argument '$1' (expected nothing or --dry-run)" >&2
    echo "Usage: ./scripts/publish-skills.sh [--dry-run]" >&2
    exit 2
    ;;
esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}→${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✘${NC} $1"; }

dry_run_prefix() {
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "[DRY-RUN] "
  else
    echo ""
  fi
}

# ---------------------------------------------------------------------------
# Publish MCP server to npm
# ---------------------------------------------------------------------------

publish_mcp() {
  log_info "Publishing MCP server to npm..."
  cd "$REPO_ROOT/mcp-server"

  if [ "$DRY_RUN" = "--dry-run" ]; then
    # Preview only: never build or mutate anything. No dist/ is required for
    # the preview, so a fresh checkout can still be dry-run.
    log_info "$(dry_run_prefix)npm publish --access public"
    log_info "$(dry_run_prefix)MCP server published."
    return
  fi

  # Always rebuild so a stale dist/ from a previous run can never be published.
  npm run build
  npm publish --access public

  log_info "MCP server published."
}

# ---------------------------------------------------------------------------
# Publish Python packages to PyPI
# ---------------------------------------------------------------------------

publish_python_pkg() {
  local pkg_dir="$1"
  local pkg_name="$2"

  log_info "Publishing $pkg_name to PyPI..."
  cd "$pkg_dir"

  if [ "$DRY_RUN" = "--dry-run" ]; then
    # Preview only: never build or mutate anything. The literal glob mirrors
    # what twine would receive after a build without requiring dist to exist.
    log_info "$(dry_run_prefix)python3 -m twine upload dist/*"
    log_info "$(dry_run_prefix)$pkg_name published."
    return
  fi

  # Always rebuild so a stale dist/ from a previous run can never be published.
  python3 -m build

  # Fail fast on an empty dist instead of passing a literal glob to twine.
  shopt -s nullglob
  local dist_files=(dist/*)
  shopt -u nullglob
  if [ "${#dist_files[@]}" -eq 0 ]; then
    log_error "$pkg_name dist is empty after build; aborting."
    exit 1
  fi

  python3 -m twine upload "${dist_files[@]}"

  log_info "$pkg_name published."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  echo "Beam Skills Publisher"
  echo "======================"
  echo ""

  if [ "$DRY_RUN" = "--dry-run" ]; then
    log_warn "Running in DRY-RUN mode. No actual publishing will occur."
    echo ""
  fi

  # Check prerequisites
  if ! command -v npm &>/dev/null; then
    log_error "npm is required but not installed."
    exit 1
  fi

  if ! command -v python3 &>/dev/null; then
    log_error "python3 is required but not installed."
    exit 1
  fi

  # Preflight the Python build/publish toolchain. This only validates that the
  # tools exist and run — it cannot guarantee a fully atomic release: an auth,
  # network, or registry failure mid-run can still leave earlier packages
  # published while a later one fails. Packages publish in sequence below.
  if ! python3 -m build --version &>/dev/null; then
    log_error "python3 -m build is required but not available (pip install build)."
    exit 1
  fi
  if ! python3 -m twine --version &>/dev/null; then
    log_error "python3 -m twine is required but not available (pip install twine)."
    exit 1
  fi

  # Publish MCP server
  publish_mcp
  echo ""

  # Publish LangChain tool
  publish_python_pkg "$REPO_ROOT/packages/langchain-beam" "langchain-beam"
  echo ""

  # Publish AutoGPT plugin
  publish_python_pkg "$REPO_ROOT/packages/autogpt-beam" "autogpt-beam"
  echo ""

  cd "$REPO_ROOT"

  log_info "All packages published successfully!"
  echo ""
  echo "Next steps:"
  echo "  1. Verify packages on npmjs.com and pypi.org"
  echo "  2. Update marketplaces/README.md with published versions"
  # The tag hint needs node; don't fail the whole run when it is absent.
  if command -v node &>/dev/null; then
    local pkg_version
    pkg_version="$(node -p 'require("./package.json").version')"
    echo "  3. Tag release: git tag -a v${pkg_version} -m \"Release v${pkg_version}\""
  else
    echo "  3. Tag release: git tag -a v<version> -m \"Release v<version>\" (node not on PATH)"
  fi
}

main "$@"
