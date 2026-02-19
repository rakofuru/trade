#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
NODE_BIN="${NODE_BIN:-}"
REPORT_DIR="${HLAUTO_REPORT_DIR:-${APP_DIR}/data/reports}"
DATA_DIR="${HLAUTO_DATA_DIR:-${APP_DIR}/data}"
EXPECTED_USER="${HLAUTO_DAILY_SUMMARY_EXPECT_USER:-trader}"
EXPECTED_DATA_GROUP="${HLAUTO_DATA_GROUP_EXPECT:-hlauto}"
BOT_SERVICE="${HLAUTO_SERVICE_NAME:-hlauto}"
JOURNALCTL_BIN="${JOURNALCTL_BIN:-/bin/journalctl}"

diag() {
  echo "[daily-summary] $*"
}

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

if [[ "$(id -un)" != "${EXPECTED_USER}" ]]; then
  echo "[daily-summary] ERROR: expected user=${EXPECTED_USER}, actual user=$(id -un)" >&2
  exit 1
fi
if ! id -nG | tr ' ' '\n' | grep -Fxq "${EXPECTED_DATA_GROUP}"; then
  echo "[daily-summary] ERROR: user $(id -un) is not in expected group ${EXPECTED_DATA_GROUP}" >&2
  echo "[daily-summary] hint: sudo usermod -aG ${EXPECTED_DATA_GROUP} $(id -un) && newgrp ${EXPECTED_DATA_GROUP}" >&2
  exit 1
fi

mkdir -p "${REPORT_DIR}" 2>/dev/null || true
if [[ ! -w "${REPORT_DIR}" ]]; then
  echo "[daily-summary] ERROR: report directory is not writable: ${REPORT_DIR} (user=$(id -un))" >&2
  echo "[daily-summary] hint: sudo chown -R ${EXPECTED_DATA_GROUP}:${EXPECTED_DATA_GROUP} ${DATA_DIR}; sudo chmod -R g+rwX ${DATA_DIR}; sudo find ${DATA_DIR} -type d -exec chmod 2775 {} +" >&2
  exit 1
fi
DATA_MODE="$(stat -c '%a' "${DATA_DIR}" 2>/dev/null || echo "n/a")"
REPORT_MODE="$(stat -c '%a' "${REPORT_DIR}" 2>/dev/null || echo "n/a")"
diag "diag user=$(id -un) groups=$(id -nG) data_dir_mode=${DATA_MODE} report_dir_mode=${REPORT_MODE}"

if [[ -x "${JOURNALCTL_BIN}" ]]; then
  if sudo -n "${JOURNALCTL_BIN}" --utc -u "${BOT_SERVICE}" --since "5 minutes ago" -n 1 --no-pager >/dev/null 2>&1; then
    diag "diag journal_access=ok service=${BOT_SERVICE}"
  else
    diag "diag journal_access=failed service=${BOT_SERVICE} (non-fatal for summary generation)"
  fi
fi

exec "${NODE_BIN}" "${APP_DIR}/ops/daily-summary.mjs" \
  --app-dir "${APP_DIR}" \
  "$@"
