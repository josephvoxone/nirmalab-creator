#!/bin/sh
# axcel-bridge control: start (default), stop, status, logs.
#   ./axcelctl.sh            start in background (nohup, log to $TMPDIR/axcel-bridge.log)
#   ./axcelctl.sh stop
#   ./axcelctl.sh status     bridge /health through the local API
#   ./axcelctl.sh token      print a fresh AXCEL_BRIDGE_TOKEN line (rotate: paste into Studio too)
set -eu

ENV_FILE="${AXCEL_ENV:-$HOME/.config/opencreator/axcel-bridge.env}"
LOG="${AXCEL_LOG:-${TMPDIR:-/tmp}/axcel-bridge.log}"
DIR="$(cd "$(dirname "$0")" && pwd)"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (AXCEL_BRIDGE_TOKEN=…)" >&2; exit 2; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${AXCEL_BRIDGE_TOKEN:?AXCEL_BRIDGE_TOKEN kosong di $ENV_FILE}"

status() {
  curl -s -m 120 -H "Authorization: Bearer $AXCEL_BRIDGE_TOKEN" "http://127.0.0.1:${AXCEL_BRIDGE_PORT:-8899}/health" \
    -w '\n' || echo '{"ok":false,"error":"bridge tidak menjawab"}'
}

case "${1:-start}" in
  start)
    if pgrep -f "node .*axcel\.mjs" >/dev/null 2>&1; then echo "sudah jalan"; status; exit 0; fi
    AXCEL_DEBUG="${AXCEL_DEBUG:-1}" nohup node "$DIR/axcel.mjs" >>"$LOG" 2>&1 &
    sleep 2
    echo "started (log $LOG)"
    status
    ;;
  stop)
    pkill -f "node .*axcel\.mjs" && echo "stopped" || echo "tidak jalan"
    ;;
  status) status ;;
  logs) tail -n "${2:-40}" "$LOG" ;;
  token)
    printf 'AXCEL_BRIDGE_TOKEN=%s\n' "$(openssl rand -hex 24)"
    echo "# tulis ke $ENV_FILE dan ke Pengaturan › Provider › Axcel (token lama langsung mati)" >&2
    ;;
  *) echo "usage: $0 [start|stop|status|logs|token]" >&2; exit 64 ;;
esac
