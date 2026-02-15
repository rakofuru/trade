#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
SERVICE_NAME="${HLAUTO_SERVICE_NAME:-hlauto}"
TARGET_REF="${1:-main}"

fatal() {
  echo "[deploy] ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "Missing required command: $1"
}

require_cmd git
require_cmd npm
require_cmd systemctl
require_cmd journalctl
require_cmd sudo

if [[ ! -d "${APP_DIR}" ]]; then
  fatal "APP_DIR does not exist: ${APP_DIR}"
fi

cd "${APP_DIR}"

if [[ ! -d .git ]]; then
  fatal "Not a git repository: ${APP_DIR}"
fi
if [[ ! -f package.json ]]; then
  fatal "package.json missing in ${APP_DIR}"
fi
if ! grep -q '"name"[[:space:]]*:[[:space:]]*"hyperliquid-autotrader"' package.json; then
  fatal "Unexpected repository at ${APP_DIR}"
fi

echo "[deploy] app_dir=$(pwd -P)"
echo "[deploy] target_ref=${TARGET_REF}"

git fetch --prune origin

if [[ "${TARGET_REF}" == "main" || "${TARGET_REF}" == "origin/main" ]]; then
  git checkout -B main origin/main
elif [[ "${TARGET_REF}" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  if ! git cat-file -e "${TARGET_REF}^{commit}" 2>/dev/null; then
    git fetch --prune origin "${TARGET_REF}" || fatal "Commit not found on origin: ${TARGET_REF}"
  fi
  git checkout --detach "${TARGET_REF}"
else
  if git show-ref --verify --quiet "refs/remotes/origin/${TARGET_REF}"; then
    git checkout -B "${TARGET_REF}" "origin/${TARGET_REF}"
  elif git rev-parse --verify --quiet "${TARGET_REF}^{commit}" >/dev/null; then
    git checkout --detach "${TARGET_REF}"
  else
    fatal "Unknown deploy target: ${TARGET_REF}"
  fi
fi

DEPLOYED_SHA="$(git rev-parse HEAD)"
echo "[deploy] deployed_sha=${DEPLOYED_SHA}"

npm ci
npm run test
npm run selftest

DEPLOY_STARTED_AT="$(date -u '+%Y-%m-%d %H:%M:%S')"
echo "[deploy] restarting service=${SERVICE_NAME} since=${DEPLOY_STARTED_AT} UTC"

sudo systemctl daemon-reload
sudo systemctl restart "${SERVICE_NAME}"
sleep 2

if ! sudo systemctl is-active --quiet "${SERVICE_NAME}"; then
  sudo systemctl status "${SERVICE_NAME}" --no-pager || true
  fatal "Service is not active after restart"
fi

echo "[deploy] service is active"

JOURNAL_OUTPUT="$(sudo journalctl -u "${SERVICE_NAME}" --since "${DEPLOY_STARTED_AT}" -n 200 --no-pager || true)"

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
