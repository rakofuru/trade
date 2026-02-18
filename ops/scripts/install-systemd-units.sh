#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
SERVICE_NAME="${HLAUTO_SERVICE_NAME:-hlauto}"
ENABLE_NOW="${ENABLE_NOW:-0}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "[install-units] run as root: sudo bash ops/scripts/install-systemd-units.sh" >&2
  exit 1
fi

install -m 0644 "${APP_DIR}/ops/systemd/hlauto.service" "/etc/systemd/system/${SERVICE_NAME}.service"
install -m 0644 "${APP_DIR}/ops/systemd/hlauto-daily-summary.service" "/etc/systemd/system/hlauto-daily-summary.service"
install -m 0644 "${APP_DIR}/ops/systemd/hlauto-daily-summary.timer" "/etc/systemd/system/hlauto-daily-summary.timer"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl enable hlauto-daily-summary.timer

if [[ "${ENABLE_NOW}" == "1" ]]; then
  systemctl restart "${SERVICE_NAME}"
  systemctl restart hlauto-daily-summary.timer
fi

echo "[install-units] installed from repo source-of-truth: ${APP_DIR}/ops/systemd/*"
