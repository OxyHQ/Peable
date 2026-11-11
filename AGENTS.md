# Peable

Payments platform, self-custodial FairCoin payment app and the SDKs for integrating payments. Bun monorepo (`packages/`).

## Commands

```bash
bun install                  # postinstall builds contracts, shared-types, sdk, pay
bun run dev:backend          # bun --watch src/server.ts
bun run dev:frontend         # wallet, expo start --clear
bun run dev:orbit            # merchant dashboard, expo start --web on :8082
bun run --filter @peable.to/checkout dev   # checkout has no root shortcut
bun run test                 # every package (backend/frontend/orbit: bun test src)
bun run --filter '*' typecheck
bun run lint                 # Biome + expo lint (frontend, orbit); lint:fix / format write fixes
bun run build:backend        # also build:frontend, build:orbit, build:shared-types, build:sdk, build:pay
bun run --cwd packages/backend db:generate   # writes migration SQL
```

Backend tests need Postgres: `docker compose -f docker-compose.postgres.yml up -d`, then
`TEST_DATABASE_URL=postgres://peable:peable@localhost:5439/postgres` and
`DATABASE_URL=postgres://peable:peable@localhost:5439/peable` (details in [postgres](docs/agent-rules/postgres-only-store.md)).

## Map

- `packages/`: `backend` (Express + Socket.IO), `frontend` (Expo wallet), `orbit` (Expo merchant dashboard), `checkout` (Vite hosted checkout), `contracts`, `shared-types`, `sdk`, `pay`, `cli`. Table with per-package rules: [packages](docs/agent-rules/packages.md).
- Rules per area live in [`docs/agent-rules/`](docs/agent-rules/); read the matching file before changing that area (index below).
- Decisions: `docs/adr/`. Schema decisions (binding): `packages/backend/src/db/schema/CONVENTIONS.md`.

## Conventions that differ from defaults

- Contracts are the source of truth: add or change a public route in `packages/contracts` first, then regenerate (`bun run generate:openapi`, `generate:api-docs`, `generate:sdk-resources`). CI diffs them. [Rules](docs/agent-rules/contracts-are-the-source-of-truth.md)
- The wire is `snake_case`, amounts are base-unit strings handled as `bigint`, instants are Unix seconds. A float amount is a bug. [The wire](docs/agent-rules/the-wire.md)
- Every row has two ids: the public `pi_...` is `public_id`, `id` is the internal key. Use `findIntentByPublicId` for wire ids. Mixing them fails silently. [Postgres](docs/agent-rules/postgres-only-store.md)
- Every generated migration carries one `-- oxy:deploy-phase=pre|post` marker; apply only with `bun run db:migrate`. Locks stay short (`db:check-locks`).
- Payer-facing routes stay anonymous: do not add an Oxy auth requirement to them. [Auth](docs/agent-rules/auth.md)
- In tests use `must(x)`, not `x!`; Biome warnings fail CI (`biome ci --error-on-warnings .`). Lint and format rules: [lint-and-format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md).
- `packages/frontend` is FAIRWallet's history: generic wallet fixes go upstream and are taken with `scripts/fairwallet-pick.sh <sha>`, never a bare cherry-pick. [Upstream](docs/agent-rules/frontend-is-fairwallet.md)

## Boundaries

Never:
- Add buying, selling or exchanging FairCoin, Buy FAIR screens or bridge purchase code (legal product boundary). [Product boundary](docs/agent-rules/product-boundary.md)
- Hold keys or custody funds in the backend; non-custody is enforced in code. [Non-custody](docs/agent-rules/non-custody-is-enforced-in-code-not-by-policy.md)
- Add a FairCoin RPC client; chain access is the Explorer HTTP API. [Chain access](docs/agent-rules/chain-access-explorer-http-not-rpc.md)
- Publish to npm from a laptop; merging a version bump publishes it. [npm releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md)
- Configure Peable with another app's processor key; credentials come from `/oxy/peable/*` in AWS SSM.

Ask first:
- Changes to `contracts`, `shared-types`, `sdk`, `pay` or `cli`: they are external API changes.
- Changes to `db/social/receiveCursor.ts` (highest-risk code). [Reservation](docs/agent-rules/the-reservation-is-the-highest-risk-thing-in-this.md)
- Changes under `.github/workflows/` or the production image inputs: the owner reviews them (CODEOWNERS).

## Testing

- Run the package's `typecheck` and `test` for any change, plus `bun run lint`; CI also runs the generated-file checks (`check:openapi`, `check:api-docs`, `check:sdk-resources`) and `validate:lockfile`.
- Seed backend tests with the `seedX()` helpers, not raw inserts, so repository invariants run.
- Done means CI green on the PR, and any rule you changed is updated in `docs/agent-rules/`.

## PR and commits

- PRs target `main`; merging deploys (see [deploy](docs/agent-rules/deploy.md)). Org-wide git and PR conventions: <https://github.com/OxyHQ/engineering/blob/main/AGENTS.md>.
- Run `bun run validate:lockfile` before pushing a dependency change; CI gates it.

## Secrets

Backend credentials live in AWS SSM SecureString under `/oxy/peable/*`; deploys never sync them from GitHub. Never print or commit `DATABASE_URL` or provider keys.

## Rule index (docs/agent-rules/)

Billing and money: [billing engine](docs/agent-rules/the-billing-engine.md), [catalog](docs/agent-rules/the-catalog.md), [PaymentIntent](docs/agent-rules/the-paymentintent-is-stripe-s.md), [card rail](docs/agent-rules/the-card-rail-s-own-invariants.md), [Orbit money](docs/agent-rules/orbit-money-the-merchant-s-account-fees-ledger-pay.md), [checkout and emails](docs/agent-rules/checkout-sessions-payment-links-branding-and-email.md).
Backend: [surface and routes](docs/agent-rules/backend-surface.md), [events and webhooks](docs/agent-rules/events-and-webhook-endpoints.md), [search and reports](docs/agent-rules/search-and-report-runs.md), [Oxy Files](docs/agent-rules/oxy-files.md), [commands and build](docs/agent-rules/commands-and-build.md).
Wallet and access: [signed-in permissions](docs/agent-rules/what-a-signed-in-person-may-do-one-module-one-map.md), [web is read-only](docs/agent-rules/the-web-build-is-read-only-not-unsupported.md), [organization wallet](docs/agent-rules/acting-as-an-organization-opens-the-organization-s.md).

Owner: OxyHQ (CODEOWNERS). Last reviewed: 2026-11-11.
