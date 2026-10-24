# Nirmalab Flow bridge — headful Chrome + bridge in one container (Dokploy).
#
# Build context MUST contain both trees (bridge imports google-flow-mcp over MCP stdio):
#   cd ~/tools && docker build -f nirmalab-creator/deploy/flow-bridge/Dockerfile -t registry/nirmalab-flow-bridge:0.1 .
#
# Google Chrome (not Debian chromium) on purpose: Flow's composer checks the browser
# build, and Chrome's own fingerprint scores better on reCAPTCHA Enterprise than a
# distro Chromium under Xvfb.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xvfb x11vnc novnc websockify \
      fonts-liberation fonts-noto-color-emoji tini procps \
 && rm -rf /var/lib/apt/lists/*

# real Chrome stable, amd64 (Flow needs a current build)
RUN curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/c.deb \
 && apt-get update && apt-get install -y --no-install-recommends /tmp/c.deb \
 && rm -f /tmp/c.deb && rm -rf /var/lib/apt/lists/*

# google-flow-mcp (deps: @modelcontextprotocol/sdk, playwright-core, zod)
COPY google-flow-mcp /opt/google-flow-mcp
WORKDIR /opt/google-flow-mcp
RUN npm ci --omit=dev >/dev/null 2>&1 || npm install --omit=dev

# the bridge itself
COPY nirmalab-creator/bridge /app
COPY nirmalab-creator/deploy/flow-bridge/entry.sh /app/entry.sh
RUN chmod +x /app/entry.sh /app/flow-chrome.sh /app/run.sh 2>/dev/null || true
WORKDIR /app

ENV NODE_ENV=production \
    FLOW_MCP_DIR=/opt/google-flow-mcp \
    FLOW_HOME=/data/flow \
    FLOW_CDP_URL=http://127.0.0.1:9333 \
    DISPLAY=:99

RUN mkdir -p /data/flow /data/chrome
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entry.sh"]
