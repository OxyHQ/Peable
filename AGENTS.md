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

There are **nine**. Four are published to npm (and `cli` will be), so a change
in `contracts`, `shared-types`, `sdk`, `pay` or `cli` is an external API change,
not an internal refactor.

| Path | Name | What it is |
|---|---|---|
| `packages/backend/` | `@peable.to/backend` | Express + Socket.IO gateway API. PostgreSQL-native — see below |
| `packages/frontend/` | `@peable.to/frontend` | Expo / expo-router self-custodial FairCoin wallet, forked from FAIRWallet, with Oxy identity. Also packages as an Electron desktop app |
| `packages/orbit/` | `@peable.to/orbit` | **Orbit by Peable**, the merchant dashboard at orbit.peable.to. Expo + expo-router + Bloom, web first. A SEPARATE app from the wallet: it signs in with Oxy and calls `/v1/dashboard/applications/:id/*` and the contribution routes as the signed-in USER, never with a merchant credential. See `packages/orbit/README.md` |
| `packages/cli/` | **`@peable.to/cli`** | The `peable` command, to be published (`private` until the owner configures its npm trusted publisher) (ESM bin, `dist/bin.js`): `login` (Oxy application credential per profile and mode, 0600 config), `listen` (test-mode events from `GET /v1/events/stream`, signed with a per-session `whsec_` by the SDK's own `signWebhook`, forwarded to localhost), `trigger` (fixtures over the public API and `/v1/test_helpers/*`), `logs tail`, resource commands. Built on `@peable.to/sdk` and `shared-types`; see `packages/cli/README.md` |
| `packages/checkout/` | `@peable.to/checkout` | Vite + React + react-router-dom SPA. The **anonymous** payer-facing hosted checkout at checkout.peable.to. Not Expo, not React Native |
| `packages/sdk/` | **`@peable.to/sdk`** | Published client. Server entry uses `peableForOxyService({ oxy })` for own workloads; external customers use an `ApplicationCredential` or `tokenProvider`, and exposes `paymentIntents` / `paymentLinks` / `checkout.sessions` / `merchants.branding` / `products` / `prices` / `coupons` / `promotionCodes` / `webhookEndpoints` / `events` / `webhooks`; the `@peable.to/sdk/checkout` browser entry is the payer-side core (sessions, `mountCheckout`, `createPeableElements`, `appearance`); `@peable.to/sdk/checkout/ui`'s `PeableSheetCheckout` is THE in-app payment sheet (Bloom, card + always FairCoin, shipping only when the session collects it) every Oxy app pays with — Mention and Mercaria keep no copy |
| `packages/contracts/` | **`@peable.to/contracts`** | THE wire, declared once (ADR 0014 D5): Zod route contracts for every public route, the object registry, the OpenAPI 3.1 generator (`/openapi`) and the zod-free closed value sets (`/vocabulary`); built first |
| `packages/shared-types/` | **`@peable.to/shared-types`** | The zod-free face of the contract for consumers: wire types re-exported from `contracts` as TYPES, the vocabulary re-exported from `contracts/vocabulary`, and the runtime helpers (state machine, webhook signer, report layouts) |
| `packages/pay/` | **`@peable.to/pay`** | Published client for paying FROM an Oxy app. Holds the money code the wallet used to own — HD derivation, the UTXO set, coin selection — so there is exactly one implementation of "how much money is this", not one per app. `sendPayment` / `quotePayment` / `readBalance` (`src/payment.ts`) are the whole surface: seed in, txid out, no key custody |

`packages/pay` is consumed from its BUILD OUTPUT, like `shared-types`: root
`postinstall` builds both, and `ci.yml` / `deploy-frontend.yml` state
`bun run build:pay` rather than relying on that side effect. The frontend
imports `KeyManager`, `UTXOSet` and coin selection from it — those files live
there now, and a copy in the app would be a second answer to the same
question.

**`@peable.to/pay/ui` is a SEPARATE entry and must never be reachable from the
root barrel.** It is `PeablePaySheet` — the Bloom dialog an Oxy app renders to
pay a person — plus the pure modules under it (`src/ui/machine.ts`, `amount.ts`,
`failure.ts`), and it names React, React Native, `@oxy.so/bloom` and
`react-native-qrcode-svg`, all of them OPTIONAL peers. `tsc` resolves a
re-exported specifier whether or not anything calls it, so one line of
`export * from './ui'` turns four optional peers into hard install requirements
for the backend and every server-side consumer of `sendPayment`.
`src/ui/barrelIsolation.test.ts` walks the real module graph and fails if that
line ever appears. The `./ui` subpath has **no CJS build** and no `require`
condition: the CJS pass must use node10 resolution (`@fairco.in/core` is
ESM-only), which cannot see the Bloom subpath exports `./ui` imports.

The sheet takes a `getSeed` CALLBACK, never a seed. The bytes live in one async
function's local and are zeroed in its `finally`; a seed passed as a prop would
sit in the parent's element tree for as long as the sheet is mounted. Its
ABSENCE — not `Platform.OS` — is what selects the "continue on your phone" state
with the `faircoin:` QR, same capability-over-platform rule as the wallet's own
web build.

**`@peable.to/sdk`'s resource methods are GENERATED from the route contracts**
(ADR 0014 D5): `packages/sdk/src/generated/resources.ts` is written by
`bun run generate:sdk-resources` from every `service` contract with an `sdk` path
(payer and user-session routes never become server-SDK methods), and CI's
`check:sdk-resources` fails when the committed file drifts. Never edit it by hand;
change the contract and regenerate. It imports the contracts as TYPES only — the
SDK never constructs a schema at runtime (`ui-isolation.test.ts` walks the
runtime graph), and `__tests__/generated/types.test.ts` proves every generated
signature equals what the contract's `BodyOf` / `QueryOf` / `ResponseOf` derive. There is no
hand-written resource: the only hand-written behaviour is `webhooks` (local
signature verification) and the `files.create` JSON form's widened signature.

`bunfig.toml` sets `linker = "hoisted"`. Expo, Metro and Babel resolve transitive
deps through the standard `node_modules` chain, and the default isolated linker
breaks that plus ECS image resolution. Copy `bunfig.toml` into any Dockerfile
before `bun install`.

The root `overrides` entry `"@peable.to/sdk": "workspace:*"` points
`@oxy.so/services`' exact `@peable.to/sdk` dependency (it imports
`@peable.to/sdk/display` for display prices) at this workspace. Without it bun
nests the published copy under services, with its own older
`@peable.to/contracts`, and the wallet bundles two SDKs.

## Contracts are the source of truth (ADR 0014 D5)

Every public route — merchant API, payer routes, user-session routes — is ONE
`defineRoute({...})` in `packages/contracts/src/resources/<group>/<resource>.ts`:
method, path, auth, scope, the request schemas (`params`, `query`, `body`, with
their transforms: the SDK sends `z.input`, the handler receives `z.output`) and
the response schema. Dashboard routes (`/v1/dashboard/…`) are Orbit's private
surface and are not contracts.

- **The backend validates with the contract objects** (`import { createCustomerParams } from '@peable.to/contracts'`); a route file
  never declares a public request schema of its own. A dashboard variant is the contract's schema plus
  `environment` (`surfaceQuery` / `dashboardQuery` in `lib/list.ts`).
- **Every route test answer is checked against its contract**: `packages/backend/bunfig.toml`
  preloads `src/__tests__/setup/contractCheck.ts`, which fails the test whose 2xx body does not parse
  with the route's response schema or whose 4xx body is not the error envelope. A violation means the
  contract does not describe the API — fix the contract (or the serializer), never the check.
- **`contractCoverage.test.ts` proves the mounted Express routes and the contracts are the same set.**
  A new route without a contract fails it.
- **Objects are registered once** (`defineObject('<object>', '<Component>', schema)`), with an
  `ObjectMap` entry by declaration merging. An expandable reference is `expandable('<type>')`, an
  always-embedded one `embedded('<type>')`; the wire type is `Expand<z.output<…>>`, which resolves
  references without the schemas referencing each other at the type level. A reference to an
  unregistered type throws.
- **Error codes are a closed list** (`contracts/src/vocabulary/errors.ts`, each with its description):
  `sendError` takes an `ErrorCode` and answers `doc_url`; a scope refusal goes through
  `requireScope` (`lib/http.ts`), never the bare Oxy middleware, whose body no contract describes.
- **`docs/openapi.json` is generated** (`bun run generate:openapi`) and served at `/openapi.json`;
  CI's `check:openapi` fails when it drifts. It is plain JSON outside Biome (2 MiB).
- **`shared-types` never imports the contracts root at runtime** — only `export type` from it and
  values from `@peable.to/contracts/vocabulary`, so the wallet and the hosted checkout do not bundle
  every schema. A closed value set a schema needs lives in `contracts/src/vocabulary/`.
- **The SDK's browser entries import a vocabulary MODULE, never the barrel**
  (`@peable.to/contracts/vocabulary/errors`, not `…/vocabulary`): Metro does not tree-shake, so
  an app pays for every module behind a barrel.
- **No browser or React Native entry reaches a Node-only module** (`node:*` or a bare builtin, or
  `webhookSigner`, anywhere in its graph, third-party dependencies included): `@peable.to/sdk`
  1.0.0's `./checkout/ui` reached `node:crypto` through the `shared-types` barrel and broke
  Mention's Android bundle. `scripts/browser-entries.test.ts` (`bun run test:browser-entries`, CI)
  lists every such entry — `sdk/checkout`, `sdk/checkout/ui`, `sdk/display`, `pay/ui`,
  `shared-types/tax` and `/reporting` — with the vocabulary modules each may reach; a new browser
  entry is a new row there.
- **`sdk`** on a route is its server-SDK method path; every `service` route has one and no other route
  does (`openapi.test.ts`). Renaming it renames a published method.

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

`db/social/receiveCursor.ts` decides which address a payer sends money to — for
EVERY FairCoin payment: an `@username` payment, a merchant's (its owner's
wallet) and a seller's (ADR 0021 D5). There is no other counter: the
per-merchant and per-seller xpub counters are gone with the xpubs. It is ONE
statement, `INSERT … ON CONFLICT DO UPDATE … RETURNING next_derivation_index -
1`, which folds the lazy create into the claim, takes the row lock, and records
the identity key the address derives from. Never split it into a read followed
by a write: two callers reading the same value derive the same address, and two
payments land where the gateway can tell only one of them apart. The `- 1` is
load-bearing: the column holds the NEXT index, so the statement returns exactly
the index that call owns; dropping it hands out an index one past the one
recorded. One account has ONE cursor per network, so merchant, seller and social
payments to it can never collide.

**Every address is bound to its key (ADR 0002, amended).** The PUBLIC key an
address derives from is stored beside it (`payment_intent_outputs.
identity_public_key`, `payment_intents.faircoin_identity_public_key`,
`social_send_attributions.identity_public_key`), and
`services/faircoin/keyBinding.ts` is the one place that compares it with the
recipient's current `#key-1`: a payment nobody reported a txid for under a
replaced key (or on a network the deployment closed) is retired — only once the
Explorer shows its addresses unused, because "no txid" is not "not paid".

**Every address is fresh, and the bound is a rate (ADR 0021 D9, amended
2026-11-06).** A payment's address is reserved in the payment's OWN
transaction by `services/faircoin/addressPool.ts`'s `reservePlannedAddresses`,
an `@username` one with its attribution in ONE transaction by
`reserveSocialSendAddress` (`services/socialReceive.ts`); both go through
`reserveFreshAddress` — the one-statement cursor, skipping an index whose
address history already holds. Addresses are never recycled. A recipient gets
a new payment address only while fewer than 500 of its payment addresses of the
last 24 h are unpaid, and a new `@username` address only while fewer than 500
were handed out fresh in the last 24 h — each counted under a per-recipient
advisory lock (`pg_advisory_xact_lock`, `db/payments/faircoinAddressPool.ts`);
past it, 503 `faircoin_capacity_reached`. Per-payer limits sit in front
(`lib/faircoinPayerLimit.ts` on anonymous FairCoin confirms and invoice pays,
the sender and pair limiters on `@username`). Never hand out an address
outside those functions, and never record it outside the reservation's
transaction: the cursor's row lock is what makes the index the wallet's sync
cursor.

The counters are `integer` on purpose (see `CONVENTIONS.md` §Counters) — a
`bigint` column comes back from postgres.js as a STRING, and `"0" + 1` is `"01"`.
Any change there must keep the two-consecutive-reservation test, because a single
reservation cannot tell a number from a string that prints the same.

There is no ceiling on the tree. The wallet watches EXACTLY the addresses
handed out, synced from `GET /v1/social/me/receive_addresses` (the union of
`payment_intent_outputs` and `social_send_attributions`, every key the account
ever had, paged by `derivation_index`) — the recent and funded ones in its
Bloom filter, the rest read on the Explorer on a doubling schedule
(`packages/frontend/src/wallet/social-receive-watch.ts`). Never reintroduce a
contiguous window or an index limit.

## Chain access: Explorer HTTP, not RPC

The backend talks to the **FairCoin Explorer HTTP API** (`services/explorer.ts`,
`EXPLORER_BASE_URL` from `@fairco.in/core`). There is **no** FairCoin RPC client
and no RPC node dependency anywhere in this repo. `@fairco.in/core` is the only
`@fairco.in/*` package any workspace depends on.

`services/settlementWatcher.ts` polls the Explorer for in-flight intents.
Only FairCoin `processing` intents carrying a payer-reported txid are watchable
(it verifies EVERY output of `faircoinOutputsOf`, ADR 0021 D6)
(`submit_tx` moves `requires_action → processing` with the txid in one write);
`requires_action` and the terminal statuses are never polled. Every Explorer
read is bounded (`AbortSignal.timeout`, one `explorerFetch`); a read that times
out is the Explorer not answering — a throw, `unknown` or `null` list — never a
missing transaction or an unused address. While a paid
transaction confirms it writes the live `confirmations` count (same status, no
event); at the merchant's threshold it is `succeeded`, and a transaction that pays LESS
is `canceled` with `cancellation_reason: 'underpaid'`. Its timer is
`.unref()`-ed so it cannot hold a test run or the event loop open.

**The gateway is not a chain proxy for wallets.** It reads the chain to settle
intents and nothing else. `/api/address/:a` DOES answer (balance, txCount,
utxos, plus `/txs` for paginated history); `addressindex` is on, whatever an
old note says. The surface that needs address
balances is the wallet, and `frontend/src/services/explorer-address.ts` reads
them directly: the Explorer echoes the request Origin in
`access-control-allow-origin`, so a browser reaches it with no proxy.

Take `balanceSat` and not the cumulative `totalReceivedSat` / `totalSentSat`
beside it. Those grow without bound and one live address already reports
6_969_626_939_280_430 — within 1.3x of `Number.MAX_SAFE_INTEGER`, so
`JSON.parse` rounds them before any code can widen them to a bigint. A balance
is bounded by the money supply and has ~14x of headroom.

## Non-custody is enforced in code, not by policy

**FairCoin is received into a Peable wallet, never into a key someone pasted
(ADR 0021 D5).** A merchant's FairCoin goes to the Peable wallet of the Oxy
account that OWNS its application — a person or an organization
(`merchants.owner_account_id`, mirrored from the verified credential's
`ownerAccountId` and the dashboard's application read by
`syncMerchantAuthority`) — and an on-behalf payment to the wallet of the
seller's own account (`connected_accounts.faircoin_oxy_user_id`).
`services/faircoin/recipient.ts` is the ONE place that decides who receives,
on which network (the merchant's environment's) and how the address is
reserved (`planFaircoinAddress`, then `addressPool.ts`'s
`reservePlannedAddresses` in the payment's transaction: the account's DID
`#key-1` PUBLIC key, `deriveSocialReceiveAddress`, a fresh index of the
one-statement cursor).
The payment stores the account it pays (`faircoin_recipient_account_id`).
No column holds a private or extended key — only the PUBLIC identity key
each address derives from — and there is no xpub registration: the private key
lives on the holder's devices only. Mainnet identity addresses are ADR 0002's deployment gate
(`PEABLE_SOCIAL_PAY_NETWORK`).

**A seller still CONFIRMS, in their own Oxy session.** `POST
/v1/connect/onboarding/:token/faircoin` (Oxy USER auth, the user the account
names) is the one writer of `faircoin_registered_at` (`confirmFaircoinHalf`)
and takes no body; it is refused 409 `faircoin_wallet_missing` while that
account has no identity key. Never add a service-authed path that confirms a
seller or names another receiving account: who receives the money is the
seller's consent, and a platform-supplied recipient is indistinguishable from
the platform's own.

**A recipient without a wallet is never refused an order and never silently
card-only.** FairCoin stays offered with `unavailable_reason:
'faircoin_wallet_missing'` (or `faircoin_network_closed`), confirming FairCoin
is a 409 with that code, and Orbit shows the owners a setup task (open Peable
as the owning account, or acting as the organization, and create its wallet).

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
`refunds`, `reporting`, `search`, `setupIntents`, `social`, `tax`, `taxCompliance`, `transfers`,
`webhookDeliveries`, `webhookEndpoints`, and the billing engine's
`billingEngine/*` (subscriptions, invoices, credit notes, quotes, test clocks,
settings, meters, entitlements, portal, and its anonymous `public` invoice and
portal pages).

### Search and report runs (Orbit Phase 8)

**A search is the resource's LIST with a compiled predicate, never a second
reader.** `lib/search/parser.ts` parses Stripe's query language;
`lib/search/compile.ts` turns it into ONE parameterised predicate against the
resource's field registry (`db/search/searchFields.ts` — a field that is not
there does not exist); `lib/search/resources.ts` binds each resource to its
repository's own list function (`search?: SQL`) and serializer. Caller text only
ever enters SQL as a bound parameter (substring is `strpos`, not `LIKE`), and the
merchant predicate is the repository's. `routes/search.ts` is mounted BEFORE the
resource routers on both surfaces — `/v1/charges/search` must not reach
`/v1/charges/:id`. **Adding a resource is one fields map and one registry entry**
(plus `SEARCHABLE_RESOURCES` in shared-types) — `subscriptions` and `invoices`
(billing engine) were added that way; the parser, page token, routes, dashboard
box and SDK need nothing. The `page` token
is bound to its query and carries the keyset position, never the merchant.
No extensions: no `pg_trgm`, no full-text search.

**A report run is leased work.** `POST /v1/reporting/report_runs` writes a
`pending` row; `services/reporting/reportRunWorker.ts` (started in `server.ts`,
`.unref()`-ed) claims it in one statement (`for update skip locked`), builds the
CSV (`services/reporting/reports.ts`, the one place each column is computed),
stores it as a `finance_report_run` File, and completes the run AND records
`reporting.report_run.succeeded` in one transaction gated on its own
`lease_token`. A report file is Peable's output: never uploadable, private at
Oxy, readable only through `GET /v1/files/:id/contents`. The ledger reports read
the same ledger `GET /v1/balance` does (`services/money/ledgerScope.ts`).

**A run and a download are ONE report.** `GET /v1/reporting/report_types/:id/csv`
takes a run's `parameters` as a query and streams the same CSV: both pass
`admitReportRequest` (`routes/reporting.ts`) and both start from `openReport`
(`services/reporting/reports.ts`) — the layout's columns, their one computation, the
one reader per report and the one line renderer (`services/reporting/csv.ts`). A run
writes into memory under the file ceiling (`buildReport`); a download writes batches to
the socket, waiting on `drain` (`streamReport`), so its memory is a batch, not the
interval. Every refusal comes before the header row; a read that fails afterwards
DESTROYS the response (the error handler would `end()` it and a truncated file would
look complete). Never add a second CSV path or a second column list: a new report is a
layout in `REPORT_TYPE_LAYOUTS` (shared-types, browser-safe at
`@peable.to/shared-types/reporting`), its computations and reader here, and — because
`report_runs_report_type_check` is rendered from the ids — a migration. A column is
only ever appended to a version's `columns`; its `default_columns` never change.

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

A Checkout Session is an ORDER (`services/checkout/`): priced lines
(`checkout_session_line_items`, each keeping a snapshot of the price it was
priced with), at most one discount, Peable Tax and the fields to collect. Its
rules, each of which is easy to undo:

- **FairCoin is always offered, and nothing turns it off (ADR 0021).** A fiat
  order's `payment_method_types` is `['card', 'faircoin']` (a FAIR one's
  `['faircoin']`) and the session carries the payee's `network`; a session
  `payment_method_types` without `faircoin` is 400 `payment_method_locked`, and
  `['faircoin']` on a fiat order is a FairCoin-only one (`card_offered = false`:
  the fiat methods are the merchant's to turn off, FairCoin never is).
  The payer chooses at confirm (`payment_method_type`). FairCoin on a FIAT
  order is a FairCoin PaymentIntent for the QUOTED FAIR amount
  (`services/faircoin/quote.ts`, the ONE reader: Explorer FAIR/USD `wfair-base`
  ≤ 120 s, ECB reference rates ≤ 5 days for other fiat, exact bigint ceil, a
  10-minute quote stored on the intent as `faircoin_quote`), linked like any
  payment and compared by `orderAmountOf` (the quote's fiat amount). A stale or
  missing price fails CLOSED for FairCoin only (`price_unavailable`, 503
  `faircoin_price_unavailable`) — never a cached or guessed rate. Choosing the
  other method REPLACES an unpaid payment in one transaction that links the new
  one first and then cancels the old (a card at the provider before it); a
  quoted payment that lapses UNLINKS (the order stays open), never expires the
  session. It is pricing, not exchange: Peable never holds, buys, sells or
  converts FAIR. A fiat session naming a seller pays the seller's key in
  FairCoin; its card payment is the merchant's own charge.

- **The payment exists only once the payer confirms** (`POST
  /v1/checkout_sessions/:id/public/confirm`), created with the amount the
  session computed and the idempotency key `checkout:<cs>:<amount>`, so a
  retried confirm finds the same payment and a re-priced order a new one.
  Nothing about creating a session, or visiting a payment link, mints a payment
  or reserves an address.
- **Completion is the payment's, never a client's.** `recordIntentEvent` calls
  `followIntentForCheckout` (and `applySetupResult` calls
  `followSetupIntentForCheckout`) in the transition's transaction: succeeded →
  `complete`/`paid`; manual-capture authorized → `complete`/`unpaid`; FairCoin
  `processing` → `complete`/`unpaid`, then `async_payment_succeeded|failed`;
  cancelled → open session `expired` (a quoted FairCoin payment: unlinked).
  The rail is the PAYMENT's, never the session's (a fiat order can be a
  FairCoin sale). Hosted/embedded checkout redirect or post
  `complete` only after re-reading the session — never on a provider callback.
- **Totals come from `services/checkout/totals.ts` over `pricing.ts`** — the
  discount is the order's, a percentage rounded per line, an amount off
  allocated in proportion; tax is priced on the discounted line. Tax fails
  CLOSED: `automatic_tax.status: failed` blocks confirm, never zero.
- **A promotion code's redemption is reserved at confirm and counted at
  completion.** The confirm links the payment in ONE transaction under the
  code's (and coupon's) row lock, counting the open sessions already holding
  it; completion increments `times_redeemed` in one guarded `UPDATE`. A
  read-then-write here gives the last redemption to two payers.
- **Every session write is a compare-and-swap** — the payer's edit on
  `updated_at` and "no payment yet", completion and expiry on `status`.
- **Payer routes are anonymous** (`…/public`, `…/public/confirm`, `GET
  /v1/payment_links/:id/public`, `POST /v1/payment_links/:id/checkout_sessions`):
  authorized by the session's `client_secret` in `X-Peable-Client-Secret`,
  never an Oxy session, never a URL. A checkout event is merchant-scoped and carries no
  `payment_intent_id` (`events_intent_event_has_intent_check`).
- **A multi-seller order pays every seller in ONE FairCoin transaction (ADR 0021
  D6).** A line may name its seller (`line_items[].connected_account`, exclusive
  with the session's). FairCoin's quoted total is split by each recipient's
  lines' `amount_subtotal` in `services/faircoin/split.ts` (bigint, largest
  remainder, ties to the earlier recipient) — never re-derive it; one address is
  reserved per output on THAT recipient's cursor; the intent's outputs are
  `payment_intent_outputs`, read through `faircoinOutputsOf` (an older intent is
  its one output). The watcher pays only when EVERY output is paid; one short is
  `canceled` `underpaid`. A seller not ready makes FairCoin unavailable
  (`faircoin_wallet_missing`), never refuses the order; a share at or below dust
  is 409 `faircoin_amount_too_small`. The card payment stays the merchant's
  platform charge (it pays sellers with transfers). There is never a fee output.
- **`payment_intent_data.metadata` is copied to every payment a session creates**
  (each method, each quote; ADR 0021 D8) — a platform matches events by its own id.
- **`mode: 'subscription'`** is validated and refused with 400 `param: mode`
  until the billing engine calls `registerSubscriptionCheckoutFulfiller`.
- **Payment links are over prices**; their lines are fixed once shared and only
  contribution links keep an `amount` (`payment_links_amount_shape_check`). A
  link visit's `Idempotency-Key` is unique per link
  (`checkout_sessions_link_operation_key`).
- **Branding** is a closed set or a validated colour (`merchant_branding`);
  the icon is the avatar and the logo the merchant's `business_logo` File —
  written through `applyMerchantPatch`, never a second copy.
- **Emails are an outbox** (`customer_emails`, enqueued in the change's
  transaction, deduplicated per subject) rendered at send time and handed to
  the INJECTED `Mailer` (`services/email/mailer.ts`); no shared Oxy mail
  client exists, so production registers an adapter over the outbound relay
  (`~/Oxy/docs/outbound-mail-relay.md`). Receipt numbers are claimed by one
  upsert (`claimReceiptNumber`), the receive cursor's pattern.

### The billing engine (ADR 0018)

Native subscriptions, invoices, credit notes, customer balances, test clocks,
dunning settings, meters, entitlements and the customer portal
(`services/billingEngine/*`, routes in `routes/billingEngine/*`, mounted on the
API and the dashboard from one list). It is Orbit's only recurring billing:
the Stripe-Billing proxy (`/v1/billing/*` beyond meters, `services/billing/*`,
the FX-quoted FairCoin rail, signed tax quotes and invoice authorities) was
retired at the root with nothing to migrate (ADR 0018 "as built"); never
rebuild a provider-billed subscription beside it. Invariants:

- **Every status change is `transitionSubscription` / `transitionInvoice`**
  (`transitions.ts`): state machine, CAS on the status read, event and
  entitlement refresh in the caller's transaction. Never write `status` any
  other way.
- **An invoice moves WITH its payment**: `transitionIntent` calls
  `onInvoicePaymentTransition` in the intent's transaction. Link a card intent
  to its invoice BEFORE confirming it (`collect.ts`), or the hook misses it.
- **Tax is computed before finalize and fails closed** (`invoiceTax.ts`); a
  subscription's first invoice is priced and taxed before any row is written.
  Never finalize at zero because a calculation failed.
- **Never `new Date()` in the engine**: `engineNow(db, testClockId)` is the
  customer's clock (a test clock's frozen time in test mode).
- **FairCoin is never debited**: FAIR subscriptions and invoices are
  `send_invoice` (CHECKed) and paid by the payer on the hosted invoice page.
  Every fiat invoice offers FairCoin too (`payerIntentForInvoice(invoice,
  method)`, quoted; `amount_paid` is the quote's fiat amount), and a fiat
  subscription whose FIRST invoice was paid in FairCoin becomes `send_invoice`
  (`invoiceFaircoinSubscription`) — the payer pays each period.
- **Entitlements are the access answer**: features attached to products,
  active while a granting product is on a `trialing`/`active`/`past_due`
  subscription — Mention Plus through Plus OR Oxy One is one entitlement.
- Amounts only from `services/catalog/pricing.ts` + `invoiceMath.ts`; proration
  from `periods.ts`. Mail only through Orbit's email outbox (`services/email`,
  owed in the change's transaction; `invoice.sent` only once the relay took it).
  Checkout's `mode: 'subscription'` is the engine's (`checkoutFulfiller.ts`).
- **Quotes (`qt_…`) are the engine's too** (`services/billingEngine/quotes.ts`):
  `transitionQuote` is their one status writer (CAS + `quote.*` event); only a
  draft is edited; a line is `itemPeriodAmount`, the discount `discountsFor`,
  and finalize taxes them with `prepareInvoice` — failing closed, the quote
  stays a draft. Accepting LOCKS the quote first and moves it to `accepted` in
  the transaction that creates its invoice (one-time lines, `quote_accept`) or
  its subscription (`createSubscription`'s internal `inTransaction` hook; the
  one-time lines ride the first invoice as `addInvoiceItems`), so a second
  accept writes nothing. The discount is validated on the draft and redeemed
  only at acceptance; open quotes expire in the scheduler's pass on the
  customer's clock; numbers are one upsert (`claimQuoteNumber`).

### The PaymentIntent is Stripe's (ADR 0019)

Seven statuses on both rails — `requires_payment_method`,
`requires_confirmation`, `requires_action`, `processing`, `requires_capture`,
`canceled`, `succeeded` — one transition table in
`shared-types/src/paymentIntent.ts`, `succeeded`/`canceled` terminal (a chain
reorg's `succeeded → processing` is the one exception, in `applyEvent`).

- **The rail decides the path, and `applyEvent(status, event, rail)` takes it.**
  FairCoin: `requires_action` (`next_action.faircoin_payment`) → `processing` →
  `succeeded`/`canceled`. Card: all seven. `requires_action` and `processing`
  are SHARED, so a card event must never move a chain payment because the
  statuses match — the rail argument refuses it, `LEGAL_SOURCES` bounds each
  event's sources, and `CARD_ONLY_STATUSES` is a CHECK.
- **A declined card attempt is `requires_payment_method` + `last_payment_error`**
  (Peable's own message, chosen from the code — never the provider's prose), and
  stays payable; `payment_intent.payment_failed` is recorded even when the
  status does not move. A FairCoin underpayment is terminal (`canceled`,
  `underpaid`): Peable never holds those coins.
- **Cancellation is one status with a reason** (`cancellation_reason`,
  `canceled_at`, CHECKed together): expiry is `abandoned`, the merchant's
  `POST …/cancel` names one, the provider's is `automatic`. There is no
  `/reject`.
- **Refunds are not statuses.** `amount_refunded` is the sum of SUCCEEDED refund
  rows, read in the same statement and never stored; `amount_received` is
  written with the transition to `succeeded` (a partial capture receives less;
  leaving `succeeded` resets it) and is what refunds draw on. Refund events are
  `refund.*` and `charge.refunded`.
- **A card authorization that succeeded is ONE `ch_…`**, written by
  `transitionIntent` in the transaction that reaches `requires_capture` or
  `succeeded` (`ensureChargeForIntent`); its outcome/card snapshot is read from
  the provider after the commit. Failed attempts are not charges. The provider
  charge id stays the `provider_charge_id` binding.
- **Customers, payment methods and SetupIntents are Orbit's rows**
  (`cus_`/`pm_`/`seti_`, ADR 0016); the provider customer is a lazy per-mode
  binding (`customer_provider_bindings`), never serialized. Card numbers never
  reach Peable — the provider's Elements collect them.
- **Every id on the wire is public** — `merchant_id` is the `merch_…`; the chain
  side lives in `faircoin`; the card's confirmation credential is never on the
  intent (`next_action: use_peable_sdk` → `POST …/client_action`).

**Every merchant `POST` mounts `idempotent` (`lib/idempotency.ts`, ADR 0014 D3)
after its auth and scope middleware**, or is named with its reason in
`routes/__tests__/idempotencyCoverage.test.ts`, which walks the gateway. It is
a 24-hour request-replay layer IN FRONT of business idempotency (the intent's
unique key, `external_ref`), never a replacement for it — so never accept the
header as a business identity: the SDK mints a fresh one per call.

**Peable Tax (ADR 0011) decides whether a sale is taxed; a provider only says
how much.** `services/tax/` owns it for every rail. A covered sale the provider
cannot price fails closed, never zero; an uncovered one is zero and recorded as
`not_registered`. Only the owner's dashboard approval activates registrations,
and only official Oxy applications calculate on the platform's Stripe Tax
account. Location evidence never includes language, currency or timezone.
Refunds are reversals netted into the same report rows, never deletions of the
original transaction.

**Business compliance (ADR 0020) records and assesses; it never activates.**
`services/tax/compliance/*` holds onboarding facts, declared registration
statuses (always `unverified`), `tax_document` Files, the versioned rule set,
assessments, the review queue, deadlines and the action history. It writes no
`tax_settings` or `tax_registrations`, calls no provider, and nothing it stores
is read by the calculator — so no declaration, decision, service credential or
assistant can make Peable collect. Onboarding writes and review decisions are
Orbit-only (`billing:manage`); the merchant API reads and assesses. The rule
set is CODE, one immutable version per change (`ruleSet.ts`), with sources and
effective dates; an assessment stores its version and inputs and must replay
byte-for-byte. Everything outside the supported rules is `unsupported` —
report it, open a review item, infer nothing. Registration submission,
returns and remittance are `not_available` capabilities, never simulated
states. Never infer liability from an incorporation address, a company number,
a language or a currency, and keep company identifiers out of fixtures, logs
and issues.

### Oxy Files (ADR 0043 of the oxy repo)

Peable uses Oxy files two ways, each an `OXY_FILE_ENTITY_TYPES` member:
`merchant_avatar` (the merchant's square identity image, an Oxy file THEY own,
`merchants.avatar_file_id`) and `file` (an Orbit File, `file_…`, `files` — bytes
Peable stored for a merchant, or a merchant-owned Oxy logo imported as one).
Every live `files` row holds its own reference; whatever USES a File (dispute
evidence, the merchant's `business_logo`) uses the row, never the Oxy file. Rules:

- **Ownership is checked at ONE place**, `services/oxyFiles/fileOwnership.ts`
  (`acceptOxyFile`), reached from `registerMerchant` / `applyMerchantPatch`
  (avatar) and `POST /v1/files` with `oxy_file` (an imported logo) — service AND
  dashboard routes. The file must be active and owned by the merchant's
  application, its owner account, the dashboard user or the user a delegated
  token acts as, and Oxy must accept Peable's reference. It FAILS CLOSED (503)
  when Oxy cannot be asked or hides the owner — Oxy reveals owners to verified
  first-party workload authority. Application branding or tier is
  insufficient. An UPLOAD needs no check: Peable stores the bytes as its own
  application file (`storeAppFile`, the reference registered in the same Oxy
  call), private — or public for a `business_logo`.
- **Every use writes its reference sync in the same transaction**
  (`enqueueReferenceSync`, called only from `db/merchants/merchantRepository.ts`
  and `db/files/fileRepository.ts`); `services/oxyFiles/referenceSync.ts` makes
  Oxy agree, and the daily reconciliation (`OXY_FILE_RECONCILIATION_MODE`, `bun
  run oxy-files:reconcile`) repairs the rest, one run per entity type. A new
  kind of file use is a new `OXY_FILE_ENTITY_TYPES` member, and the exhaustive
  switches (`isReferenceWanted`, `inventoryFor`, `fileEvents.ts`) will not
  compile without its rules.
- **`/v1/webhooks/oxy/files` is mounted before `express.json()` and the rate
  limiter**, like the Stripe webhooks: the signature covers the raw bytes.
  Deleted/blocked/lost clears the avatar (audited in `merchant_avatar_audit`)
  and REMOVES every File over the Oxy file (`files.removed_at`/`removed_by` —
  the row stays, so evidence and the logo can say why they stopped working);
  trashed/private withholds both until the owner brings them back.

**Files (`POST /v1/files`, `GET /v1/files[/:id]`).** `routes/files.ts` reads the
`multipart/form-data` body itself, bounded by the largest purpose, recognises
the TYPE from the bytes (never the client's `Content-Type`) and checks it
against `FILE_PURPOSE_POLICIES` (shared-types). It sets `req.body` to the
request's identity — purpose, name, size, sha256 — so the generic idempotency
layer hashes the file without the bytes ever entering a stored hash, a log or
an error. Never log or echo file bytes. Only a `business_logo` has a `url`;
evidence and identity documents leave Peable only to the provider they are
submitted to (`readFileBytes` → `linkedDownloadUrls`).

**The logo sits BESIDE the avatar, and they are not the same thing.** The
avatar is the square identity image (Stripe's branding `icon`), an Oxy file the
merchant owns and the one the Oxy ecosystem renders; `business_logo` is the
wide wordmark payer surfaces put in their header (Stripe's branding `logo`), a
File of purpose `business_logo`, set with `POST /v1/merchants/me` (a File needs a
merchant, so never at registration) and served as `MerchantDisplay.logo_url`
only while the File is `available`.

Peable's own Files calls use its live workload binding through the shared
`OxyServer`; no application scopes or client key pair configure that authority.
Merchant/file ownership and reference visibility checks still apply. See
[`docs/first-party-authority.md`](docs/first-party-authority.md).

Repositories (`src/db/`), the only thing that reaches Postgres — there is no
`src/models/`: `merchants/` (`merchantRepository`),
`payments/` (`paymentIntentRepository`, `chargeRepository`,
`paymentLinkRepository`, `checkoutSessionRepository`), `customers/`
(`customerRepository`, `paymentMethodRepository`, `setupIntentRepository`),
`catalog/` (`productRepository`, `priceRepository`, `couponRepository`,
`promotionCodeRepository`), `social/` (`receiveCursor`, `sendAttribution`),
`events/` (`eventRepository`), `webhooks/` (`webhookEndpointRepository`,
`webhookDeliveryRepository`, `webhookOutboxRepository`),
`providers/` (`providerEventRepository`), `accounts/`
(`connectedAccountRepository`,
`accountLinkRepository`), `transfers/` (`transferRepository`,
`transferReversalRepository`), `refunds/` (`refundRepository`), `disputes/`
(`disputeRepository`), `files/` (`fileRepository`), `paymentMethods/`
(`paymentMethodConfigurationRepository`: configurations, their provider
bindings, wallet domains), `money/` (`ledgerRepository`, `payoutRepository`,
`applicationFeeRepository`, `feeScheduleRepository`, `reconciliationRepository`),
`reporting/` (`reportRunRepository`, `reportData`), `search/` (`searchFields`).

**Payment method breadth is a card-rail intersection, decided once per
payment.** `services/paymentMethods/configuration.ts`: a merchant's
configurations (`pmc_…`, one default created on first need) hold only their
explicit choices; a method is offered when it is on (or Orbit's default is),
the provider processes it at all (`PROVIDER_PAYMENT_METHODS`), a wallet's card
is on, and the payment's currency is one it takes (`PAYMENT_METHOD_CURRENCIES`).
What cannot be offered says why (`unavailable_reason`) and a toggle that could
never take effect is refused — never a silent no-op. A PaymentIntent stores
the types it offers at creation (`payment_intents.payment_method_types`) and,
unless the merchant named types, its configuration, whose provider binding is
pushed again before use whenever the row's `version` moved — the provider never
offers a method the merchant turned off. Every method Orbit does not model
(the provider's own consumer wallet, BNPL, …) is switched OFF explicitly on
every push. Wallet domains (`pmd_…`) are registered at the provider first and
the row records its answer; Peable's, Oxy's and Kaana's own hosts are refused.
**FairCoin is a LOCKED entry of every configuration (ADR 0021 D2)**: always
`on`, `locked: true`, `available` only once the merchant has a FairCoin key
(`faircoin_account_missing` before); `off` is a 400 `payment_method_locked` and
nothing is ever stored for it. It is the chain rail, so it is never pushed to
the provider and never one of a card PaymentIntent's `payment_method_types`.

**A refund and a dispute run in OPPOSITE directions, and the difference is the
whole handler.** A refund is merchant-initiated: Peable writes the row, then
calls the provider, so an event naming a refund row we do not have is
`unmatched` and retried. A dispute is network-initiated: the first thing that
exists is the event, so "no row" is the NORMAL first state and
`handleDisputeEvent` CREATES one. Its idempotency is therefore not a merchant
`external_ref` but `unique(provider, provider_object_id)` — the only identity a
redelivered creation carries. Its two events carry a **`Dispute`** under
`data.object`, not the intent: `WebhookEventPayload` in `shared-types/event.ts`
is the total map of event type to resource, and `recordEvent` is generic over it,
so a new event type cannot ship the wrong payload.

### The card rail's own invariants

Five, and each one exists because its absence was a defect:

- **A card payment is TWO things** — a row here, and a PaymentIntent at the
  acquirer that stays confirmable. Ending it locally (`POST …/cancel`, the expiry
  sweeper) without cancelling there leaves a payment the payer can still
  complete against a terminal status. `services/cardCancellation.ts` cancels and
  then reports what is TRUE, because the cancellation can lose; the sweeper
  handles the card rail one row at a time for that reason, and the chain rail
  keeps the fast set-based claim.
- **A payment and its CHARGE are different objects.** A transfer's
  `source_transaction` names the charge (`payment_intents.provider_charge_id`);
  handing it the `pi_…` makes Stripe answer `No such charge`, which reads as an
  outage.
- **An amount is not an identity.** `transfer_reversals` exists so two reversals
  of one settlement for the same amount are two operations. The cumulative total
  on `transfers.amount_reversed` is still the PROVIDER's figure and is never a
  sum of those rows.
- **A refund's `state` is read, always.** `pending` and `failed` are ordinary
  answers, and a bank can reject a refund days later (`refund.failed`): the row
  moves `succeeded → failed` and `amount_refunded`, being their sum, drops with
  it — no payment transition is needed, because a refund was never one.
- **A declined attempt is not terminal on the card rail.** It returns the
  payment to `requires_payment_method` with `last_payment_error`, confirmable
  again; an `underpaid` chain payment is `canceled`, and the rail argument of
  `applyEvent` plus `LEGAL_SOURCES` keep the two apart.

### Orbit money: the merchant's account, fees, ledger, payouts (ADR 0015)

Fiat funds stay at the provider in an account that belongs to the merchant;
Orbit instructs and MIRRORS. There is no Peable-held balance and no table that
could represent one — a design that adds one supersedes ADR 0015 first.

- **The merchant's own account is a `connected_accounts` row with
  `role = 'merchant'`** (one per merchant, card half only, no `external_ref`),
  opened by `services/accounts/merchantAccount.ts` through the same seller
  machinery with `dashboard: 'none'`. Every SELLER read filters on the role
  (`IS_SELLER` in the repository); `toConnectedAccountDTO` throws on a merchant
  row rather than serialize it as a seller. `/v1/merchants/me` is the
  registration and stays separate.
- **The charge is decided once, at create, and replayed from the row**
  (`services/money/chargeRouting.ts`, `providerRoutingFor`): first-party →
  platform charge, no fee; own onboarded account → destination charge
  `on_behalf_of` it with the fee schedule's fee; own account still onboarding →
  409, never a silent platform charge; no own account → platform charge.
  First-party is `merchants.first_party`, mirrored from the credential's
  VERIFIED `authority: 'first_party'` by `resolveMerchant` — never branding or
  tier.
- **The live gate is `config.orbit.thirdPartyLivePayments`**
  (`ORBIT_THIRD_PARTY_LIVE_PAYMENTS`, default false): `assertLiveMoneyAllowed`
  sits at opening an account, a destination charge and a payout. Do not add a
  live money path for a non-first-party merchant without it.
- **The ledger is never invented.** `balance_transactions` hold the provider's
  own figures verbatim, keyed by the provider id (`ingestion_key`); a
  re-ingested transaction whose figures differ is a reconciliation mismatch,
  not an update. `postJournal` is the ONE writer of `ledger_entries` and refuses
  a journal that does not sum to zero. A balance is read from the entries,
  never stored. A merchant without an account has no balance (404
  `account_missing`), never zeros.
- **Reconciliation records, it does not correct** (`services/money/reconciliation.ts`):
  compare first, record mismatches, then the ordinary ingestion; the next run
  resolves what it no longer sees.
- **FairCoin is informational** — `recordFaircoinLedger` in `transitionIntent`'s
  transaction, reversed by a reorg; never payable. A quoted payment's entry
  carries its `faircoin_quote` (the fiat equivalent, ADR 0021 D7).
- **`Peable-Account`** is accepted only on the routes in
  `PEABLE_ACCOUNT_ROUTES` (`routes/money.ts`) and refused elsewhere by
  `refuseMisplacedPeableAccount`.
- **Connect's cores are shared with Orbit.** `routes/connectedAccounts.ts` and
  `routes/transfers.ts` export `(req, res, merchant[, surface])` cores that the
  dashboard mounts behind its membership gate (`…/connected_accounts`,
  `…/transfers`, `…/transfers/:id/reversals`), writes under `runIdempotent`. A
  seller read is always `IS_SELLER`; there is still no dashboard (or service)
  path that sets a seller's FairCoin key (ADR 0012).

**A dispute response is one shot, and none of its words are stored — the
provider is the store of a draft.** `POST /v1/disputes/:id` (Stripe's) STAGES
evidence with `submit: false`: the TEXT goes to the provider's own draft
(`disputes.update`), and Peable records only the provider's answer that
evidence exists (`disputes.has_evidence`, a boolean) — a merchant reading the
dispute back gets the text LIVE from the provider (`readDisputeEvidence`), and
only `GET /v1/disputes/:id` and the answers of the two writes carry `evidence`;
lists and EVENTS never do (an event is stored, and `recordDisputeEvent` strips
it). FILE fields name the merchant's own `file_…` of purpose
`dispute_evidence` (`dispute_evidence_files`, ids only — the composite keys
make "this merchant's" and the purpose structural); their bytes go to the
provider at SUBMISSION and only then, each under
`dpfile:<dp>:<field>:<file>`, and the provider's file ids are used once and
not kept. `submit: true` submits once under `dpev:<dp>`: a second submission,
or a draft after one, is refused (409 `dispute_already_submitted`) by reading
`disputes.evidence_submitted_at` — a CLAIM, guarded on it still being null —
and never by asking the provider. `POST …/close` accepts the dispute (`lost`)
by a CAS on `needs_response`, and the provider's later `charge.dispute.closed`
is not told twice. `reason` is Stripe's enum on the wire (unknown →
`general`); the row keeps the provider's word.

**A settlement figure is `null` with a status, never `0`.**
`services/settlementReport.ts` reads gross/fee/net live from the provider and
answers `unknown` for every reason a figure can be missing. It reports what the
provider took and attributes that cost to nobody — which entity bears it is a
commercial decision that is still open, and no code here makes it. Three reads
answer the ONE `settlement` object, each one movement of the settlement balance:
a payment's (`GET /v1/payment_intents/{intentId}/settlement`, its charge), a
refund's (`GET /v1/refunds/{id}/settlement`, `refunds.refundSettlement`; failed
or canceled is `unknown`) and a dispute's withdrawal (`GET
/v1/disputes/{disputeId}/settlement`, `disputes.settlement`; an inquiry is
`unknown`), with `refund` / `dispute` naming whose it is. Signs, for all three:
`gross` the magnitude, `fee` as the provider signs it (positive charged,
negative returned), `net` the signed balance effect — `gross − fee` for a
payment, `−gross − fee` for a refund or dispute — in the SETTLEMENT currency
(ADR 0015 "as built"). Every read goes through the one never-throwing
`readSettlement` in the row's own mode, over `SettlementReportingProvider`.

### Events and webhook endpoints (ADR 0014 D4)

**An event is stored once and a delivery is that event sent to one endpoint.**
`services/events.ts`'s `recordEvent` is the ONE writer of `events` (`evt_…`):
it inserts the snapshot — `data.object` as the API renders it now, the
`api_version` it was rendered under, `previous_attributes`, and `request`
(`Request-Id` + `Idempotency-Key` from `lib/requestContext.ts`, opened by the
`idempotent` layer and the dashboard's writes; `null` for a background change)
— and, in the SAME transaction, one `webhook_deliveries` row per ENABLED
`webhook_endpoints` row of the merchant whose `enabled_events` holds the type
or `*`. Every producer goes through it: `recordIntentEvent` /
`recordIntentCreated` / `recordRefundEvent` / `recordChargeEvent` /
`recordDisputeEvent` / `recordConnectedAccountEvent` /
`recordCustomerObjectEvent` in `intentTransition.ts`,
the billing-observation relay, the test event. A producer that wrote a delivery
directly would be an event `/v1/events` never shows. An event exists whether or
not any endpoint wants it.

- **The body is rendered from the stored event at attempt time**
  (`toEventDTO`), never stored on the delivery and never rebuilt from the
  resource as it is now. A redelivery is a new delivery of the same event.
- **The endpoint secret is Peable's (`whsec_…`, `services/webhookEndpoints.ts`),
  shown only by the create and `roll_secret` responses**, and a protected
  column (`db/protectedColumns.ts`): only `findEndpointSigningTarget` reads it.
  A roll with `expires_in_seconds` (≤ 24h) keeps the previous secret signing
  beside the new one — two `v1=` per delivery — until then.
- **One URL rule, judged at create, update AND before every delivery**
  (`webhookUrlProblem`: https, http only in test mode, ports 80/443, no
  credentials, no blocked host or private IP literal). The outbox judges the
  STORED url: one that fails is never sent to and its endpoint is disabled
  `url_refused` (migration 0040 copied `merchants.webhook_url` without the
  rule); re-enabling judges the url it would be sent to. Never write
  `webhook_endpoints.url` on a path that skips it.
- **One lane decision, `webhookDeliveryLane`** (`services/webhookDispatcher.ts`):
  a VERIFIED first-party merchant's (`merchants.first_party`) endpoint on Oxy's
  own API — `oxy.isFirstPartyServiceUrl`, the SDK's answer, never a hostname
  list here — goes through `OxyServer`'s
  `createServiceClient({ baseURL: oxy.baseURL, audience: 'oxy-api' }).fetch`
  (inside the VPC `api.oxy.so` is a private address `safeFetch` refuses);
  every other URL through `safeFetch`, which resolves and checks DNS on every
  attempt. That lane carries Peable's bearer, so a third-party merchant's
  `api.oxy.so` URL stays on `safeFetch`. Same bytes, signature, deadline and
  classification on both lanes.
- **Retries span ~3 days** (`WEBHOOK_RETRY_SCHEDULE_MS`, ±20% jitter);
  `recordEndpointAttempt` folds every attempt into the endpoint's
  `failing_since` run in ONE statement and disables it with
  `disabled_reason = 'delivery_failures'` once the run is three days old. A
  claimed delivery whose endpoint is disabled ends `failed` without an attempt.
- **Retention is 30 days** (`services/eventSweeper.ts`); every read filters on
  the same horizon. Deleting an event or an endpoint cascades to its deliveries.
- **The catalog is `WEBHOOK_EVENT_SCOPES`** (`schema/valueSets.ts`) — Stripe's
  names since ADR 0019: `payment_intent.created|requires_action|processing|
  amount_capturable_updated|succeeded|payment_failed|canceled`,
  `charge.refunded`, `charge.dispute.created|updated|closed`,
  `refund.created|updated|failed`, `customer.*`, `payment_method.*`,
  `setup_intent.*`. The intent events derive from where the row landed
  (`intentEventsFor`); a same-status write records nothing but a failed
  attempt. A new type
  is one entry there plus `WebhookEventPayload`, and a migration for the
  `events_type_check` / `webhook_endpoints_enabled_events_check` it widens.
  `webhook_endpoint.test` is TARGETED (`TARGETED_WEBHOOK_EVENT_TYPES`): sent to
  the one endpoint it names, never subscribable.
- `merchants.webhook_url` / `webhook_secret` no longer exist; nothing routes an
  event through the merchant row.

An account acts through the provider on its OWN row, never
`resolveCardProvider()` — that is only for opening a new one.

**Stripe stays behind the provider interface.** Its SDK and adapter live under
`services/providers/stripe/`; the rest of the gateway talks to
`services/providers/provider.ts` through `registry.ts`, and
`providers/__tests__/providerBoundary.test.ts` fails on a Stripe import anywhere
else outside its named exceptions. A new provider capability is a method on the
interface, implemented there. There is no multi-provider routing until a second
provider is contracted (a business decision), and no abstraction built for one.

**Test and live live in ONE deployment, and the credential selects the key
(ADR 0017).** `STRIPE_SECRET_KEY_TEST` and `STRIPE_SECRET_KEY_LIVE` (each with
its own publishable key and platform/connect endpoint secrets, all `_TEST`/`_LIVE`)
are each optional; there is no `STRIPE_SECRET_KEY` and no fallback to one, and
the gateway refuses to BOOT on a key whose prefix contradicts its variable's
mode. The registry is keyed by `(provider, mode)`, and
`services/providers/environmentGuard.ts` is the SELECTOR: `production` ⟺ live,
every other environment ⟺ test, before the first provider call of a new
operation. An operation on a STORED object — refund, cancel, transfer,
reversal, dispute response, settlement read, account refresh, sweeps — resolves
by the row's `livemode` (`selectStoredProvider`), which every repository reads
from the row's merchant in the same statement (`db/merchants/merchantLivemode.ts`),
never by a process-wide default. A mode with no key is a card rail that is off:
503, and nothing falls through to the other key. Inbound Stripe webhooks arrive
on the same two paths for both modes: the mode whose secret verifies a delivery
is its mode, an event whose `livemode` disagrees with that secret (or whose mode
has no key) is refused 400, and the drain refuses an event of a key-less mode or
one naming an object of the other mode. Tax holds one Stripe Tax provider per
configured mode. Every merchant-scoped DTO and the event envelope carry `livemode`.
Peable holds the provider credentials and merchants supply none — ADR 0009,
which supersedes ADR 0001 D3 and leaves the merchant-of-record decision
explicitly open.

**Every status change fans out through ONE path**, and a route that writes a
status with `updateIntentState` and returns changes the database and tells
nobody. That path is `transitionIntent` in `services/intentTransition.ts`: it
advances the row AND records the merchant's event (with its deliveries) **in the
same transaction** (ADR 0001 D7), then the caller calls `announceIntentChange`
after the commit for the two transports that are not durable — the payer's
socket frame and the outbox kick. A batch producer that cannot go one row at a
time takes `recordIntentEvent` on its own `tx` instead, as the expiry sweeper
does.

The ordering is the whole point and it is easy to undo: enqueue after the commit
and the outbox becomes the best-effort delivery it was built to replace; emit
the socket frame inside the transaction and a payer is told about a transition
that then rolled back.

**A status write is a COMPARE-AND-SWAP, and `IntentStateChange.from` is the
compare half.** Every caller reads the intent, decides a target with
`applyEvent` — a pure function over that earlier read — and only then writes, so
without `status = from` in the WHERE the state machine is advisory: `ALLOWED`
has `canceled: []`, and an event racing `expireDueIntents` still wrote
`succeeded` over an expired intent and enqueued a second, contradicting outcome
for one payment. The same statement writes what the transition decides with it
— `last_payment_error` (cleared by any other transition),
`cancellation_reason`/`canceled_at`, `amount_received`, the txid.
`from` is required so a caller that cannot name where it started does not
compile, and the result is three-way — `updated` / `stale` / `missing` — because
a route answers 409 for a row that moved and 404 for one that is not there.
`expireDueIntents` needs none of this: its own statement carries the status
predicate and `for update skip locked`.

**The live tail is a `NOTIFY` inside the writing transaction, and test mode
only.** `recordEvent` (and the request-log writer, `lib/requestLog.ts`) signal
`services/liveTail.ts`'s channel for a TEST-MODE row on the same `tx`, so
`GET /v1/events/stream` / `/v1/request_logs/stream` (SSE, `lib/liveStream.ts`)
hear of a row at its commit and never of a rollback, on every ECS task. The
payload is ids only; the stream reads the row back through its repository.
Never emit to a stream from anywhere else, and never signal a live row (a
NOTIFY commit takes a database-wide lock on the shared instance). Test helpers
(`/v1/test_helpers/*`, `services/testHelpers.ts`) are fake INPUTS to the real
code — `reportFaircoinBroadcast`, the watcher's `applyChainObservation`, the
sweep's `expireIntentNow` — never a status write of their own.

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

**`services/oxyAccess.ts` is the ONLY place Peable asks Oxy what a person may
do**, for every user-authorised surface: Orbit's dashboard, Peable Tax and the
tax workspace, Orbit uploads and the contribution routes. It is a thin layer
over `@oxy.so/core`: `oxy.applicationAccessFor(req, A)` (the person's
application permissions through the account that owns A, plus `ownerAccountId`,
`official` and `status`; never `appPermissionsFor`, which answers a different
question) and `oxy.accountAccessFor(req, X)`. The SDK asks Oxy with the
caller's own bearer, refuses a service credential, caches only answers that let
someone in (30 s, per session) and types every other outcome as an
`OxyAccessError`; Peable adds the action's permission, `fresh` on every non-GET
and the answer in its own envelope: 401 → `session_invalid`; 403/404 →
`application_membership_required`; anything else → 503
`membership_unavailable`, never cached as "no". Peable keeps no client, schema
or cache of its own.
`services/__tests__/oxyAccessIsTheOnlyPath.test.ts` fails on an access read or
a `createOxyAuthMiddleware` outside their one module, on a raw `apps.get` /
`accounts.get` / `callerMembership` read, a per-user client (`new OxyServices`,
`withUser`, `asUser`) or the SDK's own access middleware anywhere in the
gateway, and on a permission string spelled out in the gateway.

**Each action needs one permission, defined once** in
`@peable.to/contracts/vocabulary` (`DASHBOARD_PERMISSIONS`,
`allowsDashboardAction`, `FILE_UPLOAD_ACTION`). The gateway's gate
(`routes/dashboardAccess.ts`, `dashboardGate(access)(action, core)`) and Orbit
(`useDashboardPermissions().can(action)`) read the SAME map:

| Action | Oxy permission | What |
|---|---|---|
| `read` | `app:read` | every GET, search, a report run (membership itself) |
| `configure` | `app:update` | branding and customer emails, catalog, checkout sessions, payment links, contribution links, payment methods and wallet domains, a `business_logo` upload |
| `webhooks` | `webhooks:update` | webhook endpoints, secrets, test events, redelivery |
| `money` | `billing:manage` | the merchant (its confirmations), the provider account and onboarding, payouts, Connect sellers and transfers, disputes, the billing engine, every Peable Tax change and decision, evidence/identity/tax uploads |
| `taxRead` | `billing:read` | Peable Tax reads and previews (`billing:manage` contains it) |

A new route names its action; `routes/__tests__/dashboardPermissions.realdb.test.ts`
walks the real gateway and fails on a route the table above does not cover or
whose gate disagrees with it. Contributions additionally require the path's
account to be an organization that owns the active application.

## The web build is read-only, not unsupported

Only SIGNING is native-only, and the reason is narrow: the identity wallet's
seed derives from the identity key, whose holder is on the device (iOS: the
keychain group; Android: Commons over signature-protected IPC — Peable never
holds the key), and a browser has none. `hasIdentityKeystore()`
(`src/wallet/keystore.ts`, a `Platform.OS` proxy) answers that one question for
both `wallet-store.ts`'s `initializeFromIdentity` and the shell's capability
gate, and is the ONLY platform gate in the store — `createNewWallet`, `importWallet`
and `importWatchOnly` carry none, and `storage/kv-store.ts` has a real web
branch. Peable's fork deleted FAIRWallet's create/restore SCREENS (`4287418`),
not the capability.

Everything else a wallet shows needs no private key: balances and history are
public chain data, the receive address derives from a public identity key, and
`GET /v1/social/me/payments` answers by identity rather than by derived
addresses, which is the only payment view a keyless surface can ask for. So the
probe result is `"no-keystore"` and the route is `"read-only"`.

**Say what is absent, not which platform you are on — and gate the SHELL on
capability, never on `initialized`.** `src/wallet/capability.ts` decides
`full` / `read-only` / `pending` / `none`; `app/(tabs)/_layout.tsx` admits
`read-only`, and each tab renders its keyless branch (home activity, profile
receive code, settings without wallet sections). Send needs a key, so
the read-only rail and bar omit it and its screen redirects home. Currency
purchase screens are not part of Peable on any host.

Both wrong designs are easy to rebuild: naming the platform and redirecting
bounced off a `(tabs)` that admitted only an initialized wallet, and rendering
read-only in place on `app/index.tsx` left the browser outside the shell, with
no rail and no Settings.

**Never `<Redirect href="/" />` from inside `(tabs)`.** A route group adds no
URL segment, so `/` there resolves to `(tabs)/index`, the layout renders the
redirect again, and React aborts with error #185. The layout renders `SignInView` in place for `none` on
a keyless host instead. A keystore host is deliberately NOT gated there:
`lockWallet` drops `initialized` while the PIN overlay covers the shell, and a
gate would swap the tabs for sign-in underneath it.

The tab chrome is Bloom — `Rail` in a wide browser window, the floating
`TabBar` everywhere else — from one `expo-router/tabs` navigator on every
platform (harvested from FAIRWallet#9). The bar floats, so a tab screen clears
it with `useTabScreenBottomInset()`; a new tab that skips it hides its last row.

The public `/@username` profile (`app/(tabs)/[username].tsx`, also the 404
catch-all) is a bar-less route INSIDE that navigator, so a signed-in visitor
keeps the rail there. The gate lets it through for a signed-out payer and
renders no bar for them; moving it back to `app/` root drops the shell.

## Acting as an organization opens the ORGANIZATION's wallet

The wallet belongs to the account the session acts as (oxy ADR 0001):
`useAuth().user`, which is the organization when a person acts as one, and
whose bearer the gateway answers for (`/v1/social/me/*` is then the
organization's — no route of its own). `src/wallet/organization-wallet.ts`
decides it: an organization's wallet is `oxy-org-<id>`, its seed is
`deriveScopedSeed(PEABLE_SEED_INFO, { accountId })` and its social-receive coins
are signed with `signSocialReceive(…, { accountId })` (oxy ADR 0061 D6) — never
the person's key, which would hand the organization's payers addresses that
leave with that person. `oxy.accounts.identityKey.get` says who may hold it
(403 → only owners and admins) and which key it publishes (`null` → "Set up the
organization's Peable wallet" in Commons); a phone without the key is sent to
Commons to add it; a phone holding a REPLACED key opens it with social receive
off (ADR 0002). `useWalletFollowsActingAccount` closes the wallet on every
account switch so the previous account's wallet is never shown, or spent, under
the new one. Project, bot, channel and community accounts open no wallet.

**Each person's wallet is their account's, and its key is vouched for (ADR
0002, rounds 5 to 7).** The person's wallet is `oxy-user-<accountId>` — never
one shared id — and every per-wallet store follows it; the pre-round-5
`oxy-identity` namespace moves to the account that proves it, keeping only
what that account's keys derive (`wallet/identity-namespace.ts`,
`Database.keepOnlyOwnerData`; each tree derived well past every stored row,
coin and previous-key cursor, and multisig rows naming the owner's keys kept),
and is merged — never copied over — into a wallet already in use; a check is
recorded only when definite (core's `null` for a key this device holds is not
an answer), and asked again when the key history or ring changes (Settings →
"Recover an earlier wallet"). The check never blocks the account's own wallet
from opening, and runs in the init queue, a real mutex (`wallet/init-queue.ts`:
not re-entrant — a queued task brings a wallet up with `initializeHeld`, never
`initialize`).
Which key a wallet opens with is `wallet/identity-key.ts`'s decision from what
the ACCOUNT vouches for, and every seed derivation and social-receive
signature names that key (`publicKey` selector);
`KeyManager.getSharedPublicKey` (the iOS keychain group every Oxy app can
write) is a hint only. **Only a `null` key read means "not held here"**: a
throw (`@oxy.so/core`'s `IdentityUnavailableError` from a selected derivation
or signature while the keychain is locked or Commons busy, or any other) is
"try again later" (`wallet/identity-unavailable.ts`) — the decision stops as
`unavailable` rather than opening another key as `replaced`, a previous key is
`unavailable` rather than stranded, and the entry screen shows the
`key-unavailable` block, never sign-in, "set up your Oxy ID" or
`not-on-device`. Nothing is retired, unbound or hidden, and social receive
stays as the gateway's verdict left it. **Every `addresses` row records the key it derives from
(`identity_public_key`), and only the open key's rows that the open tree
derives are ever offered** (`wallet/receive-address.ts`): after a rotation the
same file still holds the replaced key's rows. Unbound rows are judged by a
probe of the open key's tree that reaches the highest unbound index, never by
the open tree's own window (a used row behind a long unused gap was never
bound). Nothing receivable — address,
QR, `@username`, the Settings header — is shown until the ONE receive gate
opens (`wallet/receive-gate.ts`, `useReceiveGate`): the gateway's fresh
`#key-1` equals the open key, and a wallet adopted from the shared keychain
group was confirmed by the person. A new surface that shows an address goes
through that gate. The keychain move takes nothing from the shared group
without this app's own sandbox evidence of an earlier install
(`storage/install-evidence.ts`), counted only while its nonce is in the
wallet's own group "this device only" (a backup restored onto another phone
carries the file, never the nonce), never a cached seed or the PIN record, and
reads it only through the non-prompting reader (`@oxy.so/core/session`'s
`readSharedWithoutInteraction`). Wallets in the own group when the move
already happened are listed as adopted once (`peable_keychain_split_v2`):
1.2–1.4 builds adopted from the shared group without recording it.

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
