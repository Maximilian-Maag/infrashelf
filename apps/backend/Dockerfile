# syntax=docker/dockerfile:1

# ── Stage 1: base ────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
WORKDIR /app

# ── Stage 2: deps ─────────────────────────────────────────────────────────────
FROM base AS deps

# Pinned to the version `packageManager` names in package.json — the authority
# the rest of the toolchain follows. Unpinned takes whatever npm calls `latest`,
# which is not a thing this repository tracks: on 2026-09-19 `latest` became
# pnpm 12 and the linux/arm64 leg of the next release died in this stage with
# exit 1 and no output at all, on the lockfile pnpm 11.9.0 installs from the
# same image without complaint. `scripts/toolchain.test.ts` holds the pins to
# each other.
ARG PNPM_VERSION=11.9.0
RUN npm install -g pnpm@${PNPM_VERSION}

# Copy workspace manifests needed for dependency resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY packages/types/package.json ./packages/types/package.json

RUN pnpm install --frozen-lockfile

# ── Stage 3: builder ──────────────────────────────────────────────────────────
FROM base AS builder
ARG PNPM_VERSION=11.9.0
RUN npm install -g pnpm@${PNPM_VERSION}

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules

COPY . .

RUN pnpm --filter backend build

# ── Stage 4: runner ───────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# standalone output preserves the monorepo layout (apps/backend/server.js), and
# server.js does `process.chdir(__dirname)` on startup — so static assets and the
# drizzle migrations folder (resolved via process.cwd() at runtime) must be copied
# to the same nested path, not to the image root.
COPY --from=builder /app/apps/backend/.next/standalone/. .
COPY --from=builder /app/apps/backend/.next/static ./apps/backend/.next/static
# next build does not fold public/ into the standalone output. /api/docs serves
# Swagger UI from here rather than from a CDN (issue #146), so without this the
# docs page renders as an empty div.
COPY --from=builder /app/apps/backend/public ./apps/backend/public
# Migration files are needed at runtime for the programmatic migrator
COPY --from=builder /app/apps/backend/drizzle ./apps/backend/drizzle

EXPOSE 3001

ENV PORT=3001
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/backend/server.js"]
