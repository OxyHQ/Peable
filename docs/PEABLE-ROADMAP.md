# Peable roadmap

> Source snapshot: `fix/issue-70-gateway-hardening` at `433fa354f5dd43364e24de06295d22065b1323e7`
> (2026-09-19). A merged source feature is not proof that its production
> deployment, database migration or device flow has been verified.

## How to read a checkbox here

The previous version of this file used one box per item, and a reader could not
tell "the code exists" from "this works in production". That ambiguity is how a
roadmap entry becomes a commercial promise: the 2026-09-03 snapshot said the
checkout had no deployment workflow while one existed and had run successfully,
and the same document's checkboxes were being read as a statement about live
capability.

So every item below carries **four independent states**, and they do not imply
each other:

| Mark | Means |
|---|---|
| **impl** | the code is merged and its own tests pass |
| **sandbox** | exercised end to end against the provider's test mode, by a person |
| **deployed** | running in the production artifact, with the migration ledger read back |
| **live** | enabled for real money, with the commercial and legal gates cleared |

An item with **impl** and nothing else is a thing that compiles. Nothing in this
repository can mark **sandbox**, **deployed** or **live** on its own: each needs
evidence from an authorized environment, and a merged commit is not that
evidence.

The detailed design history remains in git. These are the maintained source
documents:

- [Fase 1 product design](superpowers/specs/2026-07-18-peable-phase1-foundation-design.md)
- [Gateway implementation plan](superpowers/plans/2026-07-18-peable-gateway-backend-f1a.md)
- [Oxy identity and social-payment design](superpowers/specs/2026-07-18-peable-oxy-identity-social-redesign-design.md)
- [Integration guide](integrating-peable.md)

## Product boundaries

- **Peable** is the self-custodial wallet in `packages/frontend`.
- **Peable Gateway** is the API in `packages/backend`, its wire contract in
  `packages/shared-types`, the published `@peable.to/sdk` SDK in `packages/sdk`, and
  the payer-facing web application in `packages/checkout`.
- **Peable Terminal** is the future point-of-sale product. No
  `packages/terminal` implementation exists yet.
- Oxy owns applications, credentials and permissions. Peable must not create a
  second account or credential authority.

## Invariants

- The wallet signs and broadcasts. The backend accepts watch-only merchant
  material and must never receive, derive, persist or log a private key.
- PostgreSQL is the only backend datastore. `DATABASE_URL` is required; schema
  changes go through the repository's phased Drizzle migrator.
- Public ids such as `pi_...`, `link_...` and `cs_...` are wire identities;
  internal primary keys remain private database references. Code must select by
  the exact kind of id the contract names.
- Merchant routes use Oxy service credentials. Payer reads use the scoped
  client secret. Dashboard routes delegate human authorization to Oxy instead
  of reproducing Oxy membership logic.
- A source checkbox never certifies mainnet eligibility. Legal review, exact
  deployed-artifact readback and an end-to-end testnet canary remain release
  gates.

## Current state

### Gateway and contract

| Capability | impl | sandbox | deployed | live |
|---|---|---|---|---|
| Payment-intent state machine, public ids, idempotent creation | yes | — | — | — |
| Watch-only address reservation and Explorer settlement checks | yes | — | — | — |
| REST routes: merchants, intents, links, sessions, social, enrichment, webhook deliveries | yes | — | — | — |
| REST routes: connected accounts, transfers and reversals, refunds, disputes | yes | no | — | no |
| `connected_account.updated` — seller readiness reaches the merchant | yes | no | no | no |
| Realtime intent updates and signed, retrying webhook delivery | yes | — | — | — |
| PostgreSQL repositories, schema, phased migrations, real-database harness | yes | — | — | — |
| Test/live isolation enforced against the provider's KEY MODE, not only by row | yes | no | no | no |
| Card payments: create, confirm, cancel, expire, reconcile | yes | **no** | no | **no** |
| Refund lifecycle including pending, failed and provider-originated refunds | yes | **no** | no | **no** |
| Settlement: charge-sourced transfers, per-payment budget, durable reversals | yes | **no** | no | **no** |
| Disputes: deadline, outcome, atomic notification | yes | **no** | no | **no** |

The card rail has never been exercised against Stripe's sandbox by a person, and
no row above may be moved without that. The unit and real-database suites cover
the gateway's own invariants; they cannot cover Stripe's object ids, its
capability behaviour, or the shape of its real events.

### Wallet

- [x] Oxy identity integration and self-custodial approve/sign/submit flow.
- [x] Pockets, social send/receive and multisig primitives are present in the
  source tree and consume `@fairco.in/core@0.5.0`.
- [ ] Re-verify cold boot, sign-in, key rotation, social receive and the full
  approve-payment flow on a production-equivalent physical device before
  enabling mainnet social payments. The code half of finding F-1 is done —
  `docs/adr/0002-social-receive-is-bound-to-one-identity-key.md` lists what it
  changed and what is still required — so what remains here is the device
  verification itself, on a device WITH the shared-identity slot and one
  without.
- [ ] Complete the internal FAIRWallet-to-Peable naming sweep without changing
  third-party attribution.

### SDK and hosted checkout

| Capability | impl | sandbox | deployed | live |
|---|---|---|---|---|
| Server SDK: intents, links, checkout sessions, webhooks | yes | — | published `0.1.1` | — |
| Server SDK: merchants, connected accounts, refunds, transfers, disputes | yes | no | **not published** | no |
| Browser entry: payer retrieval, deep-link handoff, QR, live status | yes | — | deployed | — |
| Browser entry: resume (`getClientAction`) and the hosted CARD form | yes | **no** | no | **no** |

The deployment workflow for the checkout application EXISTS and has run
successfully; the 2026-09-03 snapshot of this file said it did not, which is the
kind of stale claim the four-state table above is meant to stop.

**A local change to `shared-types` or `sdk` is not a published contract.** Both
are consumed by other repositories from npm, so an integrator has the published
version until a release happens — and the settlement shapes and the new
namespaces are unreleased on this snapshot.

### Dashboard and merchant tooling

- [x] `/v1/dashboard/*` delegates application membership to Oxy and exposes
  merchant, intent and webhook-delivery operations.
- [ ] Build the standalone dashboard application. No `packages/dashboard`
  directory exists on this snapshot.
- [ ] Add the API-credential UI over Oxy's existing application-credential
  routes; never persist the show-once secret.

## Remaining delivery gates

### Card rail, before any real card is charged

- [ ] **Decide the merchant of record, per flow.** Every card payment this
  gateway creates today is a platform charge with no `on_behalf_of`, which makes
  the operator of the Peable deployment the merchant of record — see
  [ADR 0009](adr/0009-peable-holds-the-provider-credentials.md). That decides
  the descriptor, who answers a chargeback, whose terms apply and who issues
  receipts. It is commercial and legal, not technical, and no code change makes
  it.
- [ ] Confirm the platform account's approved scope with the provider:
  countries, capabilities, cross-border flows, and whether the intended flows
  are within them.
- [ ] Exercise the whole card rail against the provider's sandbox, by a person:
  onboarding, a payment with and without SCA, a decline and a retry, a
  cancellation racing a confirmation, a two-seller cart, two distinct reversals
  of the same amount, a pending refund that later fails, a refund made from the
  provider's dashboard, and a dispute through to its outcome.
- [ ] Verify the environment guard with a real key pair: a development
  credential against a live-keyed deployment must be refused before any call.
- [ ] Publish `@peable.to/shared-types` and `@peable.to/sdk`, and confirm each
  consumer resolves the published version — a contract test that runs against
  the workspace copy proves nothing about what an integrator has.
- [ ] Settle the accounting per entity: which costs Peable's operator bears,
  what Peable charges, and how settlement detail (gross, fees, net, currency,
  availability) reaches a merchant. `unknown` must be representable and must
  never be reported as zero. **Not implemented at all on this snapshot.**
- [ ] Decide and implement dispute EVIDENCE: either a submission path or a
  documented, auditable operational process. The gateway exposes the deadline
  and cannot currently respond.

### Existing gates

- [ ] Record the required EU crypto/fintech legal opinion before production
  money movement.
- [ ] Verify the exact running AWS task image and the applied pre/post migration
  ledger; a successful build or merged commit is insufficient.
- [ ] Run an end-to-end testnet canary: create intent, payer retrieval, wallet
  approval, signing, broadcast, settlement, realtime update and webhook.
- [ ] Prove private-key rejection and concurrent address reservation again on
  the release candidate.
- [ ] Deploy and canary the hosted checkout separately from the backend.
- [ ] Keep mainnet disabled for any flow whose physical-device and key-rotation
  checks have not passed on the release candidate.

## Later phases

- [ ] Merchant integration in Mercaria.
- [ ] WordPress/WooCommerce integration, followed by other commerce adapters.
- [ ] Shared Pockets with multi-party signing and encrypted partial-signature
  coordination; the coordinator must remain unable to spend.
- [ ] Peable Terminal for mobile and desktop, including an explicit NFC
  entitlement and confirmation policy.
- [ ] Subscriptions and billing, IF they are part of the announced offer:
  customers, products and prices, stored methods and consent, renewals,
  off-session SCA, dunning, proration, cancellation, invoices and tax. A payment
  link is not a subscription engine, and nothing here implements one.
- [ ] Payouts and reconciliation: a transfer marked `paid` says a connected
  account's balance moved, NOT that a bank received anything. Payout tracking,
  bank returns, reserves and negative balances are unimplemented.
- [ ] A second fiat provider. The provider port exists; only Stripe implements
  it, and "the interface exists" is not "SumUp works". Failover must never
  create a second charge when the first one's outcome is unknown.
- [ ] Analytics, without weakening self-custody.

## Deliberately NOT available

Listed here because a roadmap entry reads as a commitment, and these are things
a merchant must not be told they can have:

- dispute evidence submission (the deadline is exposed; the response is not);
- settlement, fee and payout reporting;
- subscriptions and stored payment methods;
- any fiat provider other than Stripe;
- Peable Terminal, NFC and shared pockets.
