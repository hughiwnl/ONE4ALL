# syntax=docker/dockerfile:1.7
#
# Single image for every Repeat process (web, worker, migrate). The compose
# file picks the command. Built from the monorepo root:
#   docker build -f docker/Dockerfile .
#
# ffmpeg is installed for ffprobe, which extracts duration/dimensions from
# uploads so providers can validate media before spending an upload.

ARG NODE_VERSION=22

# ── deps: install workspace dependencies ─────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/database/package.json packages/database/
COPY packages/queue/package.json packages/queue/
COPY packages/types/package.json packages/types/
COPY packages/providers/all/package.json packages/providers/all/
COPY packages/providers/meta/package.json packages/providers/meta/
COPY packages/providers/mock/package.json packages/providers/mock/
COPY packages/providers/sdk/package.json packages/providers/sdk/
COPY packages/providers/tiktok/package.json packages/providers/tiktok/
COPY packages/providers/youtube/package.json packages/providers/youtube/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── build: generate prisma client, build next + worker ───────────────────────
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 CI=true
RUN pnpm --filter @repeat/database generate \
 && pnpm --filter @repeat/web build \
 && pnpm --filter @repeat/worker build
# Drop devDependencies (pnpm prune is not workspace-safe; a prod-only install is).
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --prefer-offline \
 && pnpm --filter @repeat/database generate

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
RUN apk add --no-cache libc6-compat openssl ffmpeg wget \
 && corepack enable && corepack prepare pnpm@10.34.5 --activate
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    MEDIA_STORAGE_PATH=/data/media
WORKDIR /app
COPY --from=build --chown=node:node /app ./
RUN mkdir -p /data/media && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@repeat/web", "start"]
