#!/usr/bin/env bash
# Thin entry point: keep shell out of the installer's validation and file writes.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$REPO/install.mjs" "$@"
