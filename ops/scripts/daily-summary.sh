#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
NODE_BIN="${NODE_BIN:-}"
REPORT_DIR="${HLAUTO_REPORT_DIR:-${APP_DIR}/data/reports}"

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
  echo "[daily-summary] ERROR: node binary not found. set NODE_BIN=/path/to/node" >&2
  exit 1
fi
if [[ ! -x "${NODE_BIN}" ]]; then
  echo "[daily-summary] ERROR: NODE_BIN is not executable: ${NODE_BIN}" >&2
  exit 1
fi

mkdir -p "${REPORT_DIR}" 2>/dev/null || true
if [[ ! -w "${REPORT_DIR}" ]]; then
  echo "[daily-summary] ERROR: report directory is not writable: ${REPORT_DIR} (user=$(id -un))" >&2
  echo "[daily-summary] hint: sudo chown -R $(id -un):$(id -gn) ${APP_DIR}/data" >&2
  exit 1
fi

exec "${NODE_BIN}" "${APP_DIR}/ops/daily-summary.mjs" \
  --app-dir "${APP_DIR}" \
  "$@"
