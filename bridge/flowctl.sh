#!/bin/sh
# flowctl.sh — on-demand control for the Nirmalab Flow engine. No LaunchAgents.
#   ./flowctl.sh up      start Flow Chrome (:9333) + bridge daemon, then verify
#   ./flowctl.sh down    stop bridge + Chrome (Mac ringan lagi, RAM dibalikin)
#   ./flowctl.sh status  what runs, RSS, free RAM
#
# The com.nirmalab.* LaunchAgents were deleted because an always-on Chrome costs
# ~1 GB. This starts the same two processes only while rendering, and nothing at
# idle. Only touches the dedicated Flow profile — never the user's own Chrome.
set -u
NAME="${FLOW_NAME:-flow-01}"
PORT="${FLOW_PORT:-9333}"
DIR="$HOME/.google-flow-mcp/chrome/$NAME"
BRIDGE="$HOME/tools/nirmalab-creator/bridge"
LOG="$HOME/Documents/nirmalab/flow/logs/bridge.log"
PIDF="$HOME/Documents/nirmalab/flow/bridge.pid"

rss_mb() { ps -o rss=,command= -ax | grep "$1" | grep -v grep | awk '{s+=$1} END{printf "%.0f", s/1024}'; }
devtools() { curl -s -m 3 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }
bridge_pid() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null && cat "$PIDF"; }

case "${1:-status}" in
  up)
    sh "$BRIDGE/flow-chrome.sh" "$NAME" "$PORT" || exit 1
    i=0; while [ $i -lt 15 ]; do devtools && break; sleep 1; i=$((i+1)); done
    devtools || { echo "FAILED: no DevTools on :$PORT" >&2; exit 1; }
    if [ -z "$(bridge_pid)" ]; then
      mkdir -p "$(dirname "$LOG")"
      nohup "$BRIDGE/run.sh" >>"$LOG" 2>&1 &
      echo $! >"$PIDF"
      sleep 4
    fi
    if [ -n "$(bridge_pid)" ]; then
      echo "engine up — chrome :$PORT ~$(rss_mb "chrome/$NAME") MB, bridge pid $(bridge_pid) ~$(ps -o rss= -p "$(bridge_pid)" | awk '{printf "%.0f",$1/1024}') MB"
    else
      echo "chrome up but bridge failed — tail $LOG" >&2; exit 1
    fi
    ;;
  down)
    p="$(bridge_pid)"; [ -n "$p" ] && kill "$p" 2>/dev/null; rm -f "$PIDF"
    pkill -f "user-data-dir=$DIR" 2>/dev/null
    sleep 2
    if devtools; then echo "warning: still answering on :$PORT" >&2; else echo "engine down — RAM back"; fi
    ;;
  status)
    if devtools; then echo "chrome  :$PORT  up (~$(rss_mb "chrome/$NAME") MB)"; else echo "chrome  :$PORT  down"; fi
    p="$(bridge_pid)"
    if [ -n "$p" ]; then echo "bridge  up  pid $p (~$(ps -o rss= -p "$p" | awk '{printf "%.0f",$1/1024}') MB)"; else echo "bridge  down"; fi
    echo "free RAM: $(vm_stat | awk '/Pages free/{printf "%.0f MB", $3*16384/1048576}')"
    ;;
  *) echo "usage: $0 {up|down|status}" >&2; exit 2 ;;
esac
