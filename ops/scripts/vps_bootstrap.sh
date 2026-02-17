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

APP_USER="${APP_USER:-trader}"
APP_DIR="${APP_DIR:-/opt/hlauto/trade}"
SERVICE_NAME="${SERVICE_NAME:-hlauto}"

apt-get update
apt-get install -y git curl ca-certificates gnupg lsb-release sudo

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

id -u "${APP_USER}" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "${APP_USER}"
id -u hlauto >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash hlauto

install -d -o "${APP_USER}" -g "${APP_USER}" "$(dirname "${APP_DIR}")"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  runuser -u "${APP_USER}" -- git clone "${REPO_URL}" "${APP_DIR}"
else
  echo "[bootstrap] repository already exists at ${APP_DIR}"
fi

chmod +x "${APP_DIR}/ops/scripts/deploy.sh" "${APP_DIR}/ops/scripts/vps_bootstrap.sh"
chmod +x "${APP_DIR}/ops/scripts/ops-report.sh" "${APP_DIR}/ops/scripts/daily-summary.sh" "${APP_DIR}/ops/scripts/performance-report.sh"
install -m 0644 "${APP_DIR}/ops/systemd/hlauto.service" "/etc/systemd/system/${SERVICE_NAME}.service"
install -m 0644 "${APP_DIR}/ops/systemd/hlauto-daily-summary.service" "/etc/systemd/system/hlauto-daily-summary.service"
install -m 0644 "${APP_DIR}/ops/systemd/hlauto-daily-summary.timer" "/etc/systemd/system/hlauto-daily-summary.timer"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl enable --now hlauto-daily-summary.timer
cat >/etc/sudoers.d/hlauto-deploy <<EOF
${APP_USER} ALL=(root) NOPASSWD: /bin/systemctl, /bin/journalctl
EOF
chmod 440 /etc/sudoers.d/hlauto-deploy
visudo -cf /etc/sudoers.d/hlauto-deploy

echo "[bootstrap] done"
echo "[bootstrap] next: create ${APP_DIR}/.env.local (do not commit it)"
echo "[bootstrap] then run as ${APP_USER}: HLAUTO_APP_DIR=${APP_DIR} HLAUTO_APP_USER=${APP_USER} bash ${APP_DIR}/ops/scripts/deploy.sh main"
