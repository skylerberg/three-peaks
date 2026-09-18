# syntax=docker/dockerfile:1
# Build context is the repository root, same as the API image.

FROM node:24-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@11.21.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/preview-edge/package.json ./apps/preview-edge/
COPY packages/shared/package.json ./packages/shared/
# The root `prepare` runs during install; this is the only file it needs.
COPY scripts/setup-hooks.mjs ./scripts/
RUN pnpm install --frozen-lockfile --prod --filter "@three-peaks/preview-edge..."
COPY apps/preview-edge ./apps/preview-edge

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node --from=builder /app /app
USER node
WORKDIR /app/apps/preview-edge
EXPOSE 8080
# Node 24 runs TypeScript directly; this service is small enough not to need a
# bundle step of its own.
CMD ["node", "--experimental-strip-types", "src/index.ts"]
