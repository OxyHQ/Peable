# Peable

Peable: a FairCoin payment gateway with Stripe-shaped ergonomics, plus the
self-custodial wallet that spends on it. Bun monorepo, `packages/` layout.

> Org-wide engineering standards (package manager, TypeScript, React, naming,
> error handling, security, testing, git and PR conventions) live in
> <https://github.com/OxyHQ/engineering>. This file carries only what is true of
> Peable specifically. Versions are in `package.json`, never here.

## Packages

There are **six**, not three. Three of them are published to npm, so a change in
`shared-types`, `sdk` or `pay` is an external API change, not an internal
refactor.

| Path | Name | What it is |
|---|---|---|
| `packages/backend/` | `@peable.to/backend` | Express + Socket.IO gateway API. PostgreSQL-native — see below |
| `packages/frontend/` | `@peable.to/frontend` | Expo / expo-router self-custodial FairCoin wallet, forked from FAIRWallet, with Oxy identity. Also packages as an Electron desktop app |
| `packages/checkout/` | `@peable.to/checkout` | Vite + React + react-router-dom SPA. The **anonymous** payer-facing hosted checkout at checkout.peable.to. Not Expo, not React Native |
| `packages/sdk/` | **`@peable.to/sdk`** | Published client. Server entry mints Oxy service tokens from an `ApplicationCredential` and exposes `paymentIntents` / `paymentLinks` / `checkout.sessions` / `webhooks`; the `@peable.to/sdk/checkout` browser entry is the payer-side core |
| `packages/shared-types/` | `@peable.to/shared-types` | Published wire contract shared by backend, SDK and frontend |
| `packages/pay/` | **`@peable.to/pay`** | Published client for paying FROM an Oxy app. Holds the money code the wallet used to own — HD derivation, the UTXO set, coin selection — so there is exactly one implementation of "how much money is this", not one per app. `sendPayment` / `quotePayment` / `readBalance` (`src/payment.ts`) are the whole surface: seed in, txid out, no key custody |

The package directory name and the npm name differ for the SDK: `packages/sdk`
publishes as `@peable.to/sdk`.

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
condition: its Bloom imports are all subpaths that live only in bloom's
`exports` map, and the CJS pass has to use node10 resolution (`@fairco.in/core`
is ESM-only, so `node16` refuses the whole package) — which cannot see subpath
exports at all.

The sheet takes a `getSeed` CALLBACK, never a seed. The bytes live in one async
function's local and are zeroed in its `finally`; a seed passed as a prop would
sit in the parent's element tree for as long as the sheet is mounted. Its
ABSENCE — not `Platform.OS` — is what selects the "continue on your phone" state
with the `faircoin:` QR, same capability-over-platform rule as the wallet's own
web build.

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

Production uses the existing `oxypay` database on the shared `oxy-postgres` RDS
instance so the OxyPay-to-Peable product rename preserves every merchant and
payment record. The database name is an internal legacy identifier, not a
separate product. **No extensions** — measured, and stated as an explicit empty list in
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

**The gateway is not a chain proxy for wallets.** It reads the chain to settle
intents and nothing else. `/api/address/:a` DOES answer (balance, txCount,
utxos, plus `/txs` for paginated history) — a note in `services/explorer.ts`
claimed `addressindex` was off and it was unusable, which was false and stopped
a feature being designed the obvious way. The surface that needs address
balances is the wallet, and `frontend/src/services/explorer-address.ts` reads
them directly: the Explorer echoes the request Origin in
`access-control-allow-origin`, so a browser reaches it with no proxy.

Take `balanceSat` and not the cumulative `totalReceivedSat` / `totalSentSat`
beside it. Those grow without bound and one live address already reports
6_969_626_939_280_430 — within 1.3x of `Number.MAX_SAFE_INTEGER`, so
`JSON.parse` rounds them before any code can widen them to a bigint. A balance
is bounded by the money supply and has ~14x of headroom.

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

Routes (`src/routes/`): `checkoutSessions`, `connectedAccounts`, `dashboard`,
`disputes`, `enrich`, `merchants`, `paymentIntents`, `paymentLinks`,
`providerWebhooks`, `refunds`, `social`, `transfers`, `webhookDeliveries`.

Repositories (`src/db/`), the only thing that reaches Postgres — there is no
`src/models/`: `merchants/` (`merchantRepository`, `derivationIndex`),
`payments/` (`paymentIntentRepository`, `paymentLinkRepository`,
`checkoutSessionRepository`), `social/` (`receiveCursor`, `sendAttribution`),
`webhooks/` (`webhookDeliveryRepository`, `webhookOutboxRepository`),
`providers/` (`providerEventRepository`), `accounts/`
(`connectedAccountRepository`), `transfers/` (`transferRepository`,
`transferReversalRepository`), `refunds/` (`refundRepository`), `disputes/`
(`disputeRepository`).

**A refund and a dispute run in OPPOSITE directions, and the difference is the
whole handler.** A refund is merchant-initiated: Peable writes the row, then
calls the provider, so an event naming a refund row we do not have is
`unmatched` and retried. A dispute is network-initiated: the first thing that
exists is the event, so "no row" is the NORMAL first state and
`handleDisputeEvent` CREATES one. Its idempotency is therefore not a merchant
`external_ref` but `unique(provider, provider_object_id)` — the only identity a
redelivered creation carries. Its two events carry a **`Dispute`** under
`data.object`, not the intent: `WebhookEventPayload` in `shared-types/event.ts`
is the total map of event type to resource, and `buildEvent` is generic over it,
so a new event type cannot ship the wrong payload.

### The card rail's own invariants

Five, and each one exists because its absence was a defect:

- **A card payment is TWO things** — a row here, and a PaymentIntent at the
  acquirer that stays confirmable. Ending it locally (`POST /reject`, the expiry
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
  answers, a bank can reject a refund days later (`refund.failed`), and
  `refunded → settled` is a legal transition for exactly that.
- **`failed` is not terminal on the card rail.** One declined attempt returns
  the provider's payment to a confirmable state; `underpaid` on the chain rail
  still is terminal, and `LEGAL_SOURCES` is what keeps the two apart.

**Test/live is enforced against the KEY MODE, not by row.** A deployment holds
ONE `STRIPE_SECRET_KEY` and therefore serves one mode;
`services/providers/environmentGuard.ts` refuses a credential whose environment
disagrees, at the entry of every money route AND in the service beneath it.
Separating merchants by environment is isolation of data, not of money. Peable
holds the provider credentials and merchants supply none — ADR 0009, which
supersedes ADR 0001 D3 and leaves the merchant-of-record decision explicitly
open.

**Every status change fans out through ONE path**, and a route that writes a
status with `updateIntentState` and returns changes the database and tells
nobody. That path is `transitionIntent` in `services/intentTransition.ts`: it
advances the row AND enqueues the merchant's webhook **in the same transaction**
(ADR 0001 D7), then the caller calls `announceIntentChange` after the commit for
the two transports that are not durable — the payer's socket frame and the
outbox kick. A batch producer that cannot go one row at a time takes
`enqueueIntentWebhook` on its own `tx` instead; the expiry sweeper is the one
that does.

The ordering is the whole point and it is easy to undo: enqueue after the commit
and the outbox becomes the best-effort delivery it was built to replace; emit
the socket frame inside the transaction and a payer is told about a transition
that then rolled back.

**A status write is a COMPARE-AND-SWAP, and `IntentStateChange.from` is the
compare half.** Every caller reads the intent, decides a target with
`applyEvent` — a pure function over that earlier read — and only then writes, so
without `status = from` in the WHERE the state machine is advisory: `ALLOWED`
has `expired: []`, and an event racing `expireDueIntents` still wrote `settled`
over `expired` and enqueued a second, contradicting outcome for one payment.
`from` is required so a caller that cannot name where it started does not
compile, and the result is three-way — `updated` / `stale` / `missing` — because
a route answers 409 for a row that moved and 404 for one that is not there.
`expireDueIntents` needs none of this: its own statement carries the status
predicate and `for update skip locked`.

## Auth

Backend uses `@oxy.so/core/server`: `createOxyAuthMiddleware` on routes,
`getRequiredOxyUserId` to read the caller, `authSocket()` for Socket.IO, plus
`createOxyCors` and `createOxyRateLimit` in `server.ts`. There is no
`requireOxyAuth` call site in this repo. Frontend uses `OxyProvider` and `useOxy`
from `@oxy.so/services` (`app/_layout.tsx`, `src/services/oxy-services.ts`).

The hosted checkout is deliberately **anonymous**: a payer has no Oxy session, so
do not add an Oxy auth requirement to a payer-facing route.

## The web build is read-only, not unsupported

Only SIGNING is native-only, and the reason is narrow: the identity wallet's
seed derives from a key in the on-device keystore (`@oxy.so/core` keyManager ->
`expo-secure-store`), and a browser has none. `hasIdentityKeystore()`
(`src/wallet/keystore.ts`, a `Platform.OS` proxy) answers that one question for
both `wallet-store.ts`'s `initializeFromIdentity` and the shell's capability
gate, and is the ONLY platform gate in the store — `createNewWallet`, `importWallet`
and `importWatchOnly` carry none, and `storage/kv-store.ts` has a real web
branch. Peable's fork deleted FAIRWallet's create/restore SCREENS (`4287418`),
not the capability.

Everything else a wallet shows needs no private key: balances and history are
public chain data, the receive address derives from a public xpub, and
`GET /v1/social/me/payments` answers by identity rather than by derived
addresses, which is the only payment view a keyless surface can ask for. So the
probe result is `"no-keystore"` and the route is `"read-only"`.

**Say what is absent, not which platform you are on — and gate the SHELL on
capability, never on `initialized`.** `src/wallet/capability.ts` decides
`full` / `read-only` / `pending` / `none`; `app/(tabs)/_layout.tsx` admits
`read-only`, and each tab renders its keyless branch (home activity, profile
receive code, settings without wallet sections). Send and Buy need a key, so
the read-only rail and bar omit them and their screens redirect home.

It took three tries, and each wrong one is easy to rebuild. First the entry
named the platform (`"web-unsupported"`) and redirected to `/@you`, whose back
arrow fell into a `(tabs)` that admitted only an initialized wallet and bounced
back. Then the read-only view rendered in place on `app/index.tsx` — outside
the shell, so a browser had no navigation rail and no Settings. Gating on
capability is what lets `app/index.tsx` send `read-only` into `(tabs)` like
`ready`, with nothing to bounce off.

**Never `<Redirect href="/" />` from inside `(tabs)`.** A route group adds no
URL segment, so `/` there resolves to `(tabs)/index`, the layout renders the
redirect again, and React aborts with error #185 — `peable.to/settings` did
exactly that signed out. The layout renders `SignInView` in place for `none` on
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
| Generic FairCoin wallet — SPV, storage, chain UI | FAIRWallet, then cherry-pick down; the shared history makes that work |
| Oxy identity, gateway, merchants, intents, checkout | Only here |

## Deploy

`.github/workflows/deploy-aws.yml` is the only deployment: native `linux/arm64`
build on an arm64 runner, pushed to ECR `oxy/peable`, rolling the `peable` ECS
service on `oxy-cluster`. GitHub repo secrets are the source of truth and are
synced to SSM by the workflow, which skips empty or placeholder values rather
than overwriting a real one.
