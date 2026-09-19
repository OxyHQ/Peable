# syntax=docker/dockerfile:1
#
# Peable Gateway — backend image (@peable.to/backend).
#
# Bun-native: the gateway runs its TypeScript ENTRYPOINT directly under Bun
# (`bun packages/backend/src/server.ts`, matching the package `start` script and
# `main` field) — there is no compiled JS entrypoint. Only `@peable.to/shared-types`
# is compiled, because the backend imports it as its published `dist/index.js`.
#
# Built for AWS Graviton (linux/arm64); the deploy workflow runs on an arm64
# runner so the image is native arm64 (no QEMU emulation). The build context
# MUST be the monorepo ROOT so the workspace packages (shared-types + backend)
# and the hoisted node_modules resolve:
#
#   docker build -f packages/backend/Dockerfile -t peable-backend .
#
# Runtime configuration comes from the environment. ECS injects DATABASE_URL —
# which the service cannot boot without — and the Oxy service secrets
# (OXY_ACCESS_TOKEN_SECRET, IP_HASH_SALT,
# DEVICE_ID_SALT) from SSM `/oxy/peable/*` (+ `/oxy/_shared/*`); non-secret
# config (PORT, PEABLE_NETWORK, EXPLORER_BASE_URL, PEABLE_ALLOWED_ORIGINS,
# OXY_API_URL) is set as plain task-definition env.
# See .github/workflows/deploy-aws.yml.

# ── Stage 1: build (install deps, compile shared-types, type-gate the backend) ──
FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

# Workspace root files. bunfig.toml pins `linker = "hoisted"` (REQUIRED so the
# workspace `@peable.to/shared-types` dependency and the hoisted node_modules
# resolve the same way they do in local dev and at ECS runtime). The root
# tsconfig.json is carried for parity with the monorepo's TypeScript tooling.
COPY package.json bun.lock bunfig.toml tsconfig.json ./

# Every workspace member's package.json must be present for bun's frozen-lockfile
# install to reconcile — even packages this image does not build (frontend). The
# heavy Expo frontend source is excluded via .dockerignore so the context stays
# small; only its manifest is copied.
# EVERY workspace member, including the ones this image neither builds nor
# imports. `@peable.to/pay` was missing here and the install failed with
# `Workspace dependency "@peable.to/pay" not found` — a red deploy in which the
# migration and rollout steps were skipped while the frontend and checkout
# workflows went green, so nothing in the run said the backend had not shipped.
# `db/__tests__/dockerfile.test.ts` re-derives this list from the workspace glob
# and fails the build when a new package is added without a line here.
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
COPY packages/sdk/package.json packages/sdk/
COPY packages/checkout/package.json packages/checkout/
COPY packages/pay/package.json packages/pay/

# Install the full workspace, including dev tooling (typescript, @types/*).
# --ignore-scripts skips the root `postinstall` (build:shared-types): the source
# is not present yet, and shared-types is built explicitly below.
RUN bun install --frozen-lockfile --ignore-scripts

# Copy the source for the packages this image builds/runs.
COPY packages/shared-types/ packages/shared-types/
COPY packages/backend/ packages/backend/

# Build shared-types (its dist/index.js is what the backend imports at runtime),
# then compile the backend as a type-safety gate. The backend's emitted dist is
# intentionally discarded — the runtime stage runs the TS source under Bun.
RUN cd packages/shared-types && bun run build
RUN cd packages/backend && bun run build

# ── Stage 2: runtime ──────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

# Drop privileges: run as a dedicated non-root user.
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

COPY --from=builder /app/package.json /app/bun.lock /app/bunfig.toml ./

# Every workspace member's package.json is required for the frozen-lockfile
# production install to reconcile, even in the runtime image.
COPY --from=builder /app/packages/shared-types/package.json packages/shared-types/
COPY --from=builder /app/packages/backend/package.json packages/backend/
COPY --from=builder /app/packages/frontend/package.json packages/frontend/
COPY --from=builder /app/packages/sdk/package.json packages/sdk/
COPY --from=builder /app/packages/checkout/package.json packages/checkout/
COPY --from=builder /app/packages/pay/package.json packages/pay/

# Compiled shared-types output (imported as dist/index.js) + the backend TS
# source and its tsconfig (run directly under Bun — no compiled entrypoint).
COPY --from=builder /app/packages/shared-types/dist/ packages/shared-types/dist/
COPY --from=builder /app/packages/backend/src/ packages/backend/src/
COPY --from=builder /app/packages/backend/tsconfig.json packages/backend/

# Production dependencies only. --ignore-scripts skips the root postinstall
# (shared-types is already built and copied above as dist/).
RUN bun install --frozen-lockfile --production --ignore-scripts

ENV NODE_ENV=production
USER appuser

# config.ts: PORT (default 3001). ECS maps this container port to the ALB
# target group.
#
# TWO probe routes exist and they answer DIFFERENT questions (`server.ts`):
# `/health` is liveness — the process is up — and `/ready` proves the database
# with one round trip. The ALB target group polls `/health`; a deploy gate
# polls `/ready`, because a task that is listening with no database serves
# nothing. Neither reveals anything and neither is auth-gated.
#
# No Dockerfile HEALTHCHECK: ECS ignores it in favour of the task definition's
# own `healthCheck`/ALB target group, so one here would be a second, silently
# unused copy of the decision. The comment that used to sit here claimed the
# gateway had no route to probe, which stopped being true when `/health` landed
# and was still being read as a reason not to gate a deploy on the artifact.
EXPOSE 3001

CMD ["bun", "packages/backend/src/server.ts"]
