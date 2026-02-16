#!/usr/bin/env bash
set -euo pipefail

SERVICE="${HLAUTO_SERVICE_NAME:-hlauto}"
APP_DIR="${HLAUTO_APP_DIR:-/opt/hlauto/trade}"
SINCE_SPEC="24 hours ago"
UNTIL_SPEC="now"
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      SERVICE="$2"
      shift 2
      ;;
    --since)
      SINCE_SPEC="$2"
      shift 2
      ;;
    --until)
      UNTIL_SPEC="$2"
      shift 2
      ;;
    --app-dir)
      APP_DIR="$2"
      shift 2
      ;;
    --summary-only|--json-only)
      EXTRA_ARGS+=("$1")
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: ops/scripts/ops-report.sh [options]

Options:
  --service <systemd unit>   default: hlauto
  --since <journal since>    default: "24 hours ago"
  --until <journal until>    default: "now"
  --app-dir <path>           default: /opt/hlauto/trade
  --summary-only             print summary only
  --json-only                print json only
EOF
      exit 0
      ;;
    *)
      echo "[ops-report] unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

SINCE_EPOCH="$(date -u -d "$SINCE_SPEC" +%s)"
UNTIL_EPOCH="$(date -u -d "$UNTIL_SPEC" +%s)"

ANALYZER="$APP_DIR/ops/analyze-ops.mjs"
STREAM_DIR="$APP_DIR/data/streams"

if [[ ! -f "$ANALYZER" ]]; then
  echo "[ops-report] analyzer not found: $ANALYZER" >&2
  exit 1
fi

journalctl --utc -u "$SERVICE" --since "$SINCE_SPEC" --until "$UNTIL_SPEC" --no-pager -o cat \
  | node "$ANALYZER" \
      --stream-dir "$STREAM_DIR" \
      --since-epoch "$SINCE_EPOCH" \
      --until-epoch "$UNTIL_EPOCH" \
      --since-label "$SINCE_SPEC" \
      --until-label "$UNTIL_SPEC" \
      "${EXTRA_ARGS[@]}"
