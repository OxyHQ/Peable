# syntax=docker/dockerfile:1.27@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
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
# which the service cannot boot without — and the request-hashing salts
# (IP_HASH_SALT, DEVICE_ID_SALT) from SSM `/oxy/peable/*` (+ `/oxy/_shared/*`); non-secret
# config (PORT, PEABLE_NETWORK, EXPLORER_BASE_URL, PEABLE_ALLOWED_ORIGINS,
# OXY_API_URL) is set as plain task-definition env.
# See .github/workflows/deploy-aws.yml.

# Base images and the syntax frontend are pinned by multi-arch INDEX digest: the
# digest is what the build pulls, and the tag is kept only for readability and
# for `scripts/check-lockfile-sync.mjs`, which compares the tag's Bun version with
# `packageManager`. A bump needs the new tag AND its new digest, and is a change
# to a reviewed build input (`.github/scripts/reviewed-images.json`), so it is
# re-reviewed and re-pinned by the owner.
#
# ── Stage 1: build (install deps, compile shared-types, type-gate the backend) ──
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS builder
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
COPY packages/contracts/package.json packages/contracts/
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
COPY packages/contracts/ packages/contracts/
COPY packages/shared-types/ packages/shared-types/
COPY packages/backend/ packages/backend/
# Backend contract tests typecheck against the built public SDK.
COPY packages/sdk/ packages/sdk/

# Build shared-types (its dist/index.js is what the backend imports at runtime),
# then compile the backend as a type-safety gate. The backend's emitted dist is
# intentionally discarded — the runtime stage runs the TS source under Bun.
RUN cd packages/contracts && bun run build
RUN cd packages/shared-types && bun run build
RUN cd packages/sdk && bun run build
RUN cd packages/backend && bun run build

# ── Stage 2: deps (the backend's production closure, and nothing else) ──
#
# The runtime used to run `bun install --production` at the workspace ROOT, which
# installs every workspace's production dependencies: the frontend's Expo, React
# Native and Electron, the checkout's React, and — through optional peers the
# lockfile resolves for the frontend — typescript. None of it is imported by the
# gateway; all of it shipped (818 MB of node_modules, measured).
#
# This stage installs ONLY `@peable.to/backend`'s production closure:
#   --filter @peable.to/backend  the backend workspace (and its workspace
#                                dependency shared-types), not the other five;
#   --production                 no devDependencies;
#   --omit=peer                  no auto-installed peers. Without it the filter
#                                alone still ships Expo and React Native,
#                                because `@oxy.so/core` and `@oxy.so/protocol`
#                                declare `expo-crypto` / `expo-secure-store` /
#                                `expo-modules-core` as peers and the lockfile
#                                resolves them for the frontend. The server
#                                never loads them: the only import of
#                                `expo-modules-core` is in a `*.native.js` file
#                                that only Metro resolves. Every peer the
#                                server does need (express, postgres) is a
#                                direct backend dependency.
#   --frozen-lockfile            bun.lock is the only source of versions.
#   --ignore-scripts             skips the root `postinstall` (it builds
#                                shared-types, which the builder already did);
#                                no package in this closure has an install,
#                                preinstall or postinstall script, so nothing
#                                else is skipped.
# ci.yml's `image` job asserts expo, react-native and typescript are absent
# from the runtime image and boots it against Postgres.
#
# Every workspace member's manifest is still required: bun reconciles the frozen
# lockfile against the whole workspace before it applies the filter. They come
# from the build context, not the builder, so this stage builds in parallel with
# it and is reused from cache until a manifest or the lockfile changes.
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS deps
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
COPY packages/sdk/package.json packages/sdk/
COPY packages/checkout/package.json packages/checkout/
COPY packages/pay/package.json packages/pay/

RUN bun install --frozen-lockfile --production --ignore-scripts --omit=peer --filter @peable.to/backend
# A hoisted install can still require workspace-local versions (contracts uses
# Zod 4 while the backend uses Zod 3). Preserve those filtered production deps.
RUN mkdir -p packages/backend/node_modules packages/contracts/node_modules packages/shared-types/node_modules

# ── Stage 3: runtime ──────────────────────────────────────────────
#
# Only what `bun packages/backend/src/server.ts` (and the migrator,
# `packages/backend/src/db/migrate.ts`) loads: the deps stage's node_modules, the
# two manifests module resolution reads, shared-types' compiled output and the
# backend's TypeScript source. No install runs here, no other workspace's
# manifest or source is present, and no package manager state (bun.lock,
# bunfig.toml) ships.
#
# Every file is copied WITHOUT --chown, so it is owned by root and the app user
# can read but not write it. The gateway writes nothing to disk; it needs no
# writable path of its own.
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS runtime
WORKDIR /app

# Drop privileges: run as a dedicated non-root user.
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

# The workspace links (`node_modules/@peable.to/{backend,shared-types}`) are
# relative symlinks into packages/, so they resolve once the packages land below.
COPY --from=deps /app/node_modules/ node_modules/
COPY --from=deps /app/packages/backend/node_modules/ packages/backend/node_modules/
COPY --from=deps /app/packages/contracts/node_modules/ packages/contracts/node_modules/
COPY --from=deps /app/packages/shared-types/node_modules/ packages/shared-types/node_modules/

# Compiled shared-types output (imported as dist/index.js) + the backend TS
# source and its tsconfig (run directly under Bun — no compiled entrypoint).
COPY --from=builder /app/packages/contracts/package.json packages/contracts/
COPY --from=builder /app/packages/contracts/dist/ packages/contracts/dist/
COPY --from=builder /app/packages/shared-types/package.json packages/shared-types/
COPY --from=builder /app/packages/shared-types/dist/ packages/shared-types/dist/
COPY --from=builder /app/packages/backend/package.json packages/backend/
COPY --from=builder /app/packages/backend/src/ packages/backend/src/
COPY --from=builder /app/packages/backend/tsconfig.json packages/backend/

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
