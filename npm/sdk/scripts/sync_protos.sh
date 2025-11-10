#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTO_DIR="${ROOT}/proto"
TMP_DIR="$(mktemp -d)"
REPO_URL="https://github.com/network-lumen/blockchain.git"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "[lumen-sdk] syncing protos from ${REPO_URL}"
git clone --depth 1 "${REPO_URL}" "${TMP_DIR}/repo" >/dev/null
mkdir -p "${PROTO_DIR}"
rsync -a --delete "${TMP_DIR}/repo/proto/" "${PROTO_DIR}/"
echo "[lumen-sdk] protos updated under ${PROTO_DIR}"
