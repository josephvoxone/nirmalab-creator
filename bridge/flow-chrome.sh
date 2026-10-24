#!/bin/sh
# Open (or reuse) a dedicated real Chrome for one Flow account, with a fixed
# DevTools port so the bridge can attach without the per-client Allow prompt.
#   ./flow-chrome.sh [account-name] [port]      e.g. ./flow-chrome.sh flow-01 9333
# English UI is forced: Flow automation matches English labels (a launchd start has no LANG).
# Register in Studio with folder profile: cdp:http://127.0.0.1:<port>
NAME="${1:-flow-01}"; PORT="${2:-9333}"
DIR="$HOME/.google-flow-mcp/chrome/$NAME"
mkdir -p "$DIR" && chmod 700 "$DIR"
if curl -s -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null; then echo "already running on :$PORT"; exit 0; fi
open -na "Google Chrome" --args --user-data-dir="$DIR" --remote-debugging-port="$PORT" \
  --lang=en-US --accept-lang=en-US,en --no-first-run --no-default-browser-check --disable-search-engine-choice-screen \
  --disable-sync --disable-features=PrivacySandboxSettings4,SigninInterceptBubbleV2 \
  https://flow.google.com/
for i in $(seq 1 20); do curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null && { echo "Chrome '$NAME' on :$PORT"; exit 0; }; sleep 1; done
echo "Chrome did not open DevTools on :$PORT" >&2; exit 1
