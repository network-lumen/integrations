#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
mkdir -p "$DIST"

echo "➤ Building Dilithium3 WASM runtime"
pushd "$ROOT" >/dev/null
GOOS=js GOARCH=wasm go build -trimpath -o "$DIST/dilithium3.wasm" .
popd >/dev/null

GOROOT="$(go env GOROOT)"
EXEC_JS="$GOROOT/misc/wasm/wasm_exec.js"
if [ -f "$EXEC_JS" ]; then
  cp "$EXEC_JS" "$DIST/wasm_exec.js"
else
  echo "⚠ Could not find wasm_exec.js under $EXEC_JS; skipping copy"
fi

echo "✓ Artifacts written to $DIST"
