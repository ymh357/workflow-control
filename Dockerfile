# syntax=docker/dockerfile:1.7
# Multi-stage Dockerfile for workflow-control (apps/server + apps/web)
# Usage: docker compose up -d
#
# Targets:
#   - server: Hono API on :3001, runs `node apps/server/dist/index.js`
#   - web:    Next.js dashboard on :3000, runs `pnpm --filter web start`
#
# Node 22 (alpine). Project engines declare >=20; 22 LTS is the upper bound
# the devDeps (@types/node ^22) are pinned to.

# --- Base: shared toolchain -----------------------------------------
FROM node:22-alpine AS base
# Native deps needed by node-pty postinstall + any C++ addons in the tree.
RUN apk add --no-cache libc6-compat python3 make g++ git
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /repo

# --- Deps: install all workspace dependencies -----------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# --- Builder: compile server + build web ----------------------------
FROM deps AS builder
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY packages ./packages
# `@workflow-control/shared` exports ts sources directly (no build step).
# Server: tsc -> apps/server/dist
RUN pnpm --filter server run build
# Web: next build -> apps/web/.next
RUN pnpm --filter web run build

# --- Runtime: server ------------------------------------------------
FROM base AS server
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3001
COPY --from=builder /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=builder /repo/apps/server/package.json ./apps/server/
COPY --from=builder /repo/apps/server/dist ./apps/server/dist
# Non-ts runtime assets: tsc doesn't copy .json/.md. The server resolves
# these relative to its compiled location (dist/**), so mirror them in dist/.
COPY --from=builder /repo/apps/server/src/builtin-pipelines ./apps/server/dist/builtin-pipelines
COPY --from=builder /repo/apps/server/src/prompts ./apps/server/dist/prompts
# Shared package exports .ts directly — keep source files available at runtime.
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/server/node_modules ./apps/server/node_modules
EXPOSE 3001
VOLUME ["/data"]
CMD ["node", "apps/server/dist/index.js"]

# --- Runtime: web ---------------------------------------------------
FROM base AS web
ENV NODE_ENV=production \
    PORT=3000
COPY --from=builder /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=builder /repo/apps/web/package.json ./apps/web/
COPY --from=builder /repo/apps/web/next.config.ts ./apps/web/
COPY --from=builder /repo/apps/web/.next ./apps/web/.next
COPY --from=builder /repo/apps/web/public ./apps/web/public
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/web/node_modules ./apps/web/node_modules
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]
