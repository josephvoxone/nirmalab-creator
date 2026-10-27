# Nirmalab Axcel bridge — Chrome + bridge in one container (Dokploy VPS).
#
# Axcel (`axcel.cloud`, plan Gold) has no public API: its web app calls `/api/*` with the
# `axcel_sesi` cookie plus Cloudflare Turnstile tokens minted in the page. So this container runs a
# real Chrome under Xvfb next to the Studio server and exposes the local bridge API on :8899.
#
# Build (context = repo root):
#   docker build -f deploy/axcel-bridge/Dockerfile -t nirmalab-axcel-bridge:1 .
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xvfb x11vnc novnc websockify \
      fonts-liberation fonts-noto-color-emoji tini procps \
 && rm -rf /var/lib/apt/lists/*

# Google Chrome stable (amd64) — its fingerprint scores better than distro Chromium
RUN curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/c.deb \
 && apt-get update && apt-get install -y --no-install-recommends /tmp/c.deb \
 && rm -f /tmp/c.deb && rm -rf /var/lib/apt/lists/*

COPY bridge /app
COPY deploy/axcel-bridge/entry.sh /app/entry.sh
RUN chmod +x /app/entry.sh

WORKDIR /app
ENV NODE_ENV=production \
    DISPLAY=:99 \
    AXCEL_CHROME_PROFILE=/data/chrome \
    AXCEL_OUT_DIR=/data/axcel \
    AXCEL_BRIDGE_PORT=8899

RUN mkdir -p /data/chrome /data/axcel
VOLUME ["/data"]
EXPOSE 8899

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entry.sh"]
