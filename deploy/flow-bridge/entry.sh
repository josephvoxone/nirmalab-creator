#!/bin/sh
# entry.sh — Xvfb + headful Chrome on :9333, then the bridge daemon.
# Login is interactive: run once with FLOW_LOGIN=1 to expose noVNC on :6080,
# sign in to Flow with the burner account, then restart without it.
set -u

PROFILE="${FLOW_PROFILE_DIR:-/data/chrome}"
PORT="${FLOW_CDP_PORT:-9333}"

# bridge reads its config from a file, not from the container env (0600)
mkdir -p "$(dirname "${FLOW_BRIDGE_ENV:-$HOME/.config/opencreator/flow-bridge.env}")" "$FLOW_HOME"
ENVF="${FLOW_BRIDGE_ENV:-$HOME/.config/opencreator/flow-bridge.env}"
umask 077
cat >"$ENVF" <<EOF
FLOW_BRIDGE_TOKEN=${FLOW_BRIDGE_TOKEN:?set FLOW_BRIDGE_TOKEN}
CREATOR_URL=${CREATOR_URL:?set CREATOR_URL}
FLOW_MAX_CREDITS=${FLOW_MAX_CREDITS:-20}
FLOW_RESOLUTION=${FLOW_RESOLUTION:-360p}
EOF
chmod 600 "$ENVF"

# a stale X lock from the previous container run makes Xvfb refuse to start
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1400x1000x24 -nolisten tcp >/var/log/xvfb.log 2>&1 &
sleep 2

if [ "${FLOW_LOGIN:-0}" = "1" ]; then
  x11vnc -display :99 -forever -shared -nopw -rfbport 5900 >/var/log/x11vnc.log 2>&1 &
  websockify --web=/usr/share/novnc 6080 localhost:5900 >/var/log/novnc.log 2>&1 &
  echo "[entry] login mode: Chrome + noVNC only — bridge NOT started (it navigates the page)."
else
  echo "[entry] headless mode (no noVNC)"
fi

# headful Chrome; --no-sandbox is required as root in a container
# A volume that survives recreates keeps Chrome's Singleton* lock files, naming the
# previous container — the new one then refuses to start ("profile appears to be in use").
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket"
google-chrome \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --lang=en-US --accept-lang=en-US,en \
  --no-first-run --no-default-browser-check \
  --no-sandbox --disable-dev-shm-usage \
  --disable-gpu --disable-sync \
  --disable-features=PrivacySandboxSettings4,SigninInterceptBubbleV2 \
  "https://flow.google.com/" >/var/log/chrome.log 2>&1 &

i=0
while [ "$i" -lt 40 ]; do
  curl -s -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 1; i=$((i+1))
done
if ! curl -s -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "[entry] FATAL: Chrome never opened DevTools on :$PORT — see /var/log/chrome.log" >&2
  tail -20 /var/log/chrome.log >&2
  exit 1
fi
echo "[entry] Chrome ready on :$PORT ($(curl -s "http://127.0.0.1:$PORT/json/version" | head -c 120))"

if [ "${FLOW_LOGIN:-0}" = "1" ]; then
  # Interactive sign-in: nothing may touch the page while a human logs in.
  # The bridge's 30 s status probe navigates the tab back to flow.google.com/about,
  # which is why a login attempt snapped back to the landing page.
  echo "[entry] holding in login mode — restart with FLOW_LOGIN=0 to start the bridge"
  while :; do sleep 30; done
fi

# First-run dialogs (welcome, privacy) sit over the composer and eat the bridge's clicks.
# The guard clears them best effort; it must never block the bridge from starting.
if [ -f /app/overlay-guard.mjs ]; then
  node /app/overlay-guard.mjs >>/var/log/overlay-guard.log 2>&1 &
  echo "[entry] overlay guard started (log: /var/log/overlay-guard.log)"
fi

cd /app && exec "$@"
