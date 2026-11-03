# Integrating Peable (`@peable.to/sdk`)

A Stripe-ergonomics SDK over the Peable Gateway. **Non-custodial**: the merchant
never holds keys or funds — the buyer pays from their own self-custody Peable
wallet (or an external FairCoin wallet), and settlement is watched on-chain from
the merchant's **watch-only** xpub. Your server never sees a private key.

> **This is the guide for integrating a merchant.** Own Oxy products such as
> Mercaria use the [shared workload factory](#own-oxy-applications-shared-workload-transport);
> the application credential examples below are for external customers. Everything
> here works on **testnet** first; mainnet is a credential/config flip once the
> merchant is live (see [Test vs live](#test-vs-live)).

---

## The wire, in one paragraph

Every request and response field is `snake_case`; every instant (`created`,
`expires_at`, `available_on`, …) is an integer of **Unix seconds**; every amount
is a base-unit **string**. Lists are `{ object: 'list', data, has_more, url }`,
newest first (see [Lists, expand and metadata](#lists-expand-and-metadata)). Every
update on the merchant API is a `POST` to the object's path — there is no `PATCH`.
Every response carries a
`Request-Id` header, and every error is
`{ error: { type, code?, param?, message, request_id } }` — a well-formed but
invalid request is a `400`, never a `422`. The SDK passes your params and returns
objects exactly in that shape; only its own options stay camelCase JavaScript
(`new Peable({ publicKey, secret })`, `{ idempotencyKey }`, `toleranceSec`).
The conventions are [ADR 0014](adr/0014-orbit-api-conventions-and-versioning.md).

## Idempotency — retrying a POST safely

Every merchant `POST` accepts an optional `Idempotency-Key` header (1–255
printable ASCII characters) — ADR 0014 D3. For **24 hours**, scoped to your
merchant (application + environment; a test credential never sees a live key):

| You send | You get |
|---|---|
| the same key, method, path and body again | the **stored** status and body, with `Idempotent-Replayed: true`; nothing runs twice |
| the same key with a different body or path | `400`, `error.code === 'idempotency_error'` |
| the same key while the first request is still running | `409`, `error.code === 'idempotency_error'` — retry shortly |

A `2xx` or `4xx` answer is stored and replayed as-is. A `5xx` is **not** stored:
the key is released, so retrying with it runs the request again. Bodies are
compared canonically (key order does not matter).

The SDK sends a key on every `POST` for you — a fresh uuid per call, reused by
that call's own re-attempt. Pass `{ idempotencyKey }` yourself (one stable key
per order, e.g. `order:${order.id}`) when a retry may come from a **different**
call: after a crash, from a job queue.

The key is a request-retry layer, not a business identity. Beneath it:

- a payment intent (and so a checkout session) is unique per merchant and key
  for as long as it exists, so a retry after the 24 hours still returns the
  payment that key created (`200`), and different terms are a `400
  idempotency_error`;
- refunds, transfers and reversals take **`external_ref`** in the body, which is
  durable and decides whether money moves twice (§ Settling sellers).

Not covered: `POST /v1/merchants` (registration creates the scope a key would
live in — a retry answers `409`, recover with `GET /v1/merchants/me`), `POST
/v1/payment_intents/:id/client_action` (a read; nothing happens twice), the
`/v1/billing/*` routes (their own durable operation keys, see
[checkout operation recovery](integrations/checkout-operation-recovery.md)), and
the anonymous payer routes.

### Lists, expand and metadata

**Lists.** Every list endpoint takes the same parameters and answers the same
envelope:

| Parameter | Meaning |
|---|---|
| `limit` | 1–100, default 10 |
| `starting_after` | The id of the LAST object you saw: the next page is older |
| `ending_before` | The id of the FIRST object you saw: the page is the newer objects, still newest first. Never with `starting_after` (400, `param: 'ending_before'`) |
| `created` / `created[gt\|gte\|lt\|lte]` | Unix seconds — one second, or a range. Judged against the `created` you can see |

A cursor is resolved inside YOUR scope: an id that names nothing you own — another
merchant's included — is a 400 `resource_missing` naming the parameter, the same
answer either way. An unknown query parameter is a 400 naming it. The lists:
`/v1/payment_intents` (`status`, `connected_account`), `/v1/checkout_sessions`
(`payment_intent`), `/v1/payment_links` (`active`), `/v1/refunds`
(`payment_intent`), `/v1/transfers` (`payment_intent`, `connected_account`),
`/v1/disputes` (`payment_intent`), `/v1/connected_accounts`,
`/v1/tax/transactions` (`created` is the tax date), the per-payment
`/v1/payment_intents/:id/{refunds,transfers,disputes}` (refunds also carry
`remaining_refundable`), and the dashboard and contribution lists.

The SDK's `list()` is a promise of one page that is also an async iterable over
every page:

```ts
const page = await peable.refunds.list({ payment_intent: 'pi_…', limit: 20 });
for await (const intent of peable.paymentIntents.list({ status: 'succeeded' })) { … }
const recent = await peable.transfers.list({ created: { gte: since } }).autoPagingToArray({ limit: 500 });
```

**Expand.** A reference to another object is spelled without `_id` —
`payment_intent`, `connected_account` — and is the id string unless you ask for
the object with `expand[]` (dot paths, at most four levels; on a list, prefix
`data.`):

```ts
await peable.checkout.sessions.retrieve('cs_…', { expand: ['payment_intent.connected_account'] });
await peable.refunds.list({ expand: ['data.payment_intent'] });
```

Expandable: `payment_intent.connected_account`; `checkout_session.payment_intent`
and `.connected_account`; `refund.payment_intent`; `transfer.payment_intent` and
`.connected_account`; `dispute.payment_intent`; `settlement.payment_intent`.
Expansion resolves inside your own scope, and a path that names anything else is
a 400 with `param: 'expand'`. The payer's `client_secret` read of an intent
cannot expand. Webhook payloads always carry ids.

**Metadata.** `metadata` is your own `string → string` bag: at most 50 keys,
keys at most 40 characters (no `[` or `]`), values at most 500. On an update it
is a patch — named keys are set, a key sent as `''` is removed, others are kept —
and the 50-key limit is judged on the result. Updatable today on payment intents
(`POST /v1/payment_intents/:id`, metadata only), payment links
(`POST /v1/payment_links/:id`) and checkout sessions
(`POST /v1/checkout_sessions/:id`).

```ts
await peable.paymentIntents.update('pi_…', { metadata: { order_id: '', shipped: 'yes' } });
```

---

## 0. Prerequisites (one-time, owner/Console)

For an external customer integration:

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
calls the acquirer itself; external customers authenticate with their Oxy
application credential, while own products use their registered workload
([ADR 0009](adr/0009-peable-holds-the-provider-credentials.md)).
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

## 2. Server: create a Checkout Session

A **Checkout Session** is an ORDER — line items over your catalog, a discount,
Peable Tax, what to collect from the payer — completed on Peable's hosted page
(or embedded in yours). The payment is created when the payer CONFIRMS, with
the amount the session computed; the session completes when the PAYMENT does,
never on a browser callback. Stripe Checkout's model (Orbit Phase 3). This
example uses an external customer credential; own products construct the client
with the factory below and use the same checkout methods.

```ts
import { Peable } from '@peable.to/sdk';

const peable = new Peable({
  publicKey: process.env.PEABLE_PUBLIC_KEY!, // oxy_dk_…
  secret:    process.env.PEABLE_SECRET!,     // credential secret
});

// Amounts are BASE-UNIT strings. A FAIR order pays on the FairCoin rail, a
// EUR/USD one by card: the line items' currency decides.
const session = await peable.checkout.sessions.create({
  line_items: [
    { price: 'price_…', quantity: 2, adjustable_quantity: { enabled: true, maximum: 10 } },
    { price_data: { currency: 'FAIR', unit_amount: '50000000', product_data: { name: 'Gift wrap' } }, quantity: 1 },
  ],
  allow_promotion_codes: true,             // or discounts: [{ coupon: 'LAUNCH' }]
  billing_address_collection: 'required',
  shipping_address_collection: { allowed_countries: ['ES', 'PT'] },
  phone_number_collection: { enabled: true },
  custom_fields: [{ key: 'gift_note', label: { type: 'custom', custom: 'Gift note' }, type: 'text', optional: true }],
  consent_collection: { terms_of_service: 'required' }, // needs branding.terms_of_service_url
  automatic_tax: { enabled: true },        // Peable Tax; fails CLOSED
  customer_email: 'buyer@example.com',     // or customer: 'cus_…'
  locale: 'es',                            // en es fr de it pt, or 'auto'
  success_url: 'https://mercaria.example/done?cs={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://mercaria.example/cart', // "Back to merchant", before payment
  expires_at: Math.floor(Date.now() / 1000) + 3600, // 30 min – 24 h; default 24 h
  client_reference_id: 'MERCARIA-ORDER-123',
  metadata: { order_id: 'MERCARIA-ORDER-123' },
});

// session.url → redirect the buyer (checkout.peable.to/c/<id>#cs=<session secret>)
return redirect(session.url);
```

| Field | Meaning |
|---|---|
| `mode` | `payment` (default), `setup` (save a card for a customer — `currency` required, card only: FairCoin has no stored methods), `subscription` (validated; answers 400 `param: mode` "not available yet" until the native billing engine registers its fulfiller) |
| `status` / `payment_status` | `open` → `complete` or `expired`; `paid`, `unpaid` (a FairCoin payment broadcast and confirming, or a card authorized for manual capture), `no_payment_required` (setup, or a discount took the total to zero) |
| `amount_subtotal`, `amount_total`, `total_details` | priced by the catalog's one pricing module: tiers, `transform_quantity`, the discount (half-up percent per line; an amount off allocated in proportion), Peable Tax on the discounted lines |
| `ui_mode` | `hosted` (answers `url`) or `embedded` (answers `client_secret` for `PeableCheckout.mountCheckout`) |
| `payment_intent` / `setup_intent` | `null` until the payer confirms; expandable |

`POST /v1/checkout_sessions/:id/expire` expires an open session (its payment, if
confirmed, is cancelled first — a payment already in flight cannot be called
off). `GET /v1/checkout_sessions/:id/line_items` lists its lines (`expand[]=data.price`).
`list` filters by `payment_intent`, `payment_link`, `customer`, `status`.

**Promotion codes are reserved at confirm and counted at completion.** The
confirm that links a payment takes the code's row lock and counts the open
sessions already holding it, so two payers racing for a code's last redemption
cannot both get it; `times_redeemed` moves in one guarded statement in the
completion's transaction.

Events: `checkout.session.completed` (when the payment succeeded, was
authorized for capture, or — FairCoin — was broadcast), then
`checkout.session.async_payment_succeeded` / `async_payment_failed` when the
chain decides; `checkout.session.expired`. Fulfil on `completed` with
`payment_status: 'paid'`, or on `async_payment_succeeded`.

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
sends the buyer to `success_url` on settlement. You confirm fulfillment from the
**webhook** (§4), never from the redirect alone.

### Alternative: a raw PaymentIntent (build your own UI)

```ts
const intent = await peable.paymentIntents.create(
  { amount: '250000000', network: 'testnet', metadata: { order_id: '123' } },
  { idempotencyKey: 'order-123' },   // optional; one per order makes ANY retry converge
);
// intent.status === 'requires_action'; intent.next_action.faircoin_payment.{address, amount, uri}
// intent.faircoin.{network, address, txid, confirmations, required_confirmations}
new Date(intent.expires_at * 1000);              // instants are Unix seconds
await peable.paymentIntents.retrieve(intent.id);
await peable.paymentIntents.list({ status: 'succeeded', limit: 20 });   // one page; or `for await`
await peable.paymentIntents.update(intent.id, { metadata: { shipped: 'yes' }, description: 'Order 123' });
await peable.paymentIntents.cancel(intent.id, { cancellation_reason: 'requested_by_customer' });
```

### Card payments: customers, saved cards, confirm and capture (ADR 0019)

Card data is collected by the provider's Elements in the buyer's browser and
never reaches Peable. To save a card, create a customer and a SetupIntent; its
`client_secret` goes to the browser (`POST /v1/setup_intents/:id/client_action`
with that secret hands the provider credential to the payer's client), and when it succeeds Peable
creates the `pm_…`, attached to the customer.

```ts
const customer = await peable.customers.create({ email: 'ada@example.test' });
const setup = await peable.setupIntents.create({ customer: customer.id, usage: 'off_session' });
// …the browser completes it; `setup_intent.succeeded` + `payment_method.attached` arrive…
const [card] = (await peable.paymentMethods.list({ customer: customer.id })).data;

// Charge it later, server-side. A decline throws PeableCardError (402):
// err.paymentIntent.status === 'requires_payment_method', err.declineCode.
const paid = await peable.paymentIntents.create({
  amount: '2500', rail: 'card', currency: 'EUR',
  customer: customer.id, payment_method: card.id, confirm: true, off_session: true,
});

// Or hold the authorization and capture later (all or part):
const held = await peable.paymentIntents.create({
  amount: '5000', rail: 'card', currency: 'EUR', capture_method: 'manual',
  customer: customer.id, payment_method: card.id, confirm: true,
}); // held.status === 'requires_capture'
await peable.paymentIntents.capture(held.id, { amount_to_capture: '3000' });

// The read-only record of what was authorized and captured:
await peable.charges.retrieve(paid.latest_charge as string);
```

A confirmation that needs 3-D Secure answers `status: 'requires_action'` with
`next_action: { type: 'use_peable_sdk' }`: the buyer's client finishes it with
`@peable.to/sdk/checkout`. Card-only parameters on a FairCoin payment are a 400
naming the field.

### Catalog: products, prices, coupons, promotion codes (ADR 0018)

What you sell is an Orbit object, not a provider's: products (`prod_…`),
prices (`price_…`), coupons (your own id, or `coupon_…`) and promotion codes
(`promo_…`). Checkout line items, invoices and subscriptions will price from
them; today they are managed through the API, the SDK and Orbit's Products
screen. Every create, update and delete emits its event (`product.created`,
`price.updated`, `coupon.deleted`, `promotion_code.created`, …).

```ts
// A product with its default price, in one call.
const plus = await peable.products.create({
  name: 'Mention Plus',
  tax_code: 'txcd_10103000', // a Peable Tax code — GET /v1/tax/codes
  default_price_data: {
    currency: 'EUR', unit_amount: '499', // base units, always a string
    recurring: { interval: 'month' }, tax_behavior: 'inclusive',
  },
});

// A yearly price with a stable name you look up instead of storing its id.
await peable.prices.create({
  product: plus.id, currency: 'EUR', unit_amount: '4990',
  recurring: { interval: 'year' }, lookup_key: 'plus_yearly',
});
const [yearly] = (await peable.prices.list({ lookup_keys: ['plus_yearly'] })).data;

// Seats in packs of ten, or graduated tiers ('inf' closes the last tier).
await peable.prices.create({
  product: plus.id, currency: 'EUR', billing_scheme: 'tiered', tiers_mode: 'graduated',
  tiers: [{ up_to: 10, unit_amount: '500' }, { up_to: 'inf', unit_amount: '400' }],
  recurring: { interval: 'month' },
});

// A coupon and a customer-facing code for it.
await peable.coupons.create({ id: 'LAUNCH20', percent_off: 20, duration: 'repeating', duration_in_months: 3 });
await peable.promotionCodes.create({ coupon: 'LAUNCH20', code: 'HELLO', restrictions: { first_time_transaction: true } });
```

The rules a Stripe integrator should know:

- **A price never changes what it charges.** Only `active`, `nickname`,
  `metadata`, `lookup_key` and — while it is `unspecified` — `tax_behavior` can
  be updated; any other field is a 400 naming it. To change an amount, create a
  new price (move the `lookup_key` with `transfer_lookup_key: true`, which also
  sends `price.updated` for the price that lost it) and archive the old one.
- **Nothing is deleted that something still names.** A product with prices, or
  named by a coupon's `applies_to`, answers 400 `product_has_prices` /
  `product_in_use` — archive it with `active: false`. Prices and promotion
  codes are never deleted, only archived, so there is no `price.deleted` or
  `promotion_code.deleted`. A product's `default_price` must be one of its own
  active prices, and it cannot be archived while it is the default.
- **A coupon id names one coupon forever**: a deleted coupon's id is not reused
  (400 `resource_already_exists`), so a code or a discount naming it cannot be
  re-pointed at other terms. Only `name` and `metadata` change after creation.
- **Promotion codes are case-insensitive** and unique among your ACTIVE codes;
  omit `code` and Peable generates eight readable characters. `expires_at`
  cannot be after the coupon's `redeem_by`; `customer` restricts it to one
  `cus_…`.
- **Amounts are base-unit strings**, bounded at a billion whole units of their
  currency; `percent_off` takes at most two decimals. Discounts round half up,
  once per line, and an `amount_off` never takes a line below zero
  (`services/catalog/pricing.ts`).
- **Metered prices are refused** until meters exist (`recurring[usage_type]`).

Lists filter Stripe's way: products by `active` and `ids[]`; prices by
`product`, `active`, `type`, `currency`, `lookup_keys[]` and
`recurring[interval]`; promotion codes by `code`, `coupon`, `customer` and
`active`. `expand[]` reaches `product.default_price`, `price.product` and
`promotion_code.coupon` / `customer`.

### Payment Links (a shareable URL over your prices)

```ts
const link = await peable.paymentLinks.create({
  line_items: [{ price: 'price_…', quantity: 1, adjustable_quantity: { enabled: true, maximum: 5 } }],
  allow_promotion_codes: true,
  after_completion: { type: 'redirect', redirect: { url: 'https://shop.example/thanks?cs={CHECKOUT_SESSION_ID}' } },
  // or { type: 'hosted_confirmation', hosted_confirmation: { custom_message: 'Thanks!' } }
  restrictions: { completed_sessions: { limit: 100 } }, // deactivates itself at 100
});
// link.url → checkout.peable.to/l/<id>: share it, or show it as a QR code.
```

One-time prices of ONE currency, up to twenty. A visit creates a **Checkout
Session** with the link's lines and options (Stripe's semantics) — never a
payment; the payment exists only once the payer confirms that session, and it
carries the link (`payment_link` on the session, the intent's own link for a
contribution's collections). The lines are fixed once shared; `active`,
`metadata` and every option change with `POST /v1/payment_links/:id`
(`payment_link.updated` names the moved fields). `GET …/line_items` lists them.
Orbit → Payment Links builds them from your products (copy the URL or the QR).

---

## 3. Frontend: two ways to collect the payment

### (A) Redirect to hosted checkout — simplest

Just `redirect(session.url)` (above). Nothing to build.

### (B) Embed the pay button inline — `@peable.to/sdk/checkout`

Pass the session's/intent's **public `client_secret`** to the browser (never the
service secret):

```html
<div id="peable-button"></div>
<script type="module">
  import { PeableCheckout } from '@peable.to/sdk/checkout';

  const checkout = PeableCheckout.mount('#peable-button', {
    clientSecret: 'pi_…_secret_…',   // session.client_secret / intent.client_secret
  });
  checkout.on('processing',     () => showSpinner());
  checkout.on('succeeded',      () => (window.location.href = '/thank-you'));
  checkout.on('payment_failed', () => showError());
  checkout.on('canceled',       () => showExpired());
  checkout.on('error',      (e) => console.warn('realtime error', e));
</script>
```

The button opens `peable://pay?…` on mobile (the buyer's Peable app) or shows a
QR on desktop, and streams live status over the Gateway socket — **anonymously**,
no Oxy login required for the buyer. The `client_secret` is a read + `submit_tx`
capability only; it can never move funds. (`clientSecret` is the name of the
`mount` OPTION, a JavaScript argument; on the wire it is `client_secret`.)

---

## 4. Webhooks — the source of truth for fulfillment

Register a **webhook endpoint** — Peable generates its signing secret and shows
it ONCE, in the create response:

```ts
const endpoint = await peable.webhookEndpoints.create({
  url: 'https://shop.example/webhooks/peable',
  enabled_events: ['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled'], // or ['*']
});
// store endpoint.secret (whsec_…) as PEABLE_WEBHOOK_SECRET — it is never shown again
```

A merchant may hold up to 16 endpoints, each with its own `enabled_events` and
secret. Every event is stored once (`peable.events.list()`, kept 30 days) and
sent to each enabled endpoint whose `enabled_events` match it; a delivery that
fails is retried with backoff for about three days, and an endpoint that fails
every delivery for three days is disabled (`disabled_reason:
'delivery_failures'`, re-enable with `update(id, { disabled: false })`). The
URL must be `https` (plain `http` only in test mode), on port 443 or 80, and
name a public host. `peable.webhookDeliveries.list({ webhook_endpoint })` is
the log; `redeliver(id)` sends the same stored event again.

Verify every delivery with the **same** signer the Gateway uses (algorithm
can't drift):

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
    case 'payment_intent.succeeded':  fulfillOrder(event.data.object.metadata.order_id); break;
    case 'payment_intent.processing': markPending(event.data.object); break;
    case 'payment_intent.canceled':   releaseHold(event.data.object); break;  // see cancellation_reason
  }
  res.json({ received: true });
});
```

`event.data.object` is the full `PaymentIntent` for every `payment_intent.*`
event; `charge.refunded` carries the `Charge`, `refund.*` the `Refund`,
`charge.dispute.*` the `Dispute`, and `customer.*` / `payment_method.*` /
`setup_intent.*` their objects. `event.created` is Unix seconds. The envelope also carries
`api_version` (the wire it was stored under), `data.previous_attributes` (the
moved fields' prior values, on a change) and `request` (`{ id,
idempotency_key }` of the API call that caused it, both `null` otherwise).

**Rotating the secret without a gap:** `peable.webhookEndpoints.rollSecret(id,
{ expires_in_seconds: 3600 })` returns the new secret; for that hour every
delivery carries one `v1=` signature per secret, so deploy the new one and
`constructEvent` verifies with either — or pass both,
`constructEvent(raw, header, [newSecret, oldSecret])`. `WebhookEventPayload` in `@peable.to/shared-types` is the total map
of event type to resource, so a handler written against it cannot read the
wrong shape.

Status lifecycle — Stripe's seven (ADR 0019):
`requires_action → processing → succeeded` on the chain rail (the payer sends
coins to `next_action.faircoin_payment`; `faircoin.confirmations` counts toward
`required_confirmations`), and
`requires_payment_method → (requires_confirmation → requires_action → processing →
requires_capture →) succeeded` on the card rail. `canceled` is the other end,
with `cancellation_reason`: `abandoned` (it expired), the reason you gave
`cancel`, `automatic` (the provider), or `underpaid` (a FairCoin transaction
that paid less). Refunds are not statuses: a refunded payment stays `succeeded`
and its `amount_refunded` grows (`charge.refunded`, `refund.*`).

**`payment_intent.payment_failed` is not the end of a card payment.** One
declined attempt returns it to `requires_payment_method` with
`last_payment_error`, and the payer can try another card on the SAME payment —
you will receive `payment_intent.succeeded` afterwards. Do not cancel an order
on `payment_failed` alone; act on `canceled`. A FairCoin underpayment records
`payment_failed` and then `canceled` (`underpaid`).

### `connected_account.updated` — the one event that is not about a payment

Its `data.object` is a `ConnectedAccount`, and its `intent_id` on the
delivery log is `null`. It fires when something a marketplace ACTS on changes about a
seller — payability, either capability, the requirement counts, the disabled
reasons — and not on every refresh, because a periodic sweep re-reads every
account whether or not anything moved.

This is how you learn a seller finished onboarding. The alternatives were
polling `GET /v1/connected_accounts` or attempting a settlement and reading the
refusal.

```ts
if (event.type === 'connected_account.updated') {
  const seller = event.data.object;          // ConnectedAccount, not PaymentIntent
  if (seller.payable) enableCheckoutFor(seller.external_ref);
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

## Checkout experience — embedded checkout, Elements, branding, emails (Orbit Phase 3)

### Hosted checkout

`session.url` opens `checkout.peable.to/c/<id>`. The payer sees your branding,
the lines (with a quantity stepper where you allowed one), a promotion-code
box, the fields you asked for, the totals with tax, and then the payment step:
the card provider's own secure fields (with Apple Pay / Google Pay above them
when the provider offers them — card data never touches Peable) or the FairCoin
deep link / QR. It speaks `en es fr de it pt` (`locale`, else the browser's
language). It redirects to `success_url` only after the gateway says the session
is `complete`; until then it shows what is true ("confirming"), and an expired
session says so.

### Embedded checkout

Create the session with `ui_mode: 'embedded'` and hand its `client_secret` to
the browser:

```ts
import { PeableCheckout } from '@peable.to/sdk/checkout';

const checkout = PeableCheckout.mountCheckout('#checkout', {
  clientSecret,                       // cs_…_secret_…
  appearance: { theme: 'flat', variables: { colorPrimary: '#0a7d33' } },
  onComplete: ({ sessionId, successUrl }) => router.push(`/thanks?cs=${sessionId}`),
});
```

The same experience runs in an iframe from `checkout.peable.to`. The frame and
your page talk over `postMessage`, each checking the other's origin AND window;
the client secret travels in the frame URL's fragment, never to a server log.
`complete` is posted only after the gateway says so — re-read the session on
your server before fulfilling anyway.

### Elements and `appearance`

```ts
import { createPeableElements } from '@peable.to/sdk/checkout';

const elements = createPeableElements({
  paymentIntent: { id, client_secret },          // or a setupIntent
  appearance: { theme: 'peable', variables: { borderRadius: '12px' }, rules: { '.Input': { borderColor: '#d0d7de' } } },
  locale: 'fr',
});
elements.create('expressCheckout').mount('#wallets');
elements.create('payment').mount('#payment');
const result = await elements.confirmPayment({ paymentIntent: { id, client_secret }, return_url: location.href });
```

`appearance` (`theme` `peable|night|flat`, `variables` `colorPrimary`,
`colorBackground`, `colorText`, `colorDanger`, `fontFamily`, `borderRadius`,
`spacingUnit`, and `rules` for a fixed set of selectors) styles Peable's chrome
AND is passed to the provider's Elements; unknown or unsafe values are dropped.
`confirmPayment` / `confirmSetup` confirm with the provider and then wait for
the GATEWAY's status (socket, with a poll fallback) — they resolve from
Peable's word, never from the provider's callback alone.

### Branding

`GET|POST /v1/merchants/me/branding` (Orbit → Branding, with a live preview):

| Field | |
|---|---|
| `use_avatar_as_icon` | the square icon is your avatar |
| `logo` | a `file_…` of purpose `business_logo` (Files API) — the same field as `POST /v1/merchants/me {business_logo}` |
| `primary_color`, `accent_color` | `#rrggbb` |
| `font` | `system inter roboto open_sans lato source_sans noto_sans serif monospace` — system stacks, no remote font is ever loaded |
| `border_style` | `rounded rectangular pill` |
| `terms_of_service_url` | `https://…`, needed before asking for terms acceptance |

It applies to hosted and embedded checkout and to Peable's emails.

### Customer emails

`GET|POST /v1/merchants/me/email_settings`: `payment_receipts` (default on),
`refund_notices` (on), `checkout_confirmations` (off), `support_email` (the
reply-to). A receipt goes to the payment's `receipt_email` — a checkout session
sets it from the email the payer gave — with your branding, the lines, the
amount, the date, the rail and a receipt number from your own sequence
(`R-000042`). Nothing else: no address, no card or FairCoin details, no
secrets. Emails are owed in the transaction of the change they report and sent
afterwards through Oxy's outbound mail relay; a receipt not sent within three
days is dropped rather than sent late.

---

## 5. Amounts & networks

- **Amounts are base-unit integer strings** (`m⊜`), never floats. `1 FAIR = 100_000_000 m⊜`.
  Import `UNITS_PER_COIN` / `formatFair` from `@fairco.in/core` for display.
- **Network** is `'testnet'` or `'mainnet'`. The intent's network must match the
  merchant's registered network (the Gateway rejects a mismatch) — or, for a
  payment on behalf of a seller, the SELLER's network.
- **`expires_at` applies only while the payer has not paid.** A FairCoin intent
  that is `processing` never expires, nor does an authorization held for
  capture; `can_expire` on the intent says which. Release stock on
  `payment_intent.canceled` (`cancellation_reason: 'abandoned'`), never on the
  clock.

## Test vs live

The SDK **never sends a `livemode` flag**. Test vs live is decided entirely by
the **`environment`** on your service credential (`development`/`staging` → test,
`production` → live), which rides inside the minted service token. So: use a
**test-environment credential** while building; swap to a production-environment
credential to go live. Same code, different credential.

**One host serves both modes, and your credential picks one** (ADR 0017). Peable
holds a test provider key and a live one side by side; a `production` credential's
payments, refunds, transfers and connected accounts go through the live key, every
other environment's through the test key, and an operation on an existing object
always uses the key that created it. Nothing you send can choose the other one.
Every object you get back — and every webhook event envelope — carries
`livemode: true | false` so you can tell which world it belongs to. If the mode
your credential selects is not configured on the deployment, card operations
answer `503` like any unavailable rail.

---

## Local development

Everything below is **test mode only**: a `production` (live) credential is
refused with `403 permission_error`, code `test_mode_only`.

### The CLI — `@peable.to/cli`

```sh
npm i -g @peable.to/cli        # or: bunx @peable.to/cli … (once published; see packages/cli/README.md)
peable login                   # a test-environment application credential
peable listen --forward-to http://localhost:3000/webhooks
peable trigger payment_intent.succeeded
peable logs tail
```

- **`peable listen`** streams every event your test merchant records, as it
  commits, and POSTs each one to `--forward-to`, signed with a `whsec_…` it
  prints for the session — the same `Peable-Signature` algorithm as a real
  delivery, so `peable.webhooks.constructEvent(rawBody, header, secret)` works
  unchanged. No public URL and no registered endpoint are needed (a webhook
  endpoint must be reachable from the internet; `listen` is how localhost gets
  events). It reads `GET /v1/events/stream`, a Server-Sent Events stream fed
  from the same transaction that stores each event, never a rolled-back one;
  the SDK exposes it as `peable.events.stream()`.
- **`peable trigger <event>`** creates real test objects through the API that
  cause the event (`peable trigger` lists them).
- **`peable logs tail`** prints your requests as they are answered — method,
  path, status, duration, `Idempotency-Key`, never a body or header. The same
  log is `GET /v1/request_logs` (30 days, filters `status` = `404` or `4xx`,
  `method`, `created`) and `peable.requestLogs`, and Orbit shows it.

`packages/cli/README.md` has every command.

### Test helpers — `/v1/test_helpers/*`

They move a test object the way the outside world would, through the gateway's
real state machine — the same transitions, events and webhooks as a real
payment:

| Route | SDK | What it does |
|---|---|---|
| `POST /v1/test_helpers/payment_intents/:id/simulate_faircoin_payment` `{ outcome?: 'settled' \| 'underpaid' }` | `testHelpers.paymentIntents.simulateFaircoinPayment` | A FairCoin payer broadcasts (`processing`, with a synthetic txid) and the chain confirms it (`succeeded`) — or underpays it (`canceled`, `cancellation_reason: 'underpaid'`, with `payment_intent.payment_failed` then `payment_intent.canceled`). **It does not touch the chain**: nothing is broadcast and the txid names no transaction. |
| `POST /v1/test_helpers/checkout_sessions/:id/expire` | `testHelpers.checkoutSessions.expire` | The session's clock runs out now: its payment is `canceled` as `abandoned` (`payment_intent.canceled`), a card one cancelled at the provider first, exactly as the expiry sweep does. A payment already `processing` or finished cannot expire (409). |

Both take `Idempotency-Key` like every merchant `POST`.

### Test data

- **FairCoin:** a test merchant is on **testnet** (a non-production merchant
  cannot register a mainnet key). Pay a test intent from a testnet wallet to
  its `faircoin.address`, or finish it with `simulate_faircoin_payment`.
  Amounts are base units: 1 FAIR is `"100000000"`.
- **Cards:** test-mode card payments run on the provider's test environment, so
  its documented test card numbers apply — successful payments, declines and
  3-D Secure challenges: <https://docs.stripe.com/testing>. Enter them in the
  hosted checkout or your own provider fields; a live card is refused in test
  mode by the provider.

---

## Typed errors

Every non-2xx maps to a typed error — catch what you need:

```ts
import {
  PeableError, PeableAuthenticationError, PeableInvalidRequestError,
  PeablePermissionError, PeableApiError, PeableSignatureVerificationError,
} from '@peable.to/sdk';

try {
  await peable.refunds.create({ payment_intent, external_ref, amount: '0' });
} catch (err) {
  if (err instanceof PeableInvalidRequestError) {
    err.statusCode; // 400
    err.code;       // 'parameter_invalid' — the specific reason, else the broad type
    err.param;      // 'amount' — the offending field, in bracket notation
    err.requestId;  // the response's Request-Id; quote it to Peable support
  }
}
```

The gateway answers
`{ "error": { "type": "invalid_request_error", "code": "parameter_invalid", "param": "amount", "message": "…", "request_id": "req_…" } }`;
`err.requestId` falls back to the `Request-Id` header when a refusal comes from
the Oxy auth layer, whose body has no `request_id`.

---

## Settling sellers, refunding and disputes

These namespaces are on the SDK and are **not yet exercised against the
provider's sandbox** — see the roadmap's four-state table before depending on
them in production.

```ts
await peable.connectedAccounts.create({ external_ref, country, business_type });
await peable.transfers.create({ payment_intent, connected_account_ref, external_ref, amount });
await peable.transfers.reverse(transferId, { amount, external_ref });   // identity required
await peable.refunds.create({ payment_intent, external_ref, amount, reason, metadata });
await peable.refunds.update('re_…', { metadata });   // and .cancel('re_…') where the provider allows
await peable.refunds.list({ payment_intent });           // or .retrieve('re_…')
await peable.transfers.list({ connected_account });      // or .retrieve('tr_…')
await peable.disputes.list({ payment_intent });          // or .retrieve('dp_…')
```

Three things that are easy to get wrong and expensive:

- **`external_ref` is YOUR id and it is the idempotency**, on all three. Unlike a
  header key you cannot lose it, so a retry after a timeout converges rather
  than paying a seller — or a payer — twice. A reversal needs one too, in the
  body (the `Idempotency-Key` header is not accepted in its place): two
  reversals of one settlement for the same amount are two operations, and an
  amount is not an identity.
- **A refund's `status` is not always `succeeded`.** A provider can report one
  `pending`, and a bank can reject it days later. Read `status`, and expect a
  later event to move it. `remaining_refundable` on the list already reserves
  pending refunds for you.
- **A transfer's `amount_reversed` is CUMULATIVE**, from the provider — not the
  sum of the reversals you made, which may not be all of them.

### Answering a dispute

```ts
// 1. Upload what you have (PDF, PNG or JPEG, at most 5 MB each).
const receipt = await peable.files.create({ purpose: 'dispute_evidence', file: pdfBytes, filename: 'receipt.pdf' });

// 2. Stage a draft — as often as you like, until you submit.
await peable.disputes.update(disputeId, {
  evidence: { receipt: receipt.id, uncategorized_text: 'Collected in person on the 3rd.' },
});

// 3. Submit — ONCE.
await peable.disputes.update(disputeId, { evidence: { shipping_tracking_number: 'TRACK-1' }, submit: true });

// Or accept it: the dispute is lost, and nothing more can be submitted.
await peable.disputes.close(disputeId);
```

**A draft lives at the provider, not here.** `submit` omitted (or `false`)
forwards the text to the provider's own draft; Peable records only that
evidence exists (`evidence_details.has_evidence`). `retrieve` reads the draft
back live — `evidence` is on `retrieve` and on the answers of `update` and
`close`, never on a list item or a webhook event. An empty string unsets a
field.

**Files are attached by id**, a `file_…` of purpose `dispute_evidence` that you
uploaded. Their bytes go to the provider when you submit, and only then; the
combined files of one response are at most 5 MB.

**One shot.** `submit: true` is one-way at the card network: a second
submission — or a draft after one — answers **409** `dispute_already_submitted`
and sends nothing. A retry under the same `Idempotency-Key` replays the first
answer. A response after `evidence_details.due_by` is refused (409), so you learn
it was the clock and not your request; an unknown field name is a 400 naming it.

Peable stores **none** of the evidence text. `evidence_details.submitted_at`
records that you responded and when.

### Files

`peable.files.create({ purpose, file })` uploads bytes (`multipart/form-data`);
`peable.files.create({ purpose: 'business_logo', oxy_file })` makes an Oxy file
you own your logo. The type is read from the bytes:

| Purpose | Types | Max |
|---|---|---|
| `dispute_evidence` | PDF, PNG, JPEG | 5 MB |
| `business_logo` | PNG, JPEG | 512 KB |
| `identity_document` | PDF, PNG, JPEG | 10 MB |
| `additional_verification` | PDF, PNG, JPEG | 10 MB |

Only an available `business_logo` has a `url`. `status` is `available`,
`withheld` (its owner hid it; it can come back) or `removed` (deleted or taken
down). Set the logo with `peable.merchants.update({ business_logo: file.id })`:
it is the wordmark the hosted checkout shows, beside your avatar (the square
icon), not instead of it.

### Payment methods and wallets

Card-rail payments offer what your **payment method configuration** offers in
the payment's currency: cards, Apple Pay and Google Pay are on by default;
SEPA Debit, iDEAL, Bancontact and EPS (EUR only) are yours to turn on. Every
method says whether it is `available` and, when not, why (`unavailable_reason`:
`provider_unsupported` — Bizum today — or `requires_card` for a wallet with
cards off).

```ts
const [config] = (await peable.paymentMethodConfigurations.list()).data; // the default
await peable.paymentMethodConfigurations.update(config.id, {
  sepa_debit: { display_preference: { preference: 'on' } },
});
// Or name the methods of one payment exactly:
await peable.paymentIntents.create({ amount: '1500', rail: 'card', currency: 'EUR', payment_method_types: ['card', 'ideal'] });
```

A PaymentIntent keeps the `payment_method_types` it was created with. SEPA Debit
stays `processing` for days; wait for `payment_intent.succeeded`, never a
browser callback. To run Apple Pay and Google Pay on **your own** pages,
register each domain: `peable.paymentMethodDomains.create({ domain_name:
'shop.example.com' })`, serve the wallet's domain association file, then
`validate(id)`. The hosted checkout's domain is Peable's and needs nothing.

Card currencies: EUR, USD, GBP, CHF, SEK, NOK, DKK, PLN, CZK, CAD, AUD and JPY.
Amounts are base-unit strings in each currency's ISO 4217 minor unit — JPY has
none, so `'1500'` is ¥1,500 (`CURRENCY_DECIMALS`).

### What you actually kept — `settlement`

```ts
const s = await peable.refunds.settlement(paymentIntentId);
// { status: 'available' | 'pending' | 'unknown', gross, fee, net, currency, available_on, exchange_rate }
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
  customer_ref: storeId, // the billing store_id
  evidence: [
    { type: 'billing_address', address: { country: 'DE', postal_code: '10115' } },
    { type: 'ip_address', ip_address: clientIp, country: geoCountry },
  ],
});
// evidence.status: 'sufficient' | 'insufficient' | 'conflicting'
const quote = await peable.billing.createTaxQuote({
  store_id: storeId,
  plan_id: planId,
  customer_location_evidence_id: evidence.id,
});
// quote.schema_version === 2; quote.quote.expires_at is Unix seconds
```

- EU and UK customers need two agreeing kinds of evidence; US and Canadian
  customers need a billing address with state/province and postal code; others
  one item. Language, currency and timezone are refused as evidence.
- Not registered where the customer is: zero tax, `collection:
  "not_registered"`, recorded. Registered but the provider cannot answer: the
  request fails (`tax_calculation_unavailable`) — never zero.
- `peable.tax.calculations.create({ currency, customer_location_evidence_id,
  line_items })` prices anything else (inclusive or exclusive); the answer is
  frozen and retrievable by id.
- `peable.tax.products.setTaxCode(planId, 'txcd_10103000')` sets a product tax
  code (codes: `peable.tax.listCodes()`).
- `billing.retrieveFinalInvoiceAuthority(sub, inv, { include: ['tax_lines'] })`
  returns the signed invoice with its tax lines inside the signature.
- On the card rail (`rail: 'stripe'`, configured with
  `taxQuoteAdapterRef: "peable_tax"`) pass the quote to
  `billing.createCheckoutSession({ …, tax_quote })`: Stripe Checkout charges
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
- `peable.tax.transactions.list({ created: { gte, lt } })` lists transactions
  newest first like every list (`created` filters the tax date, `committed_at`),
  and `peable.tax.reports.summary({ from, to })` (`from` inclusive, `to`
  exclusive, both Unix seconds; or `GET /v1/tax/reports/summary?format=csv`) is
  the filing export; report rows are net of reversals and count them in
  `reversals`.

## Connect & money — your account, balance, payouts and fees (ADR 0015)

Orbit never holds your money. Card funds stay at the acquirer, in **your own
provider account**, opened and onboarded through Peable; Orbit instructs the
provider and mirrors what happened. Identity documents are collected by the
provider's hosted onboarding and never reach Peable.

```ts
// 1. Open your account (once), then send yourself through onboarding.
await peable.account.update({ country: 'ES', business_type: 'company' });   // 201 the first time
const link = await peable.accountLinks.create({                              // POST /v1/account_links
  refresh_url: 'https://you.example/account?refresh=1',
  return_url: 'https://you.example/account',
});
// redirect to link.url; readiness arrives as `account.updated`
const account = await peable.account.retrieve();   // charges_enabled, payouts_enabled, requirements, settings

// 2. Settings live at the provider and are read back.
await peable.account.update({
  settings: { payouts: { schedule: { interval: 'manual' } }, payments: { statement_descriptor: 'MY SHOP' } },
});

// 3. Your balance and every movement, mirrored from the provider.
await peable.balance.retrieve();                     // { available, pending, informational }
await peable.balanceTransactions.list({ type: 'payment', payout: 'po_…' });

// 4. Payouts — scheduled by the provider, or instructed on a manual schedule.
await peable.payouts.create({ amount: '5000', currency: 'EUR' });
await peable.payouts.list({ status: 'paid' });
await peable.reports.payoutReconciliation({ payout: 'po_…' });   // the transactions it paid out

// 5. Orbit's fee on each charge, and its refunds.
await peable.applicationFees.list({ payment_intent: 'pi_…' });
```

**Which charge your card payments are.** Decided once when the intent is
created and visible on it (`transfer_data`, `on_behalf_of`,
`application_fee_amount`):

| You are | Charge | Merchant of record | Fee |
|---|---|---|---|
| an Oxy product (verified first-party workload) | platform charge | Oxy | none |
| a merchant with an onboarded account | destination charge `on_behalf_of` your account | you — your descriptor, your chargebacks | your fee schedule |
| a marketplace without an own account | platform charge + separate transfers to sellers | the platform (ADR 0009, open) | none |
| a platform naming `transfer_data` / `on_behalf_of` for its seller | destination charge to that seller | the seller with `on_behalf_of` | the `application_fee_amount` you send |

A merchant that opened an account but has not finished onboarding is refused
card payments (409 `account_not_ready`) rather than silently charged as the
platform. Refunds of a destination charge can also refund the fee
(`refund_application_fee`) and pull the funds back (`reverse_transfer`).

**`Peable-Account: ca_…`** lets a platform act on one of its connected
accounts (Stripe's `Stripe-Account`), on exactly these routes:
`/v1/account`, `/v1/account_links`, `/v1/balance`, `/v1/balance_transactions`,
`/v1/payouts` and `/v1/reports/payout_reconciliation` (SDK: `{ peableAccount }`
in the request options). Any other route answers 400 naming the header — a
payment's destination is a body field (`transfer_data`), never a header.

Rules that are easy to get wrong:

- **No account, no balance.** Without an account `GET /v1/balance` is 404
  `account_missing`; Orbit never shows zeros it does not have.
- **A figure the provider did not give is `null`, not `0`.** Balance
  transactions are the provider's own, verbatim; amounts are signed strings.
- **FairCoin is informational.** A succeeded FairCoin payment is recorded under
  `informational` (it is in your wallet already); it is never payable and no
  payout draws on it.
- **Live payments for third parties are gated.** Until ADR 0015's legal release
  gate is signed off, a deployment answers 403 `live_payments_gated` to a
  non-Oxy merchant opening a live account, taking a live destination charge or
  instructing a live payout (`ORBIT_THIRD_PARTY_LIVE_PAYMENTS`). Test mode is
  always open.
- **Events:** `account.updated`, `application_fee.created|refunded`,
  `payout.created|updated|paid|failed|canceled`, `balance.available`.

## Connect for FairCoin — paying sellers in their own wallets

The walkthrough is [Connect for FairCoin](connect-faircoin.md); the decisions are
[ADR 0012](adr/0012-faircoin-connected-accounts.md). The endpoints:

| Method + path | Auth | What |
|---|---|---|
| `POST /v1/connected_accounts` | service, `payments:write` | Open a seller. Body: `external_ref`; card half `country` + `business_type`; FairCoin half `faircoin: { network, oxy_user_id }`. At least one half. Converges on `external_ref` (201 new / 200 existing) and adds a missing half. **No `xpub`** — a 400 |
| `GET /v1/connected_accounts`, `/:id`, `/by_ref/:external_ref` | service, `payments:read` | Read sellers. `rails`, `faircoin: { network, status: 'pending'\|'active', oxy_user_id, registered_at }`; the seller's `xpub` is never returned |
| `POST /v1/connected_accounts/:id/account_links` | service, `payments:write` | `{ rail: 'faircoin', return_url, refresh_url }` → `{ object: 'account_link', url, expires_at }`: Peable's own onboarding page, one use, one hour. `rail` defaults to `card` (the provider's KYC) |
| `GET /v1/connect/onboarding/:token` | **Oxy user** (the seller) | What the link asks: platform display, network, `expires_at`, `return_url`. 403 for any user but the account's `oxy_user_id`; 410 (with `error.refresh_url`) once expired or used |
| `POST /v1/connect/onboarding/:token/faircoin` | **Oxy user** (the seller) | `{ xpub }` — the seller's watch-only ACCOUNT key. Refuses a private key / wrong network (400 `watch_only_violation`), a key already in use or an already-registered seller (409). Emits `connected_account.updated` |
| `POST /v1/payment_intents`, `POST /v1/checkout_sessions` | service, `payments:write` | `connected_account: 'ca_…'` pays that seller: FairCoin only, address from the seller's key, 409 `account_not_ready` until they register |
| `GET /v1/payment_intents?connected_account=ca_…` | service, `payments:read` | One seller's payments |

On the wire: `PaymentIntent.connected_account` and `CheckoutSession.connected_account`
(the `ca_…`, `null` for a payment to the merchant itself, the object when
expanded); optional in the published types: `PaymentIntent.can_expire`,
`WebhookEvent.account`.
`ConnectedAccount.country` is now `string | null` (a FairCoin-only seller has
none) and `ConnectedAccount.rails` / `.faircoin` are new.

SDK: `peable.accounts` (= `connectedAccounts`), `peable.accountLinks.create({ account, rail, … })`,
`paymentIntents.create({ …, connected_account })`, `checkout.sessions.create({ …, connected_account })`,
`paymentIntents.list({ connected_account })`, and `can_expire` / `EXPIRABLE_STATUSES`.

## Mercaria integration checklist

- [ ] Owner: register Mercaria's Oxy Application + a `payments:read`/`payments:write`
      service credential (test environment) → `{ publicKey, secret }`.
- [ ] Owner: register Mercaria as a Gateway `Merchant` (watch-only xpub, testnet).
- [ ] Mercaria server: `PEABLE_PUBLIC_KEY` / `PEABLE_SECRET` / `PEABLE_WEBHOOK_SECRET` in env.
- [ ] Mercaria server: create a Checkout Session at checkout, redirect to `session.url`
      (or embed `@peable.to/sdk/checkout`).
- [ ] Mercaria server: register a webhook endpoint (`peable.webhookEndpoints.create`), store its
      `secret`, verify `Peable-Signature` on every delivery, fulfill on `payment_intent.succeeded`.
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

`create(scope, { purpose, amount_mode: 'fixed', amount: '100000000', currency:
'FAIR' }, operationUuid)` creates a one-FAIR link. For `amount_mode: 'free'`, omit
`amount`. Amounts are canonical positive integers in 10^-8 FAIR units. Optional
`expires_at` is Unix seconds. Purpose, amount policy and organization are
immutable; use `setActive` to withdraw a link. `list` and `collections` return
only that organization's contribution records as `{ object: 'list', data,
has_more, url }`, newest first, with the [list parameters](#lists-expand-and-metadata)
(`limit`, `starting_after`/`ending_before`, `created`); iterating the returned
list (`for await`) walks every page. `setActive` is a `POST`.
The app's Settings → Organization contributions screen uses this SDK.

Payers open the existing anonymous `https://checkout.peable.to/l/<id>` page.
Since Orbit Phase 3 a contribution link is a payment link whose one line is the
contribution: the visit starts a Checkout Session (`POST
/v1/payment_links/:id/checkout_sessions`, the payer's amount for a free one) and
the payment is created when the donor confirms it. An operation UUID and exact
amount are saved **before** starting the session and reused after lost replies
or reloads (`Idempotency-Key`: the same key returns the same session). Replaying the key with a different amount
conflicts. Disabling or expiring a link refuses new attempts while permitting
recovery of an already-created attempt. No Oxy login is required at hosted
checkout; signing remains in the payer's existing wallet. The gateway only
reserves public receive addresses and observes reported transactions through the
existing Explorer/settlement watcher. It never obtains spending keys.

Collections report payment states and a `refund_capability` of
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
Explorer transaction fixtures for the then `broadcast → confirming → settled` (now `processing → succeeded`) and repeated
polls. No local FairCoin daemon/regtest binary was available. Read-only requests
to both Explorer network stats endpoints returned HTTP 403 from this environment;
no transaction was signed or broadcast, and no live chain confirmation is claimed.
The real payer-wallet/Explorer confirmation run remains an external validation
step; absence of Stripe is not a blocker for this FairCoin feature.
