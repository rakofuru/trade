#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
NPM_BIN="${NPM_BIN:-}"

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

cd "${APP_DIR}"
exec "${NPM_BIN}" run start
