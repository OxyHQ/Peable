# Peable roadmap

> Source snapshot: `main` at `b746f4cf130cf1313173178e19bd4f75e65d4213`
> (2026-09-03). A merged source feature is not proof that its production
> deployment, database migration or device flow has been verified.

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

## Current source state

### Gateway and contract

- [x] Payment-intent state machine, prefixed public ids, idempotent creation,
  watch-only address reservation and Explorer settlement checks.
- [x] REST routes for merchants, payment intents, payment links, checkout
  sessions, social payments, enrichment and webhook deliveries.
- [x] Realtime intent updates and signed, retrying webhook delivery.
- [x] PostgreSQL repositories, schema, phased migrations and real-database test
  harness. The former document-model implementation has been removed.
- [x] Test/live merchant isolation, scope gates and network firewall.

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

- [x] `@peable.to/sdk@0.1.1` is published and contains server-side payment-intent,
  payment-link, checkout-session and webhook resources.
- [x] The browser entry and `packages/checkout` implement payer retrieval,
  deep-link handoff, QR presentation and live status.
- [ ] Add and verify the production hosting/deploy path for the checkout web
  application. The repository currently has no Cloudflare deployment workflow.

### Dashboard and merchant tooling

- [x] `/v1/dashboard/*` delegates application membership to Oxy and exposes
  merchant, intent and webhook-delivery operations.
- [ ] Build the standalone dashboard application. No `packages/dashboard`
  directory exists on this snapshot.
- [ ] Add the API-credential UI over Oxy's existing application-credential
  routes; never persist the show-once secret.

## Remaining delivery gates

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
- [ ] Subscriptions, refunds, payouts, disputes and analytics without weakening
  self-custody.
