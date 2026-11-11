# Peable

Peable: a payments platform, a self-custodial payment app, and server/browser
SDKs for integrating payments. Bun monorepo, `packages/` layout.

> Org-wide engineering standards (package manager, TypeScript, React, naming,
> error handling, security, testing, git and PR conventions) live in
> <https://github.com/OxyHQ/engineering>. This file carries only what is true of
> Peable specifically. Versions are in `package.json`, never here.

## Product boundary

Peable accepts FairCoin for payments: sending, receiving and paying for goods or
services. **Peable, Oxy and Oxy ecosystem apps never buy or sell FairCoin or offer
currency exchange/brokerage.** Currency sales belong outside this product, to the
FairCoin organization. Do not reintroduce the inherited Buy FAIR screens, bridge
purchase client or currency-purchase navigation. This is a product boundary
motivated by legal considerations, not a claim that regulatory review is complete.

Mention Plus is the first target for the unified **Pay with Peable** experience:
Subscribe opens a **Bloom detached bottom sheet**. Mention Plus is purchasable
as a standalone subscription; Oxy One also includes Plus and is not the only
purchase route. Bind checkout to the approved standalone offer and its authoritative
price, cadence and payment methods; do not invent those values. Existing One
inclusion must continue to grant Plus without requiring a second purchase.
Payment success and access require the authoritative backend outcome, never a
closed sheet or browser callback.

## Packages

There are **nine**. Four are published to npm (and `cli` will be), so a change Full rules: [`docs/agent-rules/packages.md`](docs/agent-rules/packages.md) (moved verbatim; read before changing this area).

## Contracts are the source of truth (ADR 0014 D5)

Every public route — merchant API, payer routes, user-session routes — is ONE Full rules: [`docs/agent-rules/contracts-are-the-source-of-truth.md`](docs/agent-rules/contracts-are-the-source-of-truth.md) (moved verbatim; read before changing this area).

## Commands

npm releases: merging a version bump to main publishes it (`release-packages.yml`, Oxy's
shared workflow, OIDC, once CI passed on that commit); a package's gates are CI. Never publish
from a laptop — `~/Oxy/docs/npm-releases.md`.

```bash
bun run dev:frontend    # expo start --clear
bun run dev:backend     # bun --watch src/server.ts
bun run build:frontend  # expo export --platform web
bun run dev:orbit       # Orbit, expo start --web on :8082
bun run build:orbit     # Orbit, expo export --platform web
bun run build:backend   # tsc
bun run build:shared-types
```

The named root shortcuts only cover `frontend`, `orbit`, `backend` and `shared-types`.
**`checkout` has no root shortcut and `sdk` only `build:sdk`**: reach them with
`bun run --filter @peable.to/checkout <script>` (`dev` is `vite`, `build` is
`vite build`) and `bun run --filter @peable.to/sdk <script>`, or run the script from
inside the package. The unnamed root scripts (`dev`, `build`, `test`) use
`--filter '*'` and do cover all five.

**Formatting and linting are Biome** (root `biome.json`, Biome pinned in the
root `devDependencies`). `bun run lint` = `biome check .` over every package plus
`expo lint` in `packages/frontend`, whose `eslint.config.js` keeps ONLY the
`eslint-plugin-expo` rules Biome has no equivalent for (`EXPO_PUBLIC_*` reads
Metro would silently fail to inline). `bun run format` / `bun run lint:fix`
write Biome's fixes; CI runs `biome ci --error-on-warnings .`, so a warning
fails the build: the preset reports `noNonNullAssertion`, `noExplicitAny` and
the unused-code rules as warnings, and the count is zero. In tests, write
`must(x)` (`__tests__/helpers/must.ts`), not `x!`. Type errors are `typecheck`
(`tsc --noEmit`) per package, not lint. `docs/audits/` (recorded evidence) and
`packages/backend/src/db/migrations/` (drizzle-kit output, checked by CI's
regenerate-and-diff gate) are excluded from Biome on purpose.

Root `postinstall` builds `contracts`, `shared-types`, `sdk` and `pay` — every workspace package
the wallet bundles: `shared-types` and `pay` directly, `sdk` (and the `contracts` it compiles
against) through `@oxy.so/services`' `@peable.to/sdk/display` — so a fresh `bun install` leaves
each `dist/` present. Metro bundles those `dist/`s, the same output `tsc` checks the wallet
against, so a package missing from that chain fails the Android release bundle (`Unable to
resolve "@peable.to/sdk/…"` when `sdk` was not in it). The wallet has no Tax or Contributions
screen: those are Orbit's (`packages/orbit`). The builds are `incremental: false`, so each install rewrites them whole. Both published packages build cjs + esm + types separately;
`shared-types` also runs `scripts/fix-esm-imports.mjs` after the esm pass.

## PostgreSQL is the only store

There is no `src/models/` and no `src/db.ts` — every route, service and test
reads and writes Postgres through the repositories in `src/db/**`, and nothing
reaches a driver directly.

**`DATABASE_URL` is REQUIRED to boot.** `config.ts` refuses to load without it
and `server.ts` calls `connectPostgres()` — which proves the connection with one
round trip — before anything listens. A task definition missing it crash-loops
with a message naming the variable, instead of serving requests that all 500.

Production uses the existing `oxypay` database on the shared `oxy-postgres` RDS
instance so the OxyPay-to-Peable product rename preserves every merchant and
payment record. The database name is an internal legacy identifier, not a
separate product. **No extensions** (an explicit empty list in
`src/db/migrate.ts`).

- **Every id is two ids, and confusing them is silent.** A public `pi_…` /
  `merch_…` / `link_…` / `cs_…` lives in `public_id` and is what the wire
  contracts call `id`; `id` itself is the internal primary key that other tables
  reference — never the public one. Both ids
  are on shipped contracts (`CheckoutSession.payment_intent` carries the
  `pi_…`, `WebhookDelivery.event_id` / `webhook_endpoint_id` the `evt_…` /
  `we_…`), which is why `listDeliveriesForMerchant` joins the public ids in
  rather than the DTO emitting the internal ones, and why `findIntentById` (by primary key) is a
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
- **New migrations keep their locks short.** `oxypay` lives on the shared
  `oxy-postgres` instance, so CI runs `bun run --cwd packages/backend
  db:check-locks` (`@oxy.so/db`'s `oxy-db-check-migration-locks`): constraints
  on existing tables go in `NOT VALID` and are validated later, and hot-table
  DDL sits alone in its migration. The script's `--after` is the baseline (older
  migrations are not re-judged) and `--hot-tables` names the busy tables.
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
  repositories, so every invariant a repository enforces runs on seeded rows.
  `db/__tests__/schemaGates.realdb.test.ts` turns a missing `TEST_DATABASE_URL`
  into a red build when `CI` is set.

### The reservation is the highest-risk thing in this repo

`db/social/receiveCursor.ts` decides which address a payer sends money to — for Full rules: [`docs/agent-rules/the-reservation-is-the-highest-risk-thing-in-this.md`](docs/agent-rules/the-reservation-is-the-highest-risk-thing-in-this.md) (moved verbatim; read before changing this area).

## Chain access: Explorer HTTP, not RPC

The backend talks to the **FairCoin Explorer HTTP API** (`services/explorer.ts`, Full rules: [`docs/agent-rules/chain-access-explorer-http-not-rpc.md`](docs/agent-rules/chain-access-explorer-http-not-rpc.md) (moved verbatim; read before changing this area).

## Non-custody is enforced in code, not by policy

(ADR 0021 D5).** A merchant's FairCoin goes to the Peable wallet of the Oxy Full rules: [`docs/agent-rules/non-custody-is-enforced-in-code-not-by-policy.md`](docs/agent-rules/non-custody-is-enforced-in-code-not-by-policy.md) (moved verbatim; read before changing this area).

## The wire (ADR 0014)

One Stripe-style wire, changed at the root — there is no legacy shape and no
translation layer. Request bodies, query strings, responses, socket frames and
webhook payloads are `snake_case`; every instant is integer Unix seconds
(`lib/time.ts` `toUnix`); every amount is a base-unit string — Peable Tax
calculations, transactions and the report, and the signed billing documents
(tax quotes and final invoice authorities, `schema_version: 3`) included — and
currencies are uppercase. Arithmetic on an amount is `bigint`, never a float;
a provider's JS-number amount is converted at its boundary, exactly or refused.
Errors are `{error:{type, code?, decline_code?, param?, message, doc_url?, request_id}}`
through `lib/http.ts` `sendError` / `sendValidationError` (`code` is an `ErrorCode`,
`doc_url` its entry on the published errors page); 422 is never used. Request
body schemas are strict: an unknown field is a 400 naming it. Internal
TypeScript, repositories and columns stay camelCase; a jsonb column that stores
a wire object stores the wire shape (migration `0036` converted them).

## Backend surface

Routes (`src/routes/`): `branding`, `charges`, `checkoutSessions`, `connect`,
`connectedAccounts`, `coupons`, `customers`, `dashboard`, `disputes`, `enrich`,
`files`, `merchants`, `money`, `oxyFileEvents`, `events`, `paymentIntents`, `paymentLinks`,
`paymentMethodConfigurations` (configurations and wallet domains),
`paymentMethods`, `prices`, `products`, `promotionCodes`, `providerWebhooks`,
`identity`, `refunds`, `reporting`, `terminal`, `search`, `setupIntents`, `social`, `tax`, `taxCompliance`, `transfers`,
`webhookDeliveries`, `webhookEndpoints`, and the billing engine's
`billingEngine/*` (subscriptions, invoices, credit notes, quotes, test clocks,
settings, meters, entitlements, portal, and its anonymous `public` invoice and
portal pages).

### Search and report runs (Orbit Phase 8)

reader.** `lib/search/parser.ts` parses Stripe's query language; Full rules: [`docs/agent-rules/search-and-report-runs.md`](docs/agent-rules/search-and-report-runs.md) (moved verbatim; read before changing this area).

### The catalog (ADR 0018)

Products, prices, coupons and promotion codes are Orbit rows with no provider
binding. The four resource files list their routes once as data
(`routes/catalog.ts`); `catalogRoutes.ts` mounts that list on `/v1/*` AND on the
dashboard, so the two surfaces cannot drift. Every write goes through
`services/catalog/catalogService.ts`, which commits the row with its event.
**A price never changes what it charges** — only `active`, `nickname`,
`metadata`, `lookup_key` and an `unspecified` `tax_behavior` move; a new amount
is a new price. **Amounts come from `services/catalog/pricing.ts` only** (pure,
bigint, half-up percent discounts, Stripe's graduated/volume tiers): checkout,
invoices and renewals must call it, never re-derive. A coupon id is never
reused (deleted coupons are tombstones), a promotion code is unique among
ACTIVE codes case-insensitively, and there is no `price.deleted` /
`promotion_code.deleted` — those objects are archived, not deleted.

### Checkout Sessions, Payment Links, branding and emails (Orbit Phase 3)

A Checkout Session is an ORDER (`services/checkout/`): priced lines Full rules: [`docs/agent-rules/checkout-sessions-payment-links-branding-and-email.md`](docs/agent-rules/checkout-sessions-payment-links-branding-and-email.md) (moved verbatim; read before changing this area).

### The billing engine (ADR 0018)

Native subscriptions, invoices, credit notes, customer balances, test clocks, Full rules: [`docs/agent-rules/the-billing-engine.md`](docs/agent-rules/the-billing-engine.md) (moved verbatim; read before changing this area).

### The PaymentIntent is Stripe's (ADR 0019)

Seven statuses on both rails — `requires_payment_method`, Full rules: [`docs/agent-rules/the-paymentintent-is-stripe-s.md`](docs/agent-rules/the-paymentintent-is-stripe-s.md) (moved verbatim; read before changing this area).

### Oxy Files (ADR 0043 of the oxy repo)

Peable uses Oxy files two ways, each an `OXY_FILE_ENTITY_TYPES` member: Full rules: [`docs/agent-rules/oxy-files.md`](docs/agent-rules/oxy-files.md) (moved verbatim; read before changing this area).

### The card rail's own invariants

Five, and each one exists because its absence was a defect: Full rules: [`docs/agent-rules/the-card-rail-s-own-invariants.md`](docs/agent-rules/the-card-rail-s-own-invariants.md) (moved verbatim; read before changing this area).

### Orbit money: the merchant's account, fees, ledger, payouts (ADR 0015)

Fiat funds stay at the provider in an account that belongs to the merchant; Full rules: [`docs/agent-rules/orbit-money-the-merchant-s-account-fees-ledger-pay.md`](docs/agent-rules/orbit-money-the-merchant-s-account-fees-ledger-pay.md) (moved verbatim; read before changing this area).

### Events and webhook endpoints (ADR 0014 D4)

`services/events.ts`'s `recordEvent` is the ONE writer of `events` (`evt_…`): Full rules: [`docs/agent-rules/events-and-webhook-endpoints.md`](docs/agent-rules/events-and-webhook-endpoints.md) (moved verbatim; read before changing this area).

## Auth

Backend uses `@oxy.so/core/server`: the one `OxyServer` is `src/oxy.ts`
(`oxy`, with `serviceIdentity: 'when-anonymous'`, `applicationId:
PEABLE_OXY_APPLICATION_ID` and `expectedAudience: PEABLE_SERVICE_AUDIENCE` — the
audience every mount accepts, named at no mount; both constants are
`@peable.to/contracts/vocabulary`'s, the same ones the SDK addresses), and the one end-user auth
middleware is `requireOxyUser` in `lib/http.ts` (in the one error envelope),
which `server.ts` hands every
user-authenticated router (none builds its own). `getRequiredOxyUserId`
to read the caller, `oxy.middleware.service()` / `.requireScope()` for merchant
service tokens (EdDSA plus live authority; canonical own audience, bounded external legacy audience), `oxy.middleware.socket()`
for Socket.IO behind `createOxySocketCors` (the same origins as `createOxyCors`,
on polling and on the WebSocket handshake) — the Oxy socket, and the only one an
identity may connect to; the PAYER socket is a second Socket.IO server on
`PAYER_SOCKET_PATH` (`realtime/socket.ts` `initPayerSocket`) that answers any
origin without credentials, refuses a handshake token and handles only
`subscribe` by client secret, the payer routes' rule (Socket.IO's CORS is per
server, so it cannot be a namespace), plus `createOxyCors` and
`createOxyRateLimit` in `server.ts`. There is no
`requireOxyAuth` call site in this repo. Frontend uses `OxyProvider` and `useOxy`
from `@oxy.so/services` (`app/_layout.tsx`, `src/services/oxy-services.ts`).

The hosted checkout is deliberately **anonymous**: a payer has no Oxy session, so
do not add an Oxy auth requirement to a payer-facing route.

**Payer routes answer any origin, without credentials** (`lib/payerCors.ts`):
every `auth: 'public'` contract plus the four dual-auth reads a payer makes with
a client secret (`PAYER_OPERATIONS`) get `Access-Control-Allow-Origin: *`, an
allow-list without `Authorization`, and no cookies — a merchant's own site runs
Pay with Peable. A request carrying `Authorization` is not a payer's and falls
to the Oxy CORS; every other route keeps it. `payerCors.test.ts` walks every
contract both ways.

### What a signed-in person may do: one module, one map

do**, for every user-authorised surface: Orbit's dashboard, Peable Tax and the Full rules: [`docs/agent-rules/what-a-signed-in-person-may-do-one-module-one-map.md`](docs/agent-rules/what-a-signed-in-person-may-do-one-module-one-map.md) (moved verbatim; read before changing this area).

## The web build is read-only, not unsupported

Only SIGNING is native-only, and the reason is narrow: the identity wallet's Full rules: [`docs/agent-rules/the-web-build-is-read-only-not-unsupported.md`](docs/agent-rules/the-web-build-is-read-only-not-unsupported.md) (moved verbatim; read before changing this area).

## Acting as an organization opens the ORGANIZATION's wallet

The wallet belongs to the account the session acts as (oxy ADR 0001): Full rules: [`docs/agent-rules/acting-as-an-organization-opens-the-organization-s.md`](docs/agent-rules/acting-as-an-organization-opens-the-organization-s.md) (moved verbatim; read before changing this area).

## `packages/frontend` is FAIRWallet, and upstream is alive

This repo's git history IS FAIRWallet's — the first commit is
`e729ce5 Initial release: FAIRWallet SPV wallet for FairCoin`, and the Oxy
monorepo was built on top. The `fairwallet` remote
(`FairCoinOfficial/FAIRWallet`) still receives work, so a fix made only here is
a fix the other side keeps paying for.

**Before fixing anything under `packages/frontend`, ask: does the change mention
Peable, Oxy, the gateway, a merchant or an intent?** If it does not, it is not
ours.

| Change | Where it belongs |
|---|---|
| Protocol primitives — URIs, addresses, transactions, consensus | `@fairco.in/core`, which both already depend on. No fork sync needed |
| Generic FairCoin wallet — SPV, storage, chain UI | FAIRWallet, then `scripts/fairwallet-pick.sh` (below) |
| Oxy identity, gateway, merchants, intents, checkout | Only here |

**Take upstream commits with `scripts/fairwallet-pick.sh <sha>...`, not a bare
`git cherry-pick`.** Upstream is at the repo root in double-quoted Prettier
style, so a plain pick conflicts on nearly every line and loses the rename. The
script Biome-formats the commit's before and after files under
`packages/frontend/`, commits both as throwaway commits on HEAD and picks the
second, leaving only real divergence. It lists and skips files with no
counterpart here (upstream CI, `bun.lock`, deleted screens). On `c094cf3`: 55
conflicts plain, 11 with it, each a Peable edit to the same lines.

## Deploy

Production runs the card rail in LIVE mode only (no test key); ADR 0017's
"Production configuration" lists the variables and provider endpoints.

`.github/workflows/deploy-aws.yml` is the only deployment: native `linux/arm64`
build on an arm64 runner, pushed to ECR `oxy/peable`, rolling the `peable` ECS
service on `oxy-cluster`. AWS SSM SecureString is the sole source of truth for backend credentials.
Deployments never synchronize credentials from GitHub. Peable uses its own
`/oxy/peable/*` references; another app's processor key must never configure it.
Provision and rotate real values in AWS, then review their task-definition
references with the matching provider account and mode.

It and the three Pages deploys (`deploy-frontend.yml`, `deploy-checkout.yml`,
`deploy-orbit.yml` → Pages project `peable-orbit`, orbit.peable.to)
start on `workflow_run` after CI succeeds on a push to main, never beside it.
A `scope` job runs `.github/scripts/deploy-scope.sh`: it holds an older commit
only while a newer main commit has a live or green CI run (a bot push starts
none), and releases only when a path that target ships changed since the last
commit it released (an Actions cache marker; when unsure, it releases).
`workflow_dispatch` redeploys main's head, after a one-shot check that CI passed
for it.
