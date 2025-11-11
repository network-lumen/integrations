#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/../sdk" && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../../.." && pwd)"
NODE_HOME="$REPO_ROOT/artifacts/docker-node"

clean_node_state() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [[ -d "$NODE_HOME" ]]; then
    docker run --rm -v "$NODE_HOME":/data alpine sh -c "rm -rf /data/*" >/dev/null 2>&1 || true
    rm -rf "$NODE_HOME"
  fi
}

CONTAINER_NAME="${CONTAINER_NAME:-lumen-local-node}"
KEEP_CONTAINER="${KEEP_CONTAINER:-0}"

cleanup() {
  if [[ "$KEEP_CONTAINER" -eq 0 ]]; then
    clean_node_state
  else
    echo "KEEP_CONTAINER=1 -> leaving container '$CONTAINER_NAME' and node data intact." >&2
  fi
}
trap cleanup EXIT INT TERM

echo "➤ Resetting local node state..."
clean_node_state

echo "➤ Bootstrapping Dockerized node..."
CONTAINER_NAME="$CONTAINER_NAME" bash "$SCRIPT_DIR/docker_localnet.sh"

run_npm_script() {
  local script="$1"
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    bash -lc "source \"$HOME/.nvm/nvm.sh\" && cd \"$PKG_ROOT\" && npm run ${script}"
  else
    (cd "$PKG_ROOT" && npm run "${script}")
  fi
}

echo "➤ Running SDK smoke test against dockerized node..."
run_npm_script sdk:smoke

echo "➤ Running SDK functional suite..."
run_npm_script sdk:functional

if [[ "$KEEP_CONTAINER" -eq 0 ]]; then
  echo "➤ Cleaning up node data..."
  clean_node_state
fi

if [[ "$KEEP_CONTAINER" -eq 0 ]]; then
  echo "➤ Dockerized node stopped."
else
  echo "➤ KEEP_CONTAINER=1 set; node left running as '$CONTAINER_NAME'."
fi
