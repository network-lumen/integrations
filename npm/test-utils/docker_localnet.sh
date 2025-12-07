#!/usr/bin/env bash
set -euo pipefail

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: missing dependency '$1'" >&2
    exit 1
  fi
}

require docker
require jq
require python3
require curl
require file
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/../sdk" && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../../.." && pwd)"
LOCAL_RUNTIME_DOCKERFILE="$SCRIPT_DIR/runtime.Dockerfile"
NODE_HOME="$REPO_ROOT/artifacts/docker-node"
BIN_CACHE="$REPO_ROOT/artifacts/bin-cache"
IMAGE_TAG="${IMAGE_TAG:-lumen-node:local}"
CONTAINER_NAME="${CONTAINER_NAME:-lumen-local-node}"
CHAIN_ID="${CHAIN_ID:-lumen-local-1}"
VALIDATOR_KEY_NAME="${VALIDATOR_KEY_NAME:-validator}"

mkdir -p "$NODE_HOME"
mkdir -p "$BIN_CACHE"

DEFAULT_RELEASE_URL="https://github.com/network-lumen/blockchain/releases/download/v1.3.0/linux-amd64-v1.3.0.tar.gz"
RELEASE_URL="${LUMEN_RELEASE_URL:-$DEFAULT_RELEASE_URL}"
ARCHIVE_NAME="$(basename "$RELEASE_URL")"

detect_archive_type() {
  local file_path="$1"
  if [[ ! -s "$file_path" ]]; then
    echo "unknown"
    return
  fi
  local mime=""
  mime=$(file -b --mime-type "$file_path" 2>/dev/null || true)
  case "$mime" in
    application/gzip|application/x-gzip) echo "tar.gz"; return ;;
    application/zip) echo "zip"; return ;;
    application/x-executable|application/x-pie-executable|application/x-elf|application/octet-stream) echo "binary"; return ;;
  esac
  if [[ "$file_path" == *.tar.gz || "$file_path" == *.tgz ]]; then
    echo "tar.gz"
    return
  fi
  if [[ "$file_path" == *.zip ]]; then
    echo "zip"
    return
  fi
  if [[ -x "$file_path" ]]; then
    echo "binary"
    return
  fi
  echo "unknown"
}

resolve_relative() {
  python3 - <<'PY' "$1" "$2"
import os, sys
target = os.path.relpath(sys.argv[1], sys.argv[2])
print(target)
PY
}

download_release_binary() {
  local url="$RELEASE_URL"
  local archive_path="$BIN_CACHE/$ARCHIVE_NAME"
  if [[ ! -f "$archive_path" || "${FORCE_LUMEN_DOWNLOAD:-0}" -eq 1 ]]; then
    echo "➤ Downloading lumend archive from $url"
    if ! curl -fL "$url" -o "$archive_path"; then
      rm -f "$archive_path"
      echo "error: failed to download lumend archive from $url" >&2
      exit 1
    fi
  else
    echo "➤ Reusing cached archive $archive_path"
  fi
  local extract_dir
  extract_dir="$(mktemp -d)"
  local archive_type
  archive_type="$(detect_archive_type "$archive_path")"
  case "$archive_type" in
    tar.gz)
      if ! tar -C "$extract_dir" -xzf "$archive_path"; then
        rm -rf "$extract_dir" "$archive_path"
        echo "error: failed to extract tar.gz archive (cache cleared, retry the command)" >&2
        exit 1
      fi
      ;;
    zip)
      require unzip
      if ! unzip -q "$archive_path" -d "$extract_dir"; then
        rm -rf "$extract_dir" "$archive_path"
        echo "error: failed to extract zip archive (cache cleared, retry the command)" >&2
        exit 1
      fi
      ;;
    binary)
      cp "$archive_path" "$extract_dir/lumend"
      ;;
    *)
      rm -rf "$extract_dir" "$archive_path"
      echo "error: unsupported or corrupted archive: $archive_path" >&2
      exit 1
      ;;
  esac
  local candidate=""
  if [[ -f "$extract_dir/lumend" ]]; then
    candidate="$extract_dir/lumend"
  elif [[ -f "$extract_dir/lumend.exe" ]]; then
    candidate="$extract_dir/lumend.exe"
  else
    candidate="$(find "$extract_dir" -maxdepth 1 -type f -perm -u+x -print -quit || true)"
    if [[ -z "$candidate" ]]; then
      candidate="$(find "$extract_dir" -maxdepth 1 -type f -print -quit || true)"
    fi
    if [[ -z "$candidate" ]]; then
      candidate="$(find "$extract_dir" -type f -perm -u+x -print -quit || true)"
    fi
    if [[ -z "$candidate" ]]; then
      candidate="$(find "$extract_dir" -type f -print -quit || true)"
    fi
  fi
  if [[ -z "$candidate" ]]; then
    echo "error: could not locate lumend binary inside archive" >&2
    exit 1
  fi
  local dest="$BIN_CACHE/lumend"
  mv "$candidate" "$dest"
  chmod +x "$dest"
  rm -rf "$extract_dir"
  LUMEND_BIN="$dest"
}

if [[ -n "${LUMEND_BIN:-}" && -x "$LUMEND_BIN" ]]; then
  echo "➤ Using existing lumend binary at $LUMEND_BIN"
else
  download_release_binary
fi

LUMEND_SRC_RELATIVE="lumend"
D_RUNTIME_FILE="$LOCAL_RUNTIME_DOCKERFILE"
BUILD_CONTEXT="$(mktemp -d)"
cp "$LUMEND_BIN" "$BUILD_CONTEXT/$LUMEND_SRC_RELATIVE"
cp "$D_RUNTIME_FILE" "$BUILD_CONTEXT/runtime.Dockerfile"

echo "➤ Building Docker runtime image (${IMAGE_TAG})..."
DOCKER_BUILDKIT=0 docker build \
  --build-arg LUMEND_SRC="./${LUMEND_SRC_RELATIVE}" \
  -t "$IMAGE_TAG" \
  -f "$BUILD_CONTEXT/runtime.Dockerfile" \
  "$BUILD_CONTEXT" >/dev/null

run_container() {
  docker run --rm \
    -v "$NODE_HOME":/root/.lumen \
    "$IMAGE_TAG" "$@"
}

ensure_permissions() {
  docker run --rm -v "$NODE_HOME":/data alpine sh -c "chown -R $(id -u):$(id -g) /data" >/dev/null 2>&1 || true
}

apply_config_patches() {
  local CONFIG_FILE="$NODE_HOME/config/config.toml"
  local APP_FILE="$NODE_HOME/config/app.toml"
  if [[ ! -f "$CONFIG_FILE" || ! -f "$APP_FILE" ]]; then
    return
  fi
  python3 <<PY
from pathlib import Path

config_path = Path(r"""$CONFIG_FILE""")
app_path = Path(r"""$APP_FILE""")

def patch_section(path, section, replacements):
    lines = path.read_text().splitlines()
    current = None
    prefix = f"[{section}]"
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current = stripped
        if current == prefix:
            for key, value in replacements.items():
                if stripped.startswith(f"{key} ="):
                    lines[idx] = f"{key} = {value}"
    path.write_text("\n".join(lines) + "\n")

def patch_root_key(path, key, value):
    lines = path.read_text().splitlines()
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(f"{key} ="):
            lines[idx] = f"{key} = {value}"
            break
    else:
        lines.append(f"{key} = {value}")
    path.write_text("\n".join(lines) + "\n")

patch_section(config_path, "rpc", {
    "laddr": '"tcp://0.0.0.0:26657"',
    "pprof_laddr": '"0.0.0.0:6060"',
})
patch_section(app_path, "api", {
    "enable": "true",
    "swagger": "true",
    "address": '"tcp://0.0.0.0:1317"',
})
patch_section(app_path, "grpc", {
    "address": '"0.0.0.0:9090"',
    "enable": "true",
})
patch_section(app_path, "grpc-web", {
    "address": '"0.0.0.0:9091"',
    "enable": "true",
})
patch_root_key(app_path, "minimum-gas-prices", '"0ulmn"')
PY
}

apply_genesis_overrides() {
  local GENESIS_FILE="$NODE_HOME/config/genesis.json"
  local VALIDATOR_JSON="$NODE_HOME/validator.json"
  if [[ ! -f "$GENESIS_FILE" || ! -f "$VALIDATOR_JSON" ]]; then
    return
  fi
  python3 <<PY
import json
from pathlib import Path

genesis_path = Path(r"""$GENESIS_FILE""")
validator_info = json.loads(Path(r"""$VALIDATOR_JSON""").read_text())
validator_addr = validator_info.get("address")

data = json.loads(genesis_path.read_text())

dns_params = data.get("app_state", {}).get("dns", {}).get("params", {})
dns_params["update_rate_limit_seconds"] = "1"
dns_params["update_pow_difficulty"] = 0
dns_params["min_price_ulmn_per_month"] = "600000"

gateway_params = data.get("app_state", {}).get("gateways", {}).get("params", {})
gateway_params["month_seconds"] = "1"
gateway_params["finalize_delay_months"] = 0
gateways_state = data.get("app_state", {}).get("gateways", {})
if gateways_state is not None:
    gateways_state["gateway_count"] = "1"

release_params = data.get("app_state", {}).get("release", {}).get("params", {})
if validator_addr:
    allowed = release_params.get("allowed_publishers") or []
    if validator_addr not in allowed:
        allowed.append(validator_addr)
    release_params["allowed_publishers"] = allowed

genesis_path.write_text(json.dumps(data, indent=2) + "\n")
PY
}

if [[ ! -f "$NODE_HOME/config/genesis.json" ]]; then
  echo "➤ Initializing fresh chain data in $NODE_HOME"
  run_container init docker-node --chain-id "$CHAIN_ID"
  run_container keys add "$VALIDATOR_KEY_NAME" \
    --keyring-backend test \
    --algo secp256k1 \
    --output json >"$NODE_HOME/validator.json"

  VAL_ADDR="$(jq -r '.address' "$NODE_HOME/validator.json")"
  if [[ -z "$VAL_ADDR" || "$VAL_ADDR" == "null" ]]; then
    echo "error: failed to extract validator address" >&2
    exit 1
  fi

  run_container genesis add-genesis-account "$VAL_ADDR" 100000000000ulmn --keyring-backend test
  run_container genesis gentx "$VALIDATOR_KEY_NAME" 50000000000ulmn --chain-id "$CHAIN_ID" --keyring-backend test
  run_container genesis collect-gentxs

  ensure_permissions
  apply_genesis_overrides
fi

apply_config_patches

echo "➤ Starting container ${CONTAINER_NAME}"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER_NAME" \
  -v "$NODE_HOME":/root/.lumen \
  -p 27657:26657 \
  -p 2327:1317 \
  -p 9190:9090 \
  "$IMAGE_TAG" start --home /root/.lumen >/dev/null

echo "➤ Waiting for RPC endpoint..."
started_at=$(date +%s)
while true; do
  if curl -sf http://127.0.0.1:27657/status >/dev/null; then
    echo "Node is live. RPC=http://127.0.0.1:27657 REST=http://127.0.0.1:2327 gRPC=http://127.0.0.1:9190"
    echo "Validator mnemonic saved under $NODE_HOME/validator.json"
    break
  fi
  now=$(date +%s)
  elapsed=$((now - started_at))
  if [ "$elapsed" -ge "${TM_RPC_TIMEOUT:-120}" ]; then
    echo "error: node did not become ready within ${TM_RPC_TIMEOUT:-120}s" >&2
    docker logs "$CONTAINER_NAME" | tail -n 50 >&2
    exit 1
  fi
  sleep 2
done
