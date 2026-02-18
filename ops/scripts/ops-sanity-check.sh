#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
BOT_SERVICE="${HLAUTO_SERVICE_NAME:-hlauto}"
SUMMARY_SERVICE="${HLAUTO_SUMMARY_SERVICE_NAME:-hlauto-daily-summary}"
BOT_EXPECT_USER="${BOT_EXPECT_USER:-hlauto}"
BOT_EXPECT_GROUP="${BOT_EXPECT_GROUP:-hlauto}"
SUMMARY_EXPECT_USER="${SUMMARY_EXPECT_USER:-trader}"
SUMMARY_EXPECT_GROUP="${SUMMARY_EXPECT_GROUP:-trader}"
DATA_GROUP_EXPECT="${HLAUTO_DATA_GROUP_EXPECT:-hlauto}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-/bin/systemctl}"
JOURNALCTL_BIN="${JOURNALCTL_BIN:-/bin/journalctl}"

usage() {
  cat <<'EOF'
Usage: ops/scripts/ops-sanity-check.sh [options]

Options:
  --app-dir <path>               default: /opt/hlauto/trade
  --service <systemd unit>       default: hlauto
  --summary-service <unit>       default: hlauto-daily-summary
  --bot-user <user>              default: hlauto
  --bot-group <group>            default: hlauto
  --summary-user <user>          default: trader
  --summary-group <group>        default: trader
  --data-group <group>           default: hlauto
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --service) BOT_SERVICE="$2"; shift 2 ;;
    --summary-service) SUMMARY_SERVICE="$2"; shift 2 ;;
    --bot-user) BOT_EXPECT_USER="$2"; shift 2 ;;
    --bot-group) BOT_EXPECT_GROUP="$2"; shift 2 ;;
    --summary-user) SUMMARY_EXPECT_USER="$2"; shift 2 ;;
    --summary-group) SUMMARY_EXPECT_GROUP="$2"; shift 2 ;;
    --data-group) DATA_GROUP_EXPECT="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "[ops-sanity] unknown argument: $1" >&2; exit 2 ;;
  esac
done

fatal() {
  echo "[ops-sanity] ERROR: $*" >&2
  exit 1
}

info() {
  echo "[ops-sanity] $*"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "missing command: $1"
}

need_cmd sudo
[[ -x "${SYSTEMCTL_BIN}" ]] || fatal "systemctl not executable: ${SYSTEMCTL_BIN}"
[[ -x "${JOURNALCTL_BIN}" ]] || fatal "journalctl not executable: ${JOURNALCTL_BIN}"

sudo -n "${SYSTEMCTL_BIN}" --version >/dev/null 2>&1 || fatal "sudo non-interactive for systemctl is required"
sudo -n "${JOURNALCTL_BIN}" --version >/dev/null 2>&1 || fatal "sudo non-interactive for journalctl is required"

REPORT_DIR="${APP_DIR}/data/reports"
DATA_DIR="${APP_DIR}/data"
[[ -d "${APP_DIR}" ]] || fatal "app dir not found: ${APP_DIR}"
[[ -d "${DATA_DIR}" ]] || fatal "data dir not found: ${DATA_DIR}"
[[ -d "${REPORT_DIR}" ]] || fatal "report dir not found: ${REPORT_DIR}"

id -u trader >/dev/null 2>&1 || fatal "user trader not found"
if ! id -nG trader | tr ' ' '\n' | grep -Fxq "${DATA_GROUP_EXPECT}"; then
  fatal "trader must belong to group ${DATA_GROUP_EXPECT} (run: sudo usermod -aG ${DATA_GROUP_EXPECT} trader)"
fi
info "trader_group_membership=ok expected_group=${DATA_GROUP_EXPECT}"

check_unit_identity() {
  local unit="$1"
  local expected_user="$2"
  local expected_group="$3"
  local wd_expected="$4"
  local exec_hint="$5"

  local actual_user actual_group actual_wd unit_cat
  actual_user="$(sudo -n "${SYSTEMCTL_BIN}" show -p User --value "${unit}" | tr -d '[:space:]')"
  actual_group="$(sudo -n "${SYSTEMCTL_BIN}" show -p Group --value "${unit}" | tr -d '[:space:]')"
  actual_wd="$(sudo -n "${SYSTEMCTL_BIN}" show -p WorkingDirectory --value "${unit}" | tr -d '\r')"
  [[ -n "${actual_user}" ]] || fatal "unit ${unit} user is empty"
  [[ -n "${actual_group}" ]] || fatal "unit ${unit} group is empty"
  [[ "${actual_user}" == "${expected_user}" ]] || fatal "unit ${unit} user mismatch: expected=${expected_user} actual=${actual_user}"
  [[ "${actual_group}" == "${expected_group}" ]] || fatal "unit ${unit} group mismatch: expected=${expected_group} actual=${actual_group}"
  [[ "${actual_wd}" == "${wd_expected}" ]] || fatal "unit ${unit} WorkingDirectory mismatch: expected=${wd_expected} actual=${actual_wd}"
  unit_cat="$(sudo -n "${SYSTEMCTL_BIN}" cat "${unit}" 2>/dev/null || true)"
  grep -q "ExecStart=.*${exec_hint}" <<<"${unit_cat}" || fatal "unit ${unit} ExecStart must include ${exec_hint}"
  info "unit=${unit} user_group_wd_exec=ok"
}

check_setgid_group_write() {
  local target="$1"
  local mode
  mode="$(stat -c '%a' "${target}")"
  local mode_num special group_perm
  mode_num=$((10#${mode}))
  special=$((mode_num / 1000))
  group_perm=$(((mode_num / 10) % 10))
  if (( (special & 2) == 0 )); then
    fatal "setgid missing on ${target} mode=${mode} (expected like 2775)"
  fi
  if (( (group_perm & 2) == 0 )); then
    fatal "group write missing on ${target} mode=${mode}"
  fi
  info "permissions_ok target=${target} mode=${mode}"
}

check_unit_identity "${BOT_SERVICE}" "${BOT_EXPECT_USER}" "${BOT_EXPECT_GROUP}" "${APP_DIR}" "ops/scripts/run-bot.sh"
check_unit_identity "${SUMMARY_SERVICE}" "${SUMMARY_EXPECT_USER}" "${SUMMARY_EXPECT_GROUP}" "${APP_DIR}" "ops/scripts/daily-summary.sh"

if [[ ! -w "${REPORT_DIR}" ]]; then
  fatal "report directory not writable for user=$(id -un): ${REPORT_DIR}"
fi
tmp_file="${REPORT_DIR}/.ops_sanity_write.$$"
echo "ok" > "${tmp_file}" || fatal "cannot write into report dir: ${REPORT_DIR}"
rm -f "${tmp_file}" || true
info "report_write=ok path=${REPORT_DIR}"

check_setgid_group_write "${DATA_DIR}"
check_setgid_group_write "${REPORT_DIR}"

sudo -n "${JOURNALCTL_BIN}" --utc -u "${BOT_SERVICE}" --since "10 minutes ago" -n 1 --no-pager >/dev/null 2>&1 \
  || fatal "journalctl read check failed for ${BOT_SERVICE}"
info "journal_read=ok service=${BOT_SERVICE}"

info "PASS"
