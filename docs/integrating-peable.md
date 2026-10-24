# Integrating Peable (`@peable.to/sdk`)

A Stripe-ergonomics SDK over the Peable Gateway. **Non-custodial**: the merchant
never holds keys or funds — the buyer pays from their own self-custody Peable
wallet (or an external FairCoin wallet), and settlement is watched on-chain from
the merchant's **watch-only** xpub. Your server never sees a private key.

> **This is the guide for integrating a merchant (e.g. Mercaria).** Everything
> here works on **testnet** first; mainnet is a credential/config flip once the
> merchant is live (see [Test vs live](#test-vs-live)).

---

## 0. Prerequisites (one-time, owner/Console)

1. Register an **Oxy Application** for the merchant in Oxy Console (`third_party` is fine).
2. Issue a **service credential** on it (`type: 'service'`) with scopes
   **`payments:read` + `payments:write`** → you get `{ publicKey, secret }`
   (e.g. `publicKey: oxy_dk_…`). This is the SAME credential mechanism Console
   already issues — there is no separate "Peable API key".
3. Register the merchant once against the Gateway:
   `POST https://api.peable.to/v1/merchants` (authed with the service token).

   To accept **FairCoin**, send `network` AND `xpub` — a watch-only account
   extended public key, never an xprv; the backend derives a child from whatever
   you send and refuses anything that can spend. To accept **cards only**, send
   NEITHER. They are two halves of one capability and the Gateway refuses one
   without the other.

Keep `secret` server-side only. The browser never sees it.

**You never supply a Stripe key.** Peable holds the provider credentials and
calls the acquirer itself; your Oxy application credential is the whole of your
authentication ([ADR 0009](adr/0009-peable-holds-the-provider-credentials.md)).
A merchant-of-record decision follows from that and is still open — see the
roadmap before charging a real card on behalf of a third party.

---

## 1. Install

```bash
bun add @peable.to/sdk        # (npm/yarn work too)
```

Node 18+ (global `fetch`). Server entry is zero-runtime-dep; the browser entry
(`@peable.to/sdk/checkout`) pulls in `socket.io-client` for live status.

---

## 2. Server: create a Checkout Session (recommended for Mercaria)

A **Checkout Session** wraps exactly one payment and gives you a hosted URL to
redirect the buyer to — the least code, Stripe-Checkout parity.

```ts
import { Peable } from '@peable.to/sdk';

const peable = new Peable({
  publicKey: process.env.PEABLE_PUBLIC_KEY!, // oxy_dk_…
  secret:    process.env.PEABLE_SECRET!,     // credential secret
  // baseURL defaults to https://api.peable.to
  // oxyApiUrl defaults to https://api.oxy.so (service-token mint host)
});

// amount is in BASE UNITS (m⊜), integer string. 1 FAIR = 100_000_000 m⊜.
const session = await peable.checkout.sessions.create({
  amount:  '250000000',          // 2.5 FAIR
  network: 'testnet',            // 'testnet' | 'mainnet' — start on testnet
  metadata: { orderId: 'MERCARIA-ORDER-123' },
  successUrl: 'https://mercaria.example/checkout/success?order=123',
  cancelUrl:  'https://mercaria.example/cart',
});

// session.url  → redirect the buyer here (checkout.peable.to/c/<id>#cs=…)
// session.id, session.paymentIntentId, session.clientSecret also returned
return redirect(session.url);
```

### Own Oxy applications: shared workload transport

```ts
import { peableForOxyService } from '@peable.to/sdk';
const peable = peableForOxyService({ oxy: mySharedOxyServer });
```

The factory uses `OxyServer.createServiceClient` with Peable's registered
audience `oxy-service:6a2f851751b784a86fd0e958`. Own workloads have no payment
scopes or application consent. The gateway still resolves the merchant from
the verified application and environment and enforces all account, rail,
settlement, idempotency and business rules. The hosted payer checkout stays
anonymous.

An optional `requester: {accountId, token | taskId | requesterContext}` carries
verified account context for a person-bound call. Do not supply a user header,
persist a session bearer, or share a requester-bound client between accounts.
Call `peable.dispose()` when finished with the client.

External customer integrations retain `publicKey` + `secret` or an explicit
`tokenProvider: {getToken(), invalidate()}`. Their existing `oxy-api` audience
remains accepted with live credential/application scope checks. Own traffic
requires the exact registered audience. An external key on an official app
remains external and cannot gain own authority from branding. Only the own
factory bypasses app permission configuration, never merchant/resource rules.

That's the whole happy path: create → redirect → the hosted page shows amount +
your merchant identity + a "Pay with Peable" deep link/QR + live status, and
sends the buyer to `successUrl` on settlement. You confirm fulfillment from the
**webhook** (§4), never from the redirect alone.

### Alternative: a raw PaymentIntent (build your own UI)

```ts
const intent = await peable.paymentIntents.create(
  { amount: '250000000', network: 'testnet', metadata: { orderId: '123' } },
  { idempotencyKey: 'order-123' },   // REQUIRED — safe retries, no double-charge
);
// intent.id, intent.clientSecret, intent.address, intent.status, intent.expiresAt
await peable.paymentIntents.retrieve(intent.id);
await peable.paymentIntents.list({ status: 'settled', limit: 20 });
await peable.paymentIntents.reject(intent.id);   // cancel an unpaid intent
```

### Payment Links (shareable, reusable price)

```ts
const link = await peable.paymentLinks.create({ amount: '250000000', network: 'testnet' });
// link.url → checkout.peable.to/l/<id>, share anywhere; each visit mints a fresh intent
```

---

## 3. Frontend: two ways to collect the payment

### (A) Redirect to hosted checkout — simplest

Just `redirect(session.url)` (above). Nothing to build.

### (B) Embed the pay button inline — `@peable.to/sdk/checkout`

Pass the session's/intent's **public `clientSecret`** to the browser (never the
service secret):

```html
<div id="peable-button"></div>
<script type="module">
  import { PeableCheckout } from '@peable.to/sdk/checkout';

  const checkout = PeableCheckout.mount('#peable-button', {
    clientSecret: 'pi_…_secret_…',   // from the session/intent, safe to expose
  });
  checkout.on('confirming', () => showSpinner());
  checkout.on('settled',    () => (window.location.href = '/thank-you'));
  checkout.on('failed',     () => showError());
  checkout.on('error',      (e) => console.warn('realtime error', e));
</script>
```

The button opens `peable://pay?…` on mobile (the buyer's Peable app) or shows a
QR on desktop, and streams live status over the Gateway socket — **anonymously**,
no Oxy login required for the buyer. The `clientSecret` is a read + `submit_tx`
capability only; it can never move funds.

---

## 4. Webhooks — the source of truth for fulfillment

Point a Gateway webhook at your endpoint, then verify every delivery with the
**same** signer the Gateway uses (algorithm can't drift):

```ts
import { Peable, WEBHOOK_SIGNATURE_HEADER } from '@peable.to/sdk';

app.post('/webhooks/peable', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = peable.webhooks.constructEvent(
      req.body.toString('utf8'),               // the RAW body (not JSON-parsed)
      req.header(WEBHOOK_SIGNATURE_HEADER)!,    // 'Peable-Signature'
      process.env.PEABLE_WEBHOOK_SECRET!,      // your endpoint secret
    );
  } catch {
    return res.status(400).send('bad signature');  // throws PeableSignatureVerificationError
  }

  switch (event.type) {
    case 'payment_intent.settled':    fulfillOrder(event.data.object.metadata.orderId); break;
    case 'payment_intent.confirming': markPending(event.data.object); break;
    case 'payment_intent.failed':
    case 'payment_intent.expired':
    case 'payment_intent.rejected':   releaseHold(event.data.object); break;
  }
  res.json({ received: true });
});
```

`event.data.object` is the full `PaymentIntent` — except for
`payment_intent.disputed` and `payment_intent.dispute_closed`, which carry a
`Dispute`. `WebhookEventPayload` in `@peable.to/shared-types` is the total map
of event type to resource, so a handler written against it cannot read the
wrong shape.

Status lifecycle:
`created → (awaiting_approval → approved →) broadcast → confirming → settled`
on the chain rail, and
`created → (requires_action → processing →) settled` on the card rail, with
`refunded | partially_refunded` after settlement and terminal
`expired | rejected`.

**`failed` is not terminal on the card rail.** One declined authorization
attempt does not end a card payment: the provider returns it to a confirmable
state and the payer can try another card on the SAME payment, so
`failed → settled` is legal and you will receive `payment_intent.settled`
afterwards. Do not cancel an order on `payment_intent.failed` alone. On the
chain rail `failed` means `underpaid` and IS terminal — the rail is on the
intent, so a handler can tell them apart.

### `connected_account.updated` — the one event that is not about a payment

Its `data.object` is a `ConnectedAccount`, and its `intentId` on the delivery
log is `null`. It fires when something a marketplace ACTS on changes about a
seller — payability, either capability, the requirement counts, the disabled
reasons — and not on every refresh, because a periodic sweep re-reads every
account whether or not anything moved.

This is how you learn a seller finished onboarding. The alternatives were
polling `GET /v1/connected_accounts` or attempting a settlement and reading the
refusal.

```ts
if (event.type === 'connected_account.updated') {
  const seller = event.data.object;          // ConnectedAccount, not PaymentIntent
  if (seller.payable) enableCheckoutFor(seller.externalRef);
}
```

`payable` is a convenience, not the authority: every field it is derived from is
on the same object, and a marketplace with its own readiness policy should read
those.

### Resuming an unpaid checkout

A `PaymentIntent` deliberately carries no confirmation credential: one on that
shape would be handed out by every list and every re-read. To send a buyer back
to a payment they did not finish, ask for it explicitly:

```ts
const action = await peable.paymentIntents.clientAction(intent.id);
```

Use that rather than creating a second payment. A buyer returning the next day
to a checkout that mints a fresh intent leaves the first one alive until it
expires — two prices they can be shown and two payments they can make.

---

## 5. Amounts & networks

- **Amounts are base-unit integer strings** (`m⊜`), never floats. `1 FAIR = 100_000_000 m⊜`.
  Import `UNITS_PER_COIN` / `formatFair` from `@fairco.in/core` for display.
- **Network** is `'testnet'` or `'mainnet'`. The intent's network must match the
  merchant's registered network (the Gateway rejects a mismatch) — or, for a
  payment on behalf of a seller, the SELLER's network.
- **`expiresAt` applies only while the payer has not paid.** A FairCoin intent
  that is `broadcast` or `confirming` never expires; `canExpire` on the intent
  says which. Release stock on `payment_intent.expired`, never on the clock.

## Test vs live

The SDK **never sends a `livemode` flag**. Test vs live is decided entirely by
the **`environment`** on your service credential (`development`/`staging` → test,
`production` → live), which rides inside the minted service token. So: use a
**test-environment credential** while building; swap to a production-environment
credential to go live. Same code, different credential.

**A deployment serves ONE mode, and the Gateway enforces it.** Peable holds the
provider key, so that key's mode IS the deployment's mode, and a credential from
the other environment is refused with a `403` **before any call reaches the
acquirer** — not filtered afterwards, and not merely separated by which merchant
row it resolves. A `development` credential pointed at the live host cannot
create a live charge, open a live connected account, refund or settle. If you
see that 403, you are pointed at the wrong host for your credential.

---

## Typed errors

Every non-2xx maps to a typed error — catch what you need:

```ts
import {
  PeableError, PeableAuthenticationError, PeableInvalidRequestError,
  PeablePermissionError, PeableApiError, PeableSignatureVerificationError,
} from '@peable.to/sdk';
```

---

## Settling sellers, refunding and disputes

These namespaces are on the SDK and are **not yet exercised against the
provider's sandbox** — see the roadmap's four-state table before depending on
them in production.

```ts
await peable.connectedAccounts.create({ externalRef, country, businessType });
await peable.transfers.create({ paymentIntentId, connectedAccountRef, externalRef, amount });
await peable.transfers.reverse(transferId, { amount, externalRef });   // identity required
await peable.refunds.create({ paymentIntentId, externalRef, amount });
await peable.disputes.listForPaymentIntent(paymentIntentId);
```

Three things that are easy to get wrong and expensive:

- **`externalRef` is YOUR id and it is the idempotency**, on all three. Unlike a
  header key you cannot lose it, so a retry after a timeout converges rather
  than paying a seller — or a payer — twice. A reversal needs one too: two
  reversals of one settlement for the same amount are two operations, and an
  amount is not an identity.
- **A refund's `status` is not always `succeeded`.** A provider can report one
  `pending`, and a bank can reject it days later. Read `status`, and expect a
  later event to move it. `remainingRefundable` on the list already reserves
  pending refunds for you.
- **A transfer's `amountReversed` is CUMULATIVE**, from the provider — not the
  sum of the reversals you made, which may not be all of them.

### Responder a una disputa

```ts
await peable.disputes.submitEvidence(disputeId, {
  uncategorizedText: 'Collected in person on the 3rd.',
  shippingTrackingNumber: 'TRACK-1',
});
```

**One shot.** Submitting is one-way at the card network, so this cannot be
revised and a second call answers 200 with the dispute as it stands rather than
sending a second response. Send everything you have the first time.

Text only — **file attachments are not supported**. An unknown field name is
refused (422) rather than dropped, so a misspelling is an error now instead of a
missing argument discovered when the dispute is decided. A response after
`evidenceDueAt` is refused by the gateway (409), so you learn it was the clock
and not your request.

Peable stores **none** of the evidence. It is forwarded to the acquirer and
forgotten; `evidenceSubmittedAt` on the dispute records that you responded and
when.

### Cuánto quedó realmente — `settlement`

```ts
const s = await peable.refunds.settlement(paymentIntentId);
// { status: 'available' | 'pending' | 'unknown', gross, fee, net, currency, availableOn, exchangeRate }
```

**A missing figure is `null` with a `status`, never `0`.** `unknown` means there
is nothing to read — an uncaptured payment, a FairCoin one, a provider that
could not be reached — and treating it as zero is how a reconciliation silently
gains money that was never there.

It reports what the provider took. It does **not** say which entity bears that
cost: a fee paid by the operator of a Peable deployment is not automatically
your expense, and that decision is still open (see the roadmap). Balances,
payouts and a per-merchant journal are not implemented.

## Taxes — Peable Tax

Peable calculates tax for every rail (card, FairCoin) the way Stripe Tax does:
your owner records where the business is registered, and Peable collects only
there. Registrations and the approval live in the Peable app (Settings →
*Business tax*, `billing:manage` on the application); your server never
approves anything.

At checkout, record where the customer is and calculate:

```ts
const evidence = await peable.tax.locationEvidence.create({
  customerRef: storeId, // the billing storeId
  evidence: [
    { type: 'billing_address', address: { country: 'DE', postalCode: '10115' } },
    { type: 'ip_address', ipAddress: clientIp, country: geoCountry },
  ],
});
// evidence.status: 'sufficient' | 'insufficient' | 'conflicting'
const quote = await peable.billing.createTaxQuote({
  storeId,
  planId,
  customerLocationEvidenceId: evidence.id,
});
```

- EU and UK customers need two agreeing kinds of evidence; US and Canadian
  customers need a billing address with state/province and postal code; others
  one item. Language, currency and timezone are refused as evidence.
- Not registered where the customer is: zero tax, `collection:
  "not_registered"`, recorded. Registered but the provider cannot answer: the
  request fails (`tax_calculation_unavailable`) — never zero.
- `peable.tax.calculations.create({ currency, customerLocationEvidenceId,
  lineItems })` prices anything else (inclusive or exclusive); the answer is
  frozen and retrievable by id.
- `peable.tax.products.setTaxCode(planId, 'txcd_10103000')` sets a product tax
  code (codes: `peable.tax.listCodes()`).
- `billing.retrieveFinalInvoiceAuthority(sub, inv, { include: ['tax_lines'] })`
  returns the signed invoice with its tax lines inside the signature.
- On the card rail (`rail: 'stripe'`, configured with
  `taxQuoteAdapterRef: "peable_tax"`) pass the quote to
  `billing.createCheckoutSession({ …, taxQuote })`: Stripe Checkout charges
  exactly the quoted total, Stripe Tax stays off, and the paid invoice is
  recorded as a tax transaction (ADR 0012). A card quote stands two hours; the
  Checkout needs at least 31 minutes of it left. Each renewal is repriced by
  Peable before Stripe finalizes it, from the billing address and card country
  Stripe holds, and gets its own signed quote and tax transaction; a renewal
  Peable cannot price stays an unfinalized draft and is retried (ADR 0013).
- Refunds net out of the report: a card refund or credit note is observed and
  reversed automatically; a FairCoin sale you refund from your own wallet is
  recorded with `peable.tax.transactions.createReversal(txnId, { reference,
  amount? })` (`amount` = gross refunded; omitted = the rest). Reversals list as
  `type: 'reversal'` transactions naming the sale they reverse.
- `peable.tax.transactions.list({ from, to })` and
  `peable.tax.reports.summary({ from, to })` (or `GET
  /v1/tax/reports/summary?format=csv`) are the filing export; report rows are
  net of reversals and count them in `reversals`.

## Connect for FairCoin — paying sellers in their own wallets

The walkthrough is [Connect for FairCoin](connect-faircoin.md); the decisions are
[ADR 0012](adr/0012-faircoin-connected-accounts.md). The endpoints:

| Method + path | Auth | What |
|---|---|---|
| `POST /v1/connected_accounts` | service, `payments:write` | Open a seller. Body: `externalRef`; card half `country` + `businessType`; FairCoin half `faircoin: { network, oxyUserId }`. At least one half. Converges on `externalRef` (201 new / 200 existing) and adds a missing half. **No `xpub`** — a 422 |
| `GET /v1/connected_accounts`, `/:id`, `/by_ref/:externalRef` | service, `payments:read` | Read sellers. `rails`, `faircoin: { network, status: 'pending'\|'active', oxyUserId, registeredAt }`; the seller's `xpub` is never returned |
| `POST /v1/connected_accounts/:id/account_links` | service, `payments:write` | `{ rail: 'faircoin', returnUrl, refreshUrl }` → `{ url, expiresAt }`: Peable's own onboarding page, one use, one hour. `rail` defaults to `card` (the provider's KYC) |
| `GET /v1/connect/onboarding/:token` | **Oxy user** (the seller) | What the link asks: platform display, network, `expiresAt`, `returnUrl`. 403 for any user but the account's `oxyUserId`; 410 (with `refreshUrl`) once expired or used |
| `POST /v1/connect/onboarding/:token/faircoin` | **Oxy user** (the seller) | `{ xpub }` — the seller's watch-only ACCOUNT key. Refuses a private key / wrong network (422), a key already in use or an already-registered seller (409). Emits `connected_account.updated` |
| `POST /v1/payment_intents`, `POST /v1/checkout_sessions` | service, `payments:write` | `connectedAccount: 'ca_…'` pays that seller: FairCoin only, address from the seller's key, 409 `account_not_ready` until they register |
| `GET /v1/payment_intents?connected_account=ca_…` | service, `payments:read` | One seller's payments |

On the wire, additive and optional in the published types: `PaymentIntent.connectedAccountId`,
`PaymentIntent.canExpire`, `CheckoutSession.connectedAccountId`, `WebhookEvent.account`.
`ConnectedAccount.country` is now `string | null` (a FairCoin-only seller has
none) and `ConnectedAccount.rails` / `.faircoin` are new.

SDK: `peable.accounts` (= `connectedAccounts`), `peable.accountLinks.create({ account, rail, … })`,
`paymentIntents.create({ …, connectedAccount })`, `checkout.sessions.create({ …, connectedAccount })`,
`paymentIntents.list({ connected_account })`, and `canExpire` / `EXPIRABLE_STATUSES`.

## Mercaria integration checklist

- [ ] Owner: register Mercaria's Oxy Application + a `payments:read`/`payments:write`
      service credential (test environment) → `{ publicKey, secret }`.
- [ ] Owner: register Mercaria as a Gateway `Merchant` (watch-only xpub, testnet).
- [ ] Mercaria server: `PEABLE_PUBLIC_KEY` / `PEABLE_SECRET` / `PEABLE_WEBHOOK_SECRET` in env.
- [ ] Mercaria server: create a Checkout Session at checkout, redirect to `session.url`
      (or embed `@peable.to/sdk/checkout`).
- [ ] Mercaria server: webhook endpoint verifying `Peable-Signature`, fulfill on `settled`.
- [ ] Test the full flow on **testnet** end-to-end.
- [ ] Go live: swap to a production-environment credential + `network: 'mainnet'`
      (gated on the mainnet items — see the roadmap).
```

## Organization contribution links (FairCoin)

The `ContributionsResource` SDK uses a **human Oxy linked-client transport**, not
an application credential. Its scope is `{ organizationId, applicationId,
environment }`; Oxy must currently report an organization owner, admin or editor,
and the active application must belong to that organization. Peable stores no
membership copy. Register the application's existing watch-only FairCoin merchant
first. The merchant fixes the network; the contribution amount is always FAIR.

`create(scope, { purpose, amountMode: 'fixed', amount: '100000000', currency:
'FAIR' }, operationUuid)` creates a one-FAIR link. For `amountMode: 'free'`, omit
`amount`. Amounts are canonical positive integers in 10^-8 FAIR units. Optional
`expiresAt` is UTC. Purpose, amount policy and organization are immutable; use
`setActive` to withdraw a link. `list` / `iterate` and `collections` return only
that organization's contribution records, with bounded, scope-bound cursors.
The app's Settings → Organization contributions screen uses this SDK.

Payers open the existing anonymous `https://checkout.peable.to/l/<id>` page.
An operation UUID and exact amount are saved **before** minting an intent and
reused after lost replies or reloads. Replaying the key with a different amount
conflicts. Disabling or expiring a link refuses new attempts while permitting
recovery of an already-created attempt. No Oxy login is required at hosted
checkout; signing remains in the payer's existing wallet. The gateway only
reserves public receive addresses and observes reported transactions through the
existing Explorer/settlement watcher. It never obtains spending keys.

Collections report payment states and a `refundCapability` of
`unsupported_non_custodial`. The existing gateway cannot sign or verify FairCoin
refunds; an empty refund list does **not** mean no independent wallet transfer
occurred. This phase adds no refund-signing protocol, recurring contributions,
card processing or Stripe configuration.

Migration `0027_polite_mother_askani` is a pre-phase additive migration. It links
intents to their owning payment link, adds immutable contribution configuration
and operation keys, and keeps all existing link consumers compatible. Deploy
contracts/shared types/SDK and gateway before the new management/checkout UI.
`packages/contracts` owns the validated schemas and generates
`docs/contributions.openapi.json`; `bun run check:contribution-contracts` gates
freshness. The served `/openapi.json` currently documents this new contribution
surface, not the whole legacy gateway API.

Validation on 2026-10-15 used real PostgreSQL and HTTP, with deterministic
Explorer transaction fixtures for broadcast → confirming → settled and repeated
polls. No local FairCoin daemon/regtest binary was available. Read-only requests
to both Explorer network stats endpoints returned HTTP 403 from this environment;
no transaction was signed or broadcast, and no live chain confirmation is claimed.
The real payer-wallet/Explorer confirmation run remains an external validation
step; absence of Stripe is not a blocker for this FairCoin feature.
