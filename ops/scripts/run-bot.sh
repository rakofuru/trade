#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
NPM_BIN="${NPM_BIN:-}"
LOCK_FILE="${HLAUTO_LOCK_FILE:-${APP_DIR}/data/state/hlauto.lock}"
KILL_SWITCH_FILE="${HLAUTO_KILL_SWITCH_FILE:-${RUNTIME_KILL_SWITCH_FILE:-${APP_DIR}/data/state/KILL_SWITCH}}"

resolve_npm_bin() {
  if [[ -n "${NPM_BIN}" ]]; then
    echo "${NPM_BIN}"
    return 0
  fi
  if command -v npm >/dev/null 2>&1; then
    command -v npm
    return 0
  fi
  if [[ -x "/usr/bin/npm" ]]; then
    echo "/usr/bin/npm"
    return 0
  fi
  if [[ -x "/usr/local/bin/npm" ]]; then
    echo "/usr/local/bin/npm"
    return 0
  fi
  return 1
}

NPM_BIN="$(resolve_npm_bin || true)"
if [[ -z "${NPM_BIN}" ]]; then
  echo "[run-bot] ERROR: npm binary not found. set NPM_BIN=/path/to/npm" >&2
  exit 1
fi
if [[ ! -x "${NPM_BIN}" ]]; then
  echo "[run-bot] ERROR: NPM_BIN is not executable: ${NPM_BIN}" >&2
  exit 1
fi
if [[ ! -f "${APP_DIR}/package.json" ]]; then
  echo "[run-bot] ERROR: package.json not found under APP_DIR=${APP_DIR}" >&2
  exit 1
fi

mkdir -p "$(dirname "${LOCK_FILE}")"

if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    echo "[run-bot] ERROR: another bot process is running (lock=${LOCK_FILE})" >&2
    exit 1
  fi
else
  echo "[run-bot] WARN: flock not found; single-instance lock is disabled" >&2
fi

while [[ -n "${KILL_SWITCH_FILE}" && -f "${KILL_SWITCH_FILE}" ]]; do
  echo "[run-bot] kill switch active (file=${KILL_SWITCH_FILE}); waiting for removal" >&2
  sleep 30
done

cd "${APP_DIR}"
exec "${NPM_BIN}" run start
