# Nirmalab Creator — one small image: Fastify API + built web + story assembler (ffmpeg + Python/PIL).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm exec tsc -p server/tsconfig.json \
 && pnpm exec vite build --config web/vite.config.ts \
 && date -u +%Y%m%d-%H%M > server/dist/BUILD

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    OPENCREATOR_DATA_DIR=/data \
    STORY_PYTHON=python3 \
    STORY_ASSEMBLER=/app/bridge/py/assemble.py \
    PORT=3000
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pil ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY bridge/py ./bridge/py
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/main.js"]
