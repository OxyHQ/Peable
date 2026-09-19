# ADR 0001: Peable is a multi-rail gateway — FairCoin and fiat, one contract, providers behind it

- **Status:** Accepted
- **Date:** 2026-09-06
- **Supersedes nothing.** This is the first ADR in this repository; the design
  history it builds on is `docs/superpowers/specs/` and `docs/PEABLE-ROADMAP.md`.
- **Measured against:** PostgreSQL 16.13, real server, 2026-09-06. Every claim
  below marked MEASURED was a real statement against a real database; the errors
  are quoted verbatim.

## Context

Peable ships today as a **single-rail** gateway. `CURRENCY_CODES = ['FAIR']`
with a CHECK behind it, `PaymentIntent.currency` is the literal type `'FAIR'`,
`payment_intents.address` and `.network` are NOT NULL, and no workspace imports
any fiat processor. The roadmap lists "Subscriptions, refunds, payouts, disputes"
and "Merchant integration in Mercaria" under *Later phases*, and the phase-1
spec puts fiat explicitly out of scope: *"on/off-ramp fiat (partner licenciado,
no Oxy), refunds, payouts, antifraude, multi-currency."*

Meanwhile Mercaria — Oxy's marketplace — has a **complete** card payment
integration built directly against Stripe: ~3,400 lines under
`services/payments/stripe/`, 26 `STRIPE_*` variables, a balanced internal
ledger, per-seller settlement, refunds, disputes and reconciliation. It has
never processed a payment: `POST /v1/accounts` was refused on its platform
account for months (its ADR 0008), so **no connected account, no charge and no
transfer has ever existed**. There is nothing to migrate.

The decision taken at the product level is that **every Oxy payment goes through
Peable**, with fiat served by providers (Stripe first, SumUp and Square later)
that stay invisible to merchants and payers alike. This ADR decides what that
means for this repository, before any provider code is written.

Mercaria's own `services/payments/provider.ts` already defines a
provider-neutral port — `PaymentProvider` and `SettlingPaymentProvider` — with a
contract test suite every rail must pass. Its ADR 0001 named this outcome in
advance: *"everything provider-specific stays behind the `PaymentProvider`
interface … a future rail — see the FairCoin/OxyPay boundary — plugs into the
same seams."* OxyPay is Peable. This is that rail.

---

## Decisions

### D1. `rail` is the discriminator, and it is on the intent

`payment_intents.rail` is a closed value set — `'faircoin' | 'card'` — typed and
CHECK-constrained from one tuple in `schema/valueSets.ts`, like every other
closed set here.

It goes on the **intent**, not on the merchant: one merchant takes both. A
merchant's *capabilities* are a separate question (D3), and conflating them
would make "this merchant accepts cards" and "this payment is a card payment"
one column that cannot answer either.

The rail decides which columns mean anything. `address`, `network` and
`confirmations` are FairCoin's and are meaningless on a card; the SCA states are
the card's and are meaningless on-chain. D5 and D6 are the two halves of making
that structural rather than conventional.

### D2. A provider port inside Peable, shaped like the one Mercaria already proved

`services/providers/` gains an interface with `createPayment`, `capture`,
`cancel`, `refund`, `getStatus` and `verifyEvent`, plus two optional
capabilities: `createTransfer` / `reverseTransfer`, and `createAccount` /
`accountLink` / `getAccount`. `StripeProvider` is the first implementation. The
FairCoin rail is expressed as a provider too, so the intent lifecycle has one
shape rather than a chain path and a fiat path that diverge at every call site.

**The new merchant-facing API is Mercaria's `SettlingPaymentProvider` expressed
over HTTP.** That is not a coincidence to be tidied up later — it is how the
adapter on the other side stays thin, and it is why the endpoints are designed
against that interface rather than against Stripe's REST shape.

Optional rather than universal, for the reason Mercaria's file gives and this
repository has an even stronger case for: a rail that cannot settle a
sub-merchant has nothing to take back, and a method for the attempt would let a
caller believe money had been recovered from a movement that never happened. The
FairCoin rail is non-custodial by construction — the gateway never holds the
funds — so it implements neither half, and that is the truth about it rather
than a gap.

### D3. Provider credentials belong to the MERCHANT. Peable is an orchestrator, never an acquirer

> **SUPERSEDED by [ADR 0009](0009-peable-holds-the-provider-credentials.md).**
>
> The `provider_connections` table described below does not exist and never
> did. The gateway builds ONE Stripe client from a single `STRIPE_SECRET_KEY`
> belonging to whoever operates the deployment, and calls Stripe as ITSELF —
> which is also the product decision: merchants integrate with their Oxy
> application credential and supply no Stripe key. The reasoning about hosted
> onboarding, about the acquirer being the regulated party and about Peable
> never holding money is unchanged and still load-bearing; what is withdrawn is
> where the platform account sits, and therefore who the merchant of record is.
> ADR 0009 records the implemented model and names the merchant-of-record
> decision as outstanding.
>
> Left in place rather than rewritten: this section is the argument the code was
> read against for two years, and deleting it would leave the disagreement
> unexplained.

A `provider_connections` row binds a merchant to a provider and holds that
merchant's own encrypted credentials. Peable calls Stripe **as the merchant**.

This is the load-bearing decision of the whole design and it is a legal one, so
the reasoning is recorded in full.

**Multi-vendor carts and zero platform risk are mutually exclusive, and Stripe
is what makes them so.** A `PaymentIntent` can fund exactly one connected
account (`transfer_data.destination` names one), so a cart spanning two sellers
must use *separate charges and transfers* — and Stripe permits that model only
when `controller.losses.payments = application`, i.e. the platform account
answers for its connected accounts' negative balances. The exposure therefore
lands on whoever owns the platform account. It cannot be pushed onto Stripe and
it cannot be pushed onto the sellers.

What **can** be avoided, and is: **Peable never becomes a payment institution
and never holds anyone's money.** Funds live on the acquirer's balance, the
acquirer is the regulated party, and Peable moves instructions. Putting the
platform account on the merchant's side of the line is what keeps that true
while still routing every payment through this gateway.

So for Mercaria, Mercaria's Stripe platform account stays Mercaria's, and
Mercaria remains merchant of record (its ADR 0001 D1, unchanged). Peable gains a
genuine multi-tenant shape it needs for its second merchant anyway.

**This is configuration, not architecture.** A `provider_connections` row
pointing at Oxy's own acquiring account is the same row with different
credentials, and nothing above it changes. That day is a commercial and
regulatory decision, and this schema does not pre-judge it.

**What the payer and the merchant see** is Peable, everywhere except one place:
a sub-merchant completing KYC reaches the provider's hosted onboarding. That is
deliberate, not a leak to be closed — hosted collection is precisely what keeps
identity documents out of this database. Making it invisible needs the
provider's embedded components and is not on this path.

### D4. Currency is a value set; amount scale is a property of the currency

`CURRENCY_CODES` widens from `['FAIR']` to include the fiat codes the merchants
actually price in. The tuple's own comment anticipated this: a single-member set
earns a CHECK because it *"makes adding a second currency a migration with a
decision behind it rather than a value that appears one day in a row."* This is
that decision.

`amount` stays `text` holding a canonical non-negative integer string with the
existing `BASE_UNIT_STRING_PATTERN` CHECK. What changes is that the **scale is
no longer implied**: FairCoin is 10^8 base units per coin, fiat is 10^2 minor
units, and `UNITS_PER_COIN` is a frozen FairCoin constant, not a table. A
`currency → decimals` map in `shared-types` becomes the single authority, and
`UNITS_PER_COIN` is never used to interpret a fiat amount.

**Three places hardcode `FAIR` outside the schema and must move together**, or a
row carrying a new currency would be correctly stored and then mislabelled on
the way out:

| Where | What it does |
|---|---|
| `shared-types/src/paymentIntent.ts` | `currency: 'FAIR'` as a literal type |
| `backend/src/lib/serialize.ts` | writes `"FAIR"` into the DTO instead of reading the column |
| `db/payments/paymentIntentRepository.ts` | casts `row.currency as 'FAIR'` |

The serializer is the dangerous one: it does not read the column at all, so
widening only the CHECK would produce rows the API describes incorrectly with
every test green.

**The FairCoin rail settles in FAIR and only it does**
(`payment_intents_rail_currency_agrees_check`, and its twin on sessions and
links). A FAIR-denominated card charge and a EUR-denominated chain payment are
both expressible in the column types and neither is a payment this gateway can
make: the second needs an FX conversion at settlement time that nothing here
performs, so it would store an amount in a unit the arriving coins are not
counted in. `resolveRail` refuses both with a 422. Loosening this — priced in
EUR, settled in FAIR — is a real product idea and a later migration with its own
decision, not something to let in by omission now.

### D5. The status set widens, and the chain states become rail-specific

`PaymentIntentStatus` gains `requires_action`, `processing`, `refunded` and
`partially_refunded`, with the transition table extended to match. `settled`
keeps its meaning — captured, and verified from the provider rather than
asserted by a client.

The four chain states — `awaiting_approval`, `approved`, `broadcast`,
`confirming` — are constrained by CHECK to `rail = 'faircoin'`. Mapping a card
authorization onto `broadcast` would be cheaper and would be a lie: nothing was
broadcast, there is no transaction, and `payment_intents_broadcast_requires_txid_check`
would then be enforcing a txid on a payment that can never have one.

**One table, plus a per-event source restriction.** Opening `created → settled`
for a card charge that confirms in a single call also opened it for the chain
event `confirmed`, which the settlement watcher emits — legalizing
`applyEvent('created', 'confirmed')`, a FairCoin payment settled without ever
being broadcast. The database still refuses the result, so the damage would have
been a constraint violation surfacing as a 500 instead of the located error
`intentState.ts` exists to raise. `LEGAL_SOURCES` there names where the
chain-only events may act FROM; it generalizes the exception
`reorg_below_threshold` already had. A rail-parameterised transition table was
the alternative and would put the same restriction in two places.

⚠️ `@peable.to/shared-types` and `@peable.to/sdk` are **published packages**.
This is an external API change and is versioned as one, not folded in as a
refactor. On the payer side it has a behavioural half:
`PeableCheckout`'s pay button and the hosted page must REFUSE to build a
`peable://pay` link for a non-chain intent (`payDeepLinkFor` /
`PeableRailUnsupportedError`). The tempting `?? ''` at those call sites mints a
structurally valid link carrying an empty address, which sends a payer nowhere.

### D6. The network firewall survives a nullable `network` — but only with a second foreign key

This is the one schema decision with a non-obvious right answer, so it was
measured rather than reasoned.

`payment_intents (merchant_id, network) → merchants (id, network)` is the
network firewall (`CONVENTIONS.md` §Composite foreign keys). A card intent has
no network, so `network` must become nullable — and a composite foreign key in
PostgreSQL defaults to `MATCH SIMPLE`, which is **satisfied without any check
when any referencing column is NULL**.

That gives exactly the semantics wanted — the firewall binds a FairCoin intent
and is vacuous for a card one — and it opens a hole that is invisible in the
schema, because that composite reference is the **only** thing pointing
`merchant_id` at `merchants`. MEASURED, on the shape above with `network`
nullable:

```
-- card intent, network NULL, merchant that does not exist
insert into intents values ('i4','ghost-merchant',null);
INSERT 0 1                       -- accepted. No referential integrity at all.
```

**So a plain `merchant_id → merchants (id)` reference is added alongside the
composite one.** With both present, MEASURED:

| Case | Result |
|---|---|
| card intent, `network` NULL, real merchant | accepted |
| card intent, `network` NULL, ghost merchant | `violates foreign key constraint "intents_merchant_id_fkey"` |
| FairCoin intent, wrong network | `violates foreign key constraint "intents_merchant_network_fkey"` |
| FairCoin intent, right network | accepted |

The firewall is intact, the hole is closed, and the composite reference's
implicit `ON UPDATE RESTRICT` still stops a merchant's network changing under an
intent that already exists.

**`MATCH FULL` is the obvious alternative and is wrong.** It requires
all-or-nothing nullity across the referencing columns, and `merchant_id` is NOT
NULL, so it refuses every card intent. MEASURED:

```
insert into intents_full values ('f1','m1',null);
ERROR:  MATCH FULL does not allow mixing of null and nonnull key values.
```

`checkout_sessions` and `payment_links` reference
`merchants (id, oxy_app_id, environment, network)` and need the same treatment
for the same reason — with `network` nullable, the whole four-column reference
goes vacuous and the denormalized `oxy_app_id` and `environment` stop being
guaranteed too. A narrower `(merchant_id, oxy_app_id, environment)` reference
alongside restores it. MEASURED: a card session naming the wrong `environment`
is refused by the narrower reference, and a FairCoin session naming the wrong
`network` is still refused by the wider one.

Paired with all of this, a CHECK states the rail's own requirement in the one
place a write that skipped the application still has to pass:
`rail <> 'faircoin' OR (address IS NOT NULL AND network IS NOT NULL)`.

### D7. Outbound delivery becomes a durable outbox

`services/webhookDispatcher.ts` today delivers **inline and best-effort**: three
attempts, backoff of 50 ms then 100 ms, and `deliver` never throws. A merchant
endpoint that is unreachable for a fifth of a second loses the event silently.

That is survivable for a merchant who reconciles by polling. It is not
survivable for Mercaria, whose payment state is reached **only** from a verified
event — a lost `payment_intent.settled` is a paid order that stays unpaid, with
nothing anywhere reporting a problem. Delivery becomes a persisted outbox with
real backoff, bounded attempts and a dead-letter state, on the model of
Mercaria's own `payment_outboxes`.

Two existing defects are part of this decision rather than separate bugs,
because both are ways an event that should exist never gets emitted:

- `POST /v1/payment_intents/:id/reject` mutates the status without calling
  `onIntentChange`, so `payment_intent.rejected` is never emitted on the
  merchant-cancellation path — which is exactly the path a `cancel` through the
  port will use.
- The `expire` event is defined and unit-tested but **has no production
  caller**: there is no expiry sweeper. A gateway whose intents never expire
  leaves the merchant's inventory reservations held forever.

---

## What this does NOT change

- **Non-custody.** `services/derivation.ts` still refuses an extended key
  carrying a private key, and no code path accepts one. Adding a fiat rail does
  not put Peable in possession of anyone's funds — D3 is the whole argument.
- **The reservation.** `db/merchants/derivationIndex.ts` and
  `db/social/receiveCursor.ts` stay one statement each. Nothing here touches
  them, and a card intent reserves no address at all.
- **The anonymous payer.** The hosted checkout requires no Oxy session, which is
  what a card payer needs as much as a FairCoin one.
- **One store.** PostgreSQL, `DATABASE_URL` required to boot, phased migrations,
  no extensions.

## Consequences

- Peable takes on the operational surface of a card acquirer's client: signature
  verification over raw bodies, event ordering and idempotency, refunds,
  disputes, sub-merchant readiness. Most of it arrives as a **port** of code
  Mercaria has already written and tested rather than as new work — which is
  what makes this tractable, and also means the port must keep two things that
  are there by experience: the pinned API version, and the async signature
  constructor (the synchronous crypto entry points throw under Bun).
- Two raw-body routes must mount **before** `express.json()`, which
  `server.ts` currently applies ahead of every router. This repository has no
  such route today; the invariant arrives with the first one and needs a test
  against the real middleware chain, not a unit test of the handler.
- The published contract changes shape. Downstream integrations pin versions.
- `provider_connections` holds encrypted third-party credentials — a class of
  secret this database has never carried. Key management and rotation are a
  prerequisite of the first row, not a follow-up.
- FairCoin's mainnet gates are untouched and still bind: the legal opinion, the
  testnet canary, the physical-device checks. The fiat rail does not wait on
  them, because the acquirer is the regulated party there.

## Open items (tracked, not blocking)

1. Whether the FairCoin rail can settle a **sub-merchant** — a seller who
   registers their own xpub — or only the merchant itself. This decides whether
   a marketplace can offer FairCoin to third-party sellers at all, and it is a
   product decision that does not block the card rail.
2. A React Native surface for the payer SDK. The browser entry mounts onto the
   DOM, so a native app can only reach the hosted checkout today.
3. Embedded onboarding components, to close the one place a merchant sees the
   provider (D3).
