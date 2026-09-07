# Peable

Peable: a FairCoin payment gateway with Stripe-shaped ergonomics, plus the
self-custodial wallet that spends on it. Bun monorepo, `packages/` layout.

> Org-wide engineering standards (package manager, TypeScript, React, naming,
> error handling, security, testing, git and PR conventions) live in
> <https://github.com/OxyHQ/engineering>. This file carries only what is true of
> Peable specifically. Versions are in `package.json`, never here.

## Packages

There are **five**, not three. Two of them are published to npm, so a change in
`shared-types` or `sdk` is an external API change, not an internal refactor.

| Path | Name | What it is |
|---|---|---|
| `packages/backend/` | `@peable.to/backend` | Express + Socket.IO gateway API. PostgreSQL-native — see below |
| `packages/frontend/` | `@peable.to/frontend` | Expo / expo-router self-custodial FairCoin wallet, forked from FAIRWallet, with Oxy identity. Also packages as an Electron desktop app |
| `packages/checkout/` | `@peable.to/checkout` | Vite + React + react-router-dom SPA. The **anonymous** payer-facing hosted checkout at checkout.peable.to. Not Expo, not React Native |
| `packages/sdk/` | **`@peable.to/sdk`** | Published client. Server entry mints Oxy service tokens from an `ApplicationCredential` and exposes `paymentIntents` / `paymentLinks` / `checkout.sessions` / `webhooks`; the `@peable.to/sdk/checkout` browser entry is the payer-side core |
| `packages/shared-types/` | `@peable.to/shared-types` | Published wire contract shared by backend, SDK and frontend |

The package directory name and the npm name differ for the SDK: `packages/sdk`
publishes as `@peable.to/sdk`.

`bunfig.toml` sets `linker = "hoisted"`. Expo, Metro and Babel resolve transitive
deps through the standard `node_modules` chain, and the default isolated linker
breaks that plus ECS image resolution. Copy `bunfig.toml` into any Dockerfile
before `bun install`.

## Commands

```bash
bun run dev:frontend    # expo start --clear
bun run dev:backend     # bun --watch src/server.ts
bun run build:frontend  # expo export --platform web
bun run build:backend   # tsc
bun run build:shared-types
```

The named root shortcuts only cover `frontend`, `backend` and `shared-types`.
**`checkout` and `sdk` have no root shortcut**: reach them with
`bun run --filter @peable.to/checkout <script>` (`dev` is `vite`, `build` is
`vite build`) and `bun run --filter @peable.to/sdk <script>`, or run the script from
inside the package. The unnamed root scripts (`dev`, `build`, `test`, `lint`)
use `--filter '*'` and do cover all five.

Root `postinstall` builds `shared-types`, so a fresh `bun install` leaves its
`dist/` present. Both published packages build cjs + esm + types separately;
`shared-types` also runs `scripts/fix-esm-imports.mjs` after the esm pass.

## PostgreSQL is the only store

The port is COMPLETE. There is no Mongoose, no `mongodb-memory-server`, no
`src/models/`, no `src/db.ts` and no `MONGODB_URI` — every route, service and
test reads and writes Postgres through the repositories in `src/db/**`, and
nothing reaches a driver directly.

**`DATABASE_URL` is REQUIRED to boot.** `config.ts` refuses to load without it
and `server.ts` calls `connectPostgres()` — which proves the connection with one
round trip — before anything listens. A task definition missing it crash-loops
with a message naming the variable, instead of serving requests that all 500.
That is also why `deploy-aws.yml` no longer probes the live task definition for
the secret before migrating: the state that probe skipped over is unreachable.

Database `peable` on the shared `oxy-postgres` RDS instance, owned by role
`peable`. **No extensions** — measured, and stated as an explicit empty list in
`src/db/migrate.ts`.

- **Every id is two ids, and confusing them is silent.** A public `pi_…` /
  `merch_…` / `link_…` / `cs_…` lives in `public_id` and is what the wire
  contracts call `id`; `id` itself is the internal primary key that other tables
  reference. The Mongo documents stored the PUBLIC id in their foreign-key
  positions, because `PaymentIntent`'s schema field was itself called `id`, so
  the same expression means different things before and after the port. Both ids
  are on shipped contracts (`CheckoutSession.paymentIntentId` and
  `WebhookDelivery.intentId` carry the `pi_…`), which is why
  `listDeliveriesForMerchant` joins the public id in rather than the DTO
  emitting the internal one, and why `findIntentById` (by primary key) is a
  DIFFERENT function from `findIntentByPublicId`. The socket room is keyed by
  the PUBLIC id — keying `emitIntentUpdate` by the internal one would emit into
  a room nobody is in and lose every realtime update silently.

- **Schema decisions live in `packages/backend/src/db/schema/CONVENTIONS.md`**
  and that file is binding. Read it before touching a table; it records what
  each decision is AND why the obvious alternative is wrong, including three
  CHECK constraints that look obvious and would refuse a legal write.
- **Migrations:** `bun run db:generate` writes the SQL, and every generated file
  needs exactly one `-- oxy:deploy-phase=pre|post` marker — there is no default.
  `bun run db:migrate -- --target-database=<name> --phase=<pre|post|all>` is the
  ONLY thing that applies it; `drizzle-kit migrate` is a devDependency and cannot
  reach the production image. `--phase=all` is for a from-zero genesis, never a
  normal release.
- **The runtime image runs TypeScript source under Bun**, so migrations live
  under `src/db/migrations/` and are copied into the image with everything else
  in `src/`. Do not move them to a package-root `drizzle/` folder without
  changing the Dockerfile.
- **Tests need a real server.** `docker compose -f docker-compose.postgres.yml
  up -d`, then `TEST_DATABASE_URL=postgres://peable:peable@localhost:5439/postgres`
  AND `DATABASE_URL=postgres://peable:peable@localhost:5439/peable`. The second
  is needed because `config.ts` refuses to load without it — including in tests
  that never touch the database — and is NOT what the suites connect to: each
  test FILE gets its own throwaway, fully-migrated database via
  `useGatewayDatabase()` (`src/__tests__/helpers/gatewayTestDatabase.ts`), which
  also points `getDb()` at it so production code works unchanged. Seed state
  with the `seedX()` helpers rather than raw inserts — they go through the real
  repositories, so the non-custody firewall runs on every seeded merchant.
  `db/__tests__/schemaGates.realdb.test.ts` turns a missing `TEST_DATABASE_URL`
  into a red build when `CI` is set.

### The reservation is the highest-risk thing in this repo

`db/merchants/derivationIndex.ts` and `db/social/receiveCursor.ts` decide which
address a payer sends money to. Both are ONE statement — `UPDATE … SET x = x + 1
… RETURNING x - 1`, and for the social cursor an `INSERT … ON CONFLICT DO UPDATE`
that folds the lazy create into the same statement. Never split either into a
read followed by a write: two callers reading the same value derive the same
address, and two payments land where the gateway can tell only one of them apart.

The counters are `integer` on purpose (see `CONVENTIONS.md` §Counters) — a
`bigint` column comes back from postgres.js as a STRING, and `"0" + 1` is `"01"`.
Any change there must keep the two-consecutive-reservation test, because a single
reservation cannot tell a number from a string that prints the same.

## Chain access: Explorer HTTP, not RPC

The backend talks to the **FairCoin Explorer HTTP API** (`services/explorer.ts`,
`EXPLORER_BASE_URL` from `@fairco.in/core`). There is **no** FairCoin RPC client
and no RPC node dependency anywhere in this repo. `@fairco.in/core` is the only
`@fairco.in/*` package any workspace depends on.

`services/settlementWatcher.ts` polls the Explorer for in-flight intents.
Only `broadcast` and `confirming` intents carrying a payer-reported txid are
watchable; terminal and pre-broadcast intents are never polled. Its timer is
`.unref()`-ed so it cannot hold a test run or the event loop open.

## Non-custody is enforced in code, not by policy

A merchant registers a **watch-only account xpub**. `services/derivation.ts`
derives a per-intent receive address from it and **throws
`watch-only violation` if the extended key carries a private key**. That guard is
the legal firewall: if a merchant ever hands over an `xprv`, the gateway refuses
it rather than silently gaining the ability to spend their funds. Never relax it,
and never add a code path that accepts a private extended key.

`services/reserveAddress.ts` claims the next derivation index through
`db/merchants/derivationIndex.ts`, whose `UPDATE … SET x = x + 1 … RETURNING
x - 1` takes the row lock and returns the **pre**-increment value — exactly the
index that call owns, so concurrent callers each get a distinct index with no
read-modify-write race. The `- 1` is load-bearing: dropping it hands out an
index one higher than the one recorded, and the address a payer is shown is not
the address the next reservation avoids. The same statement returns the xpub, so
the key the address derives from is the one the reservation was taken against.

## Backend surface

Routes (`src/routes/`): `checkoutSessions`, `dashboard`, `enrich`, `merchants`,
`paymentIntents`, `paymentLinks`, `social`, `webhookDeliveries`.

Repositories (`src/db/`), the only thing that reaches Postgres — there is no
`src/models/`: `merchants/` (`merchantRepository`, `derivationIndex`),
`payments/` (`paymentIntentRepository`, `paymentLinkRepository`,
`checkoutSessionRepository`), `social/` (`receiveCursor`, `sendAttribution`),
`webhooks/` (`webhookDeliveryRepository`).

## Auth

Backend uses `@oxyhq/core/server`: `createOxyAuthMiddleware` on routes,
`getRequiredOxyUserId` to read the caller, `authSocket()` for Socket.IO, plus
`createOxyCors` and `createOxyRateLimit` in `server.ts`. There is no
`requireOxyAuth` call site in this repo. Frontend uses `OxyProvider` and `useOxy`
from `@oxyhq/services` (`app/_layout.tsx`, `src/services/oxy-services.ts`).

The hosted checkout is deliberately **anonymous**: a payer has no Oxy session, so
do not add an Oxy auth requirement to a payer-facing route.

## Deploy

`.github/workflows/deploy-aws.yml` is the only deployment: native `linux/arm64`
build on an arm64 runner, pushed to ECR `oxy/peable`, rolling the `peable` ECS
service on `oxy-cluster`. GitHub repo secrets are the source of truth and are
synced to SSM by the workflow, which skips empty or placeholder values rather
than overwriting a real one.
