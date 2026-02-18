#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
NODE_BIN="${NODE_BIN:-}"

resolve_node_bin() {
  if [[ -n "${NODE_BIN}" ]]; then
    echo "${NODE_BIN}"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  if [[ -x "/usr/bin/node" ]]; then
    echo "/usr/bin/node"
    return 0
  fi
  if [[ -x "/usr/local/bin/node" ]]; then
    echo "/usr/local/bin/node"
    return 0
  fi
  return 1
}

NODE_BIN="$(resolve_node_bin || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[position-why] ERROR: node binary not found. set NODE_BIN=/path/to/node" >&2
  exit 1
fi

exec "${NODE_BIN}" "${APP_DIR}/ops/position-why.mjs" \
  --app-dir "${APP_DIR}" \
  "$@"
