#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "[bootstrap] run as root" >&2
  echo "Usage: sudo bash vps_bootstrap.sh <git_repo_url>" >&2
  exit 1
fi

REPO_URL="${1:-}"
if [[ -z "${REPO_URL}" ]]; then
  echo "Usage: $0 <git_repo_url>" >&2
  exit 1
fi

APP_USER="${APP_USER:-hlauto}"
APP_DIR="${APP_DIR:-/opt/hlauto/trade}"
SERVICE_NAME="${SERVICE_NAME:-hlauto}"

apt-get update
apt-get install -y git curl ca-certificates gnupg lsb-release sudo

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "${APP_USER}"
fi

install -d -o "${APP_USER}" -g "${APP_USER}" "$(dirname "${APP_DIR}")"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  runuser -u "${APP_USER}" -- git clone "${REPO_URL}" "${APP_DIR}"
else
  echo "[bootstrap] repository already exists at ${APP_DIR}"
fi

chmod +x "${APP_DIR}/ops/scripts/deploy.sh" "${APP_DIR}/ops/scripts/vps_bootstrap.sh"
install -m 0644 "${APP_DIR}/ops/systemd/hlauto.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

echo "[bootstrap] done"
echo "[bootstrap] next: create ${APP_DIR}/.env.local (do not commit it)"
echo "[bootstrap] then run: sudo HLAUTO_APP_DIR=${APP_DIR} HLAUTO_APP_USER=${APP_USER} bash ${APP_DIR}/ops/scripts/deploy.sh main"
