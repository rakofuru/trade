#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
CADDY_CONFIG="${HLAUTO_CADDY_CONFIG:-${APP_DIR}/ops/caddy/Caddyfile}"
CADDY_BIN="${CADDY_BIN:-}"

if [[ -z "${CADDY_BIN}" ]]; then
  for candidate in /usr/bin/caddy /usr/local/bin/caddy "${APP_DIR}/bin/caddy"; do
    if [[ -x "${candidate}" ]]; then
      CADDY_BIN="${candidate}"
      break
    fi
  done
fi

if [[ -z "${CADDY_BIN}" ]]; then
  echo "[run-webhook-proxy] caddy binary not found (checked: /usr/bin/caddy, /usr/local/bin/caddy, ${APP_DIR}/bin/caddy)" >&2
  exit 1
fi

if [[ ! -f "${CADDY_CONFIG}" ]]; then
  echo "[run-webhook-proxy] caddy config not found: ${CADDY_CONFIG}" >&2
  exit 1
fi

exec "${CADDY_BIN}" run --environ --config "${CADDY_CONFIG}" --adapter caddyfile
