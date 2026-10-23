#!/bin/sh
# Start the OpenCreator ⇄ Google Flow bridge with the local secret env file.
set -e
ENV_FILE="${FLOW_BRIDGE_ENV:-$HOME/.config/opencreator/flow-bridge.env}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
cd "$(dirname "$0")"
exec node bridge.mjs "$@"
