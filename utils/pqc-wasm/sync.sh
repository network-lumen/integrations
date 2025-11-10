#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
DEFAULT_DEST="$ROOT/../../npm/sdk/src/pqc"
DEST="${1:-$DEFAULT_DEST}"

if [ ! -f "$DIST/dilithium3.wasm" ]; then
  echo "dilithium3.wasm not found in $DIST. Run build.sh first." >&2
  exit 1
fi

mkdir -p "$DEST"
cp "$DIST/dilithium3.wasm" "$DEST/dilithium3.wasm"

echo "✓ Synced dilithium3.wasm to $DEST"
