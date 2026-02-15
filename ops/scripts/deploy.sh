#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
APP_USER="${HLAUTO_APP_USER:-hlauto}"
SERVICE_NAME="${HLAUTO_SERVICE_NAME:-hlauto}"
TARGET_REF="${1:-main}"

fatal() {
  echo "[deploy] ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "Missing required command: $1"
}

run_root_cmd() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

run_as_app() {
  if [[ "$(id -un)" == "${APP_USER}" ]]; then
    "$@"
  elif [[ "${EUID}" -eq 0 ]]; then
    runuser -u "${APP_USER}" -- "$@"
  else
    sudo -n -u "${APP_USER}" -- "$@"
  fi
}

require_cmd git
require_cmd npm
require_cmd systemctl
require_cmd journalctl

if [[ "${EUID}" -ne 0 ]]; then
  require_cmd sudo
  sudo -n true >/dev/null 2>&1 || fatal "This script needs passwordless sudo for systemctl/journalctl and sudo -u ${APP_USER}."
fi

id -u "${APP_USER}" >/dev/null 2>&1 || fatal "APP_USER does not exist: ${APP_USER}"
[[ -d "${APP_DIR}" ]] || fatal "APP_DIR does not exist: ${APP_DIR}"

cd "${APP_DIR}"

[[ -d .git ]] || fatal "Not a git repository: ${APP_DIR}"
[[ -f package.json ]] || fatal "package.json missing in ${APP_DIR}"
if ! grep -q '"name"[[:space:]]*:[[:space:]]*"hyperliquid-autotrader"' package.json; then
  fatal "Unexpected repository at ${APP_DIR}"
fi
if ! run_as_app git remote get-url origin >/dev/null 2>&1; then
  fatal "git remote 'origin' is not configured"
fi

echo "[deploy] executor=$(id -un) app_user=${APP_USER} app_dir=$(pwd -P)"
echo "[deploy] target_ref=${TARGET_REF}"

run_as_app git fetch --prune origin

if [[ "${TARGET_REF}" == "main" || "${TARGET_REF}" == "origin/main" ]]; then
  run_as_app git checkout -B main origin/main
elif [[ "${TARGET_REF}" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  if ! run_as_app git cat-file -e "${TARGET_REF}^{commit}" 2>/dev/null; then
    run_as_app git fetch --prune origin "${TARGET_REF}" || fatal "Commit not found on origin: ${TARGET_REF}"
  fi
  run_as_app git checkout --detach "${TARGET_REF}"
else
  if run_as_app git show-ref --verify --quiet "refs/remotes/origin/${TARGET_REF}"; then
    run_as_app git checkout -B "${TARGET_REF}" "origin/${TARGET_REF}"
  elif run_as_app git rev-parse --verify --quiet "${TARGET_REF}^{commit}" >/dev/null; then
    run_as_app git checkout --detach "${TARGET_REF}"
  else
    fatal "Unknown deploy target: ${TARGET_REF}"
  fi
fi

DEPLOYED_SHA="$(run_as_app git rev-parse HEAD)"
echo "[deploy] deployed_sha=${DEPLOYED_SHA}"

run_as_app npm ci
run_as_app npm run test
run_as_app npm run selftest

RESTART_REQUESTED_AT="$(date -u '+%Y-%m-%d %H:%M:%S')"
echo "[deploy] restarting service=${SERVICE_NAME} requested_at=${RESTART_REQUESTED_AT} UTC"

run_root_cmd systemctl daemon-reload
run_root_cmd systemctl restart "${SERVICE_NAME}"
sleep 2

if ! run_root_cmd systemctl is-active --quiet "${SERVICE_NAME}"; then
  run_root_cmd systemctl status "${SERVICE_NAME}" --no-pager || true
  fatal "Service is not active after restart"
fi

ACTIVE_SINCE="$(run_root_cmd systemctl show -p ActiveEnterTimestamp --value "${SERVICE_NAME}" | sed 's/[[:space:]]*$//')"
if [[ -z "${ACTIVE_SINCE}" || "${ACTIVE_SINCE}" == "n/a" ]]; then
  ACTIVE_SINCE="${RESTART_REQUESTED_AT}"
fi

echo "[deploy] service is active; log_window_since=${ACTIVE_SINCE}"

JOURNAL_OUTPUT="$(run_root_cmd journalctl -u "${SERVICE_NAME}" --since "${ACTIVE_SINCE}" --no-pager || true)"

echo "[deploy] ---- journal (${SERVICE_NAME}) ----"
echo "${JOURNAL_OUTPUT}"
echo "[deploy] ---- end journal ----"

if grep -Eiq 'invalid price|vault not registered|blocked_preflight' <<<"${JOURNAL_OUTPUT}"; then
  fatal "Fatal signal detected in journal: invalid price / vault not registered / blocked_preflight"
fi

FLATTEN_COUNT="$(grep -Eic 'Flatten position order submitted|tpsl_emergency_flatten|tpsl_unavailable' <<<"${JOURNAL_OUTPUT}" || true)"
if [[ "${FLATTEN_COUNT}" -ge 3 ]]; then
  fatal "Fatal signal detected: flatten/emergency sequence count=${FLATTEN_COUNT}"
fi

echo "[deploy] SUCCESS sha=${DEPLOYED_SHA} service=${SERVICE_NAME}"
