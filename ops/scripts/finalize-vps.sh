#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
APP_USER="${HLAUTO_APP_USER:-trader}"
SERVICE_NAME="${HLAUTO_SERVICE_NAME:-hlauto}"
SYSTEM_USER="${HLAUTO_SYSTEM_USER:-hlauto}"
SYSTEM_GROUP="${HLAUTO_SYSTEM_GROUP:-hlauto}"
ENABLE_NOW="${ENABLE_NOW:-1}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "[finalize-vps] run as root: sudo bash ${APP_DIR}/ops/scripts/finalize-vps.sh" >&2
  exit 1
fi

[[ -d "${APP_DIR}" ]] || { echo "[finalize-vps] app dir not found: ${APP_DIR}" >&2; exit 1; }
id -u "${APP_USER}" >/dev/null 2>&1 || { echo "[finalize-vps] app user not found: ${APP_USER}" >&2; exit 1; }

getent group "${SYSTEM_GROUP}" >/dev/null 2>&1 || groupadd --system "${SYSTEM_GROUP}"
id -u "${SYSTEM_USER}" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash -g "${SYSTEM_GROUP}" "${SYSTEM_USER}"
usermod -g "${SYSTEM_GROUP}" "${SYSTEM_USER}" || true
usermod -aG "${SYSTEM_GROUP}" "${APP_USER}" || true

install -d -o "${SYSTEM_USER}" -g "${SYSTEM_GROUP}" \
  "${APP_DIR}/data" \
  "${APP_DIR}/data/streams" \
  "${APP_DIR}/data/rollups" \
  "${APP_DIR}/data/state" \
  "${APP_DIR}/data/reports"

chown -R "${SYSTEM_USER}:${SYSTEM_GROUP}" "${APP_DIR}/data"
find "${APP_DIR}/data" -type d -exec chmod 2775 {} +
find "${APP_DIR}/data" -type f -exec chmod 0664 {} +

if [[ -x "${APP_DIR}/ops/scripts/install-systemd-units.sh" ]]; then
  HLAUTO_APP_DIR="${APP_DIR}" HLAUTO_SERVICE_NAME="${SERVICE_NAME}" ENABLE_NOW=0 \
    bash "${APP_DIR}/ops/scripts/install-systemd-units.sh"
else
  install -m 0644 "${APP_DIR}/ops/systemd/hlauto.service" "/etc/systemd/system/${SERVICE_NAME}.service"
  install -m 0644 "${APP_DIR}/ops/systemd/hlauto-daily-summary.service" "/etc/systemd/system/hlauto-daily-summary.service"
  install -m 0644 "${APP_DIR}/ops/systemd/hlauto-daily-summary.timer" "/etc/systemd/system/hlauto-daily-summary.timer"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl enable hlauto-daily-summary.timer
fi

cat >/etc/sudoers.d/hlauto-deploy <<EOF
${APP_USER} ALL=(root) NOPASSWD: /bin/systemctl, /bin/journalctl
EOF
chmod 440 /etc/sudoers.d/hlauto-deploy
visudo -cf /etc/sudoers.d/hlauto-deploy

if [[ "${ENABLE_NOW}" == "1" ]]; then
  systemctl restart "${SERVICE_NAME}"
  systemctl restart hlauto-daily-summary.timer
fi

echo "[finalize-vps] done"
echo "[finalize-vps] next (as ${APP_USER}):"
echo "  newgrp ${SYSTEM_GROUP}"
echo "  bash ${APP_DIR}/ops/scripts/ops-sanity-check.sh --app-dir ${APP_DIR} --service ${SERVICE_NAME} --summary-service hlauto-daily-summary"
echo "  sudo systemctl start hlauto-daily-summary.service"
