# syntax=docker/dockerfile:1

# The build context is the REPOSITORY ROOT, not apps/api. A workspace install
# needs the root manifests, the single root lockfile and every workspace package
# the API depends on -- none of which live under apps/api. The deploy workflow
# passes `context: .` with `file: apps/api/Dockerfile`.

FROM node:24-alpine AS builder
WORKDIR /app

# argon2 falls back to node-gyp when no prebuild matches the platform.
RUN apk add --no-cache python3 make g++
RUN npm install -g pnpm@11.21.0

# Manifests first, so a source-only change reuses the install layer. Every
# manifest pnpm resolves against has to be present: it reads the whole workspace
# to validate the lockfile even when the install itself is filtered.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/preview-edge/package.json ./apps/preview-edge/
COPY packages/shared/package.json ./packages/shared/

# Before the install, not after: pnpm runs the root project's `prepare` during
# `pnpm install` -- including under --frozen-lockfile and --prod -- and prepare
# is `node scripts/setup-hooks.mjs`. Without it already here the install dies on
# MODULE_NOT_FOUND rather than on anything to do with dependencies.
#
# That one file, not the directory. Copying the whole of scripts/ put every dev
# and CI script into the build context, and the deploy filter mirrors this COPY
# -- so a branch touching test-guards.mjs rolled the API for web-only work.
COPY scripts/setup-hooks.mjs ./scripts/

# The trailing `...` means "and everything it depends on", so packages/shared is
# installed and the web app's toolchain -- svelte, tailwind, playwright, vite --
# never enters this image at all.
RUN pnpm install --frozen-lockfile --filter "@three-peaks/api..."

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN pnpm --filter @three-peaks/api run build:prod

# A second --prod install rather than a prune: pnpm's own docs steer away from
# prune, and re-resolving against the same frozen lockfile drops the
# devDependencies. Same filter, or packages/shared goes with them.
# The dependency set shrinks here, so pnpm wants to purge node_modules and
# refuses to without a TTY. Scoped to this one command rather than set as a
# workspace setting, because that confirmation is a useful safety net locally.
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false \
    --filter "@three-peaks/api..."

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# The whole tree, not a hand-picked subset. Every link pnpm writes under
# node_modules is relative and points inside this tree -- including
# apps/api/node_modules/@three-peaks/shared -> ../../../packages/shared -- so
# copying it whole is what keeps them resolvable. The builder only ever received
# apps/api and packages/shared, so nothing of the web app is in here.
COPY --chown=node:node --from=builder /app /app

USER node

# src/ ships beside dist/ because the migrate Job runs the TypeScript directly
# through tsx, and it resolves the migration directory relative to this cwd.
WORKDIR /app/apps/api
# Pinned rather than inherited: the code's default is a development port chosen
# to stay out of the way of other projects on a laptop, and nothing in a
# container needs to dodge anything. The Deployment sets this too; this is what
# keeps the image and the EXPOSE below true on their own.
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.mjs"]
