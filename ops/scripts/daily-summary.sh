#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
NODE_BIN="${NODE_BIN:-node}"

exec "${NODE_BIN}" "${APP_DIR}/ops/daily-summary.mjs" \
  --app-dir "${APP_DIR}" \
  "$@"

