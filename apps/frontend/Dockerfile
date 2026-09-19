# syntax=docker/dockerfile:1

# ── Stage 1: base ────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
WORKDIR /app

# ── Stage 2: deps ─────────────────────────────────────────────────────────────
FROM base AS deps
# Pinned, like the backend image and for the same reason: unpinned takes
# whatever npm calls `latest`, and pnpm 12 broke this stage on linux/arm64
# (exit 1, no output) while pnpm 11.9.0 installs the same lockfile fine.
# `scripts/toolchain.test.ts` holds the pins to each other.
ARG PNPM_VERSION=11.9.0
RUN npm install -g pnpm@${PNPM_VERSION}

# Copy workspace manifests needed for dependency resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY packages/types/package.json ./packages/types/package.json

RUN pnpm install --frozen-lockfile

# ── Stage 3: builder ──────────────────────────────────────────────────────────
FROM base AS builder
ARG PNPM_VERSION=11.9.0
RUN npm install -g pnpm@${PNPM_VERSION}

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/frontend/node_modules ./apps/frontend/node_modules

COPY . .

RUN pnpm --filter frontend build

# ── Stage 4: runner ───────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# standalone output preserves the monorepo layout (apps/frontend/server.js), and
# server.js does `process.chdir(__dirname)` on startup — so static assets must be
# copied to the same nested path, not to the image root.
COPY --from=builder /app/apps/frontend/.next/standalone/. .
COPY --from=builder /app/apps/frontend/.next/static ./apps/frontend/.next/static
# public/ as well, and it is NOT covered by either line above: standalone output
# deliberately excludes it, so everything in it 404s in production while working
# perfectly in development. That is how the service worker shipped dead — /sw.js
# was absent from the image, the worker never registered, and #359 rode on it
# (issue #360).
COPY --from=builder /app/apps/frontend/public ./apps/frontend/public

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/frontend/server.js"]
