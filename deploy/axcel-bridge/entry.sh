#!/bin/sh
# entry.sh — Xvfb + headful Chrome (fixed DevTools port) + the Axcel bridge.
#
# Required env:
#   AXCEL_BRIDGE_TOKEN   token the Studio server sends (Bearer)
#   AXCEL_SESI           the axcel_sesi cookie copied from the user's browser (HttpOnly)
# Optional:
#   AXCEL_SERVER_URL     https://creator.nirmalab.com   (hand the finished file back to the queue)
#   AXCEL_SERVER_TOKEN   token of /data/flow/bridge-token on that server
#   AXCEL_PROXY          http://user:pass@host:port      (residential egress; Cloudflare is strict
#                                                         on datacenter IPs — see README)
#   AXCEL_LOGIN=1        expose noVNC on :6080 and do NOT start the bridge (manual login mode)
set -u

PROFILE="${AXCEL_CHROME_PROFILE:-/data/chrome}"
PORT="${AXCEL_CDP_PORT:-9333}"
mkdir -p "$PROFILE" "${AXCEL_OUT_DIR:-/data/axcel}"

: "${AXCEL_BRIDGE_TOKEN:?set AXCEL_BRIDGE_TOKEN}"
[ -n "${AXCEL_SESI:-}" ] || echo "[entry] WARN: AXCEL_SESI kosong — sesi harus login manual"

Xvfb :99 -screen 0 1400x1000x24 -nolisten tcp >/var/log/xvfb.log 2>&1 &
sleep 2

if [ "${AXCEL_LOGIN:-0}" = "1" ]; then
  x11vnc -display :99 -forever -shared -nopw -rfbport 5900 >/var/log/x11vnc.log 2>&1 &
  websockify --web=/usr/share/novnc 6080 localhost:5900 >/var/log/novnc.log 2>&1 &
  echo "[entry] login mode: noVNC on :6080, bridge NOT started"
fi

# A volume that survives recreates keeps Chrome's Singleton* locks naming the old container.
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket"

set -- --user-data-dir="$PROFILE" --remote-debugging-port="$PORT" \
  --lang=en-US --accept-lang=en-US,en \
  --no-first-run --no-default-browser-check --disable-search-engine-choice-screen \
  --no-sandbox --disable-dev-shm-usage --disable-sync \
  --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
  --window-size=1400,1000 \
  --disable-features=PrivacySandboxSettings4,SigninInterceptBubbleV2
[ -n "${AXCEL_PROXY:-}" ] && set -- "$@" --proxy-server="$AXCEL_PROXY"
set -- "$@" https://axcel.cloud/video/text-to-video

google-chrome "$@" >/var/log/chrome.log 2>&1 &

i=0
while [ "$i" -lt 60 ]; do
  curl -s -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 1; i=$((i + 1))
done
if ! curl -s -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "[entry] FATAL: Chrome never opened DevTools on :$PORT" >&2
  tail -20 /var/log/chrome.log >&2
  exit 1
fi
echo "[entry] Chrome ready on :$PORT"

[ "${AXCEL_LOGIN:-0}" = "1" ] && { sleep infinity; }

# Small guard: the bridge is a node process that must survive Chrome hiccups.
while true; do
  node /app/axcel.mjs >>/var/log/bridge.log 2>&1
  echo "[entry] bridge exited ($?), restarting in 5s" >&2
  tail -20 /var/log/bridge.log >&2
  sleep 5
done
