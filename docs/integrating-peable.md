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
  merchant's registered network (the Gateway rejects a mismatch).

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
