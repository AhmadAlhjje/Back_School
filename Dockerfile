# syntax=docker/dockerfile:1.7
#
# Backend image (build context: this folder), used by docker-compose.yml — run
# `docker compose up -d --build` rather than building by hand.
#
#   target runtime: API (node dist/server.js, port 6000) and video worker (node dist/workers/index.js)
#   target tools:   database migrations and seeders (npm run db:migrate / db:seed / admin:create)

ARG NODE_IMAGE=node:22-bookworm-slim

# ─── Dependencies (with dev tooling: TypeScript, Prisma CLI, tsx) ──────────────
FROM ${NODE_IMAGE} AS deps
# OpenSSL: `npm ci` downloads Prisma's migration engine for the detected OpenSSL version (the slim
# image has none); the migrate container runs offline, so the right binary must be here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY database ./database
# postinstall runs `prisma generate` (database/schema.prisma → src/generated/prisma).
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ─── Compile ──────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ─── Production node_modules only ─────────────────────────────────────────────
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the Prisma client is already compiled into dist/generated.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ─── Runtime: API / worker ────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=6000 \
    STORAGE_PATH=/var/lib/edu/storage \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/edu/storage \
 && chown -R node:node /var/lib/edu
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
USER node
EXPOSE 6000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||6000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]

# ─── Tools: migrations, seeders, super-admin creation ─────────────────────────
FROM deps AS tools
ENV NODE_ENV=production
COPY src ./src
COPY scripts ./scripts
USER node
CMD ["npm", "run", "db:migrate"]
