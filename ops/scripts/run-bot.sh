#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
NODE_BIN="${NODE_BIN:-}"
LOCK_FILE="${HLAUTO_LOCK_FILE:-${APP_DIR}/data/state/hlauto.lock}"
KILL_SWITCH_FILE="${HLAUTO_KILL_SWITCH_FILE:-${RUNTIME_KILL_SWITCH_FILE:-${APP_DIR}/data/state/KILL_SWITCH}}"

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
  echo "[run-bot] ERROR: node binary not found. set NODE_BIN=/path/to/node" >&2
  exit 1
fi
if [[ ! -x "${NODE_BIN}" ]]; then
  echo "[run-bot] ERROR: NODE_BIN is not executable: ${NODE_BIN}" >&2
  exit 1
fi
if [[ ! -f "${APP_DIR}/src/index.mjs" ]]; then
  echo "[run-bot] ERROR: src/index.mjs not found under APP_DIR=${APP_DIR}" >&2
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

child_pid=""

terminate_child() {
  local sig="${1:-TERM}"
  if [[ -z "${child_pid}" ]]; then
    return 0
  fi
  if ! kill -0 "${child_pid}" >/dev/null 2>&1; then
    return 0
  fi

  # Prefer process-group signal so npm + node are terminated together.
  kill -"${sig}" "-${child_pid}" >/dev/null 2>&1 || kill -"${sig}" "${child_pid}" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    if ! kill -0 "${child_pid}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  kill -KILL "-${child_pid}" >/dev/null 2>&1 || kill -KILL "${child_pid}" >/dev/null 2>&1 || true
}

on_term() {
  echo "[run-bot] stop signal received; terminating child process group" >&2
  terminate_child TERM
  exit 0
}

trap on_term INT TERM

# setsid ensures child process gets its own process group.
setsid "${NODE_BIN}" src/index.mjs &
child_pid="$!"
wait "${child_pid}"
exit_code="$?"
child_pid=""
exit "${exit_code}"
