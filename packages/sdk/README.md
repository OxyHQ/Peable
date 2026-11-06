# @peable.to/sdk

The Peable server SDK. Its resource methods are **generated from the API
contracts** (`@peable.to/contracts`, ADR 0014 D5): every parameter and return
type is the route's own `BodyOf` / `QueryOf` / `ResponseOf`, so a field the
gateway renames is a compile error in your code, not a runtime 400.

```ts
import { Peable } from '@peable.to/sdk';

const peable = new Peable({ publicKey: process.env.OXY_PUBLIC_KEY!, secret: process.env.OXY_SECRET! });

const customer = await peable.customers.create({ email: 'jenny@example.com', name: 'Jenny Rosen' });
await peable.customers.update(customer.id, { metadata: { order_id: '6735' } });
for await (const method of peable.paymentMethods.list({ customer: customer.id })) {
  console.log(method.card.last4);
}
```

### Every method has one shape

`resource.method(...pathParams, params?, options?)`: the path parameters as
leading strings in path order, then `params` — the body of a write, the query
of a read; optional exactly when nothing in it is required — then the request
options. What comes back depends on the route:

| Route answers | The method returns |
|---|---|
| an object | `Promise<Object>` |
| a list (`{ object: 'list' }`) | a page promise that is also an async iterable over every item, with `autoPagingEach` and `autoPagingToArray({ limit })` |
| a search (`{ object: 'search_result' }`) | the same, paging forward over `next_page` |
| bytes | `Promise<{ bytes, contentType, filename }>` |
| a live tail (Server-Sent Events) | an async iterable that reconnects and resumes on its own |

A route that uploads (`multipart/form-data`) takes the bytes as a `Blob`,
`Uint8Array` or `ArrayBuffer` in `params` and sends them as a form.

### Retries, timeouts, idempotency, version, account

| Option | Client default | Per request |
|---|---|---|
| `maxNetworkRetries` | `2` | yes |
| `timeout` (ms, each attempt, headers and body) | `80_000` | yes |
| `apiVersion` (`Peable-Version`) | `PEABLE_API_VERSION` | yes |
| `peableAccount` (`Peable-Account: ca_…`) | none | on routes that accept it |
| `idempotencyKey` | a fresh uuid per call | on every `POST` |
| `signal` | — | yes |

A request that fails on the network, times out, or is answered 5xx, 429 or
409 `idempotency_error` (its first attempt still running) is retried with
exponential backoff (0.5 s doubling to 8 s, jittered) and never sooner than
`Retry-After` (honoured up to 60 s). Every attempt of a `POST` carries the
SAME `Idempotency-Key`, so the gateway runs it once and answers later attempts
with the stored response. Any other 4xx is never retried. A 401 is re-attempted
once with a freshly minted token, outside the retry count.

The client's `peableAccount` is sent only on the routes that accept the header
(the gateway refuses it elsewhere), which the generated method types say: a
method whose route does not accept it has no `peableAccount` option.

### Errors: one class per `error.type`

| Class | `type` | Typically |
|---|---|---|
| `PeableInvalidRequestError` | `invalid_request_error` | 400, 404, 409 |
| `PeableAuthenticationError` | `authentication_error` | 401 |
| `PeableCardError` | `card_error` | 402 — `declineCode`, `paymentIntent` |
| `PeablePermissionError` | `permission_error` | 403 |
| `PeableIdempotencyError` | `idempotency_error` | 400 (key reused), 409 (in flight) |
| `PeableRateLimitError` | `rate_limit_error` | 429 |
| `PeableAPIError` | `api_error` | 5xx, or `code: 'invalid_response'` |
| `PeableConnectionError` | `api_connection_error` | no answer: network, `code: 'timeout'`, `code: 'response_interrupted'` |
| `PeableSignatureVerificationError` | `signature_verification_error` | `webhooks.constructEvent` |

Each carries `statusCode`, `type`, `code`, `declineCode`, `param`, `message`,
`docUrl`, `requestId` (the body's `request_id`, else the `Request-Id` header)
and `raw` (the parsed body, or the underlying failure).

### Entries

- `@peable.to/sdk` — this server client (Node built-ins; never bundle it in a browser).
- `@peable.to/sdk/checkout` — the anonymous payer-side browser client and Elements.
- `@peable.to/sdk/checkout/ui` — the optional Bloom checkout sheet (React,
  React Native and `@oxy.so/bloom` are optional peers; never reachable from the
  other entries).
- `@peable.to/sdk/display` — read-only display rates; imports nothing else.

### The wire: snake_case, Unix seconds, one error envelope

Request parameters and returned objects are exactly the gateway's wire
(ADR 0014): `snake_case` field names, every instant an integer of **Unix
seconds**, amounts as base-unit strings. Only SDK options stay camelCase
JavaScript — constructor config and request options (`{ idempotencyKey }`):

```ts
const intent = await peable.paymentIntents.create(
  { amount: '1999', rail: 'card', currency: 'EUR', metadata: { order_id: order.id } },
  { idempotencyKey: `order:${order.id}` },
);
new Date(intent.created * 1000); // Unix seconds, not an ISO string
```

Every failure is a typed `PeableError` (above) built from
`{ error: { type, code?, param?, message, request_id } }`: `err.code` is the
specific reason (`account_not_ready`, `parameter_invalid`, …), `err.param` the
offending field in bracket notation (`metadata[order_id]`), and `err.requestId`
the response's `Request-Id` — quote it to Peable support. A request that is
well-formed JSON but invalid is a 400, never a 422.

### Webhooks: endpoints, events, deliveries

An event (`evt_…`) is stored once, in the same transaction as the change it
records, and kept 30 days (`peable.events.list({ type: 'payment_intent.*' })`).
Each enabled webhook endpoint whose `enabled_events` match it receives one
delivery, retried for about three days; an endpoint that fails every delivery
for three days is disabled with `disabled_reason: 'delivery_failures'`.

```ts
const endpoint = await peable.webhookEndpoints.create({
  url: 'https://shop.example/webhooks/peable',
  enabled_events: ['payment_intent.succeeded'], // or ['*']
});
endpoint.secret; // whsec_… — returned only here and by rollSecret; store it

// In the handler, with the RAW body (a Buffer, Uint8Array or string), and an
// optional replay tolerance in seconds (default 300):
const event = peable.webhooks.constructEvent(rawBody, req.header(WEBHOOK_SIGNATURE_HEADER), secret);
event.request; // { id, idempotency_key } of the API call that caused it, or nulls

// Rotation without a gap: for an hour every delivery is signed with both secrets.
const rolled = await peable.webhookEndpoints.rollSecret(endpoint.id, { expires_in_seconds: 3600 });
peable.webhooks.constructEvent(rawBody, header, [rolled.secret!, secret]);

for await (const delivery of peable.webhookDeliveries.list({ webhook_endpoint: endpoint.id })) {
  if (delivery.last_status === 'dead') await peable.webhookDeliveries.redeliver(delivery.id);
}
```

A merchant has no `webhook_url` any more: the endpoints are the only place
events are sent.

### Idempotency: every POST, automatically

Every `POST` the client sends carries an `Idempotency-Key` (ADR 0014 D3). When
you pass none, the client mints a uuid for that call and reuses it for every
retry of it, so a retried call never runs twice. Pass your own — one
stable key per order — to make a retry from ANOTHER call (after a crash, from a
job queue) converge too:

```ts
await peable.checkout.sessions.create(params, { idempotencyKey: `checkout:${order.id}` });
```

Within 24 hours, per merchant (application + environment), the gateway answers:

- same key, same request → the stored response, with `Idempotent-Replayed: true`;
- same key, different request → `PeableIdempotencyError` (400), never retried;
- same key while the first is still running → 409 `idempotency_error`, retried
  automatically until the first answers (then `PeableIdempotencyError`).

A 5xx is never stored, so retrying it with the same key runs it again. The
key is a request-retry layer, not a business identity: refunds, transfers and
reversals still take `external_ref`, which is durable and decides whether money
moves twice.

### Lists, auto-pagination, `expand` and metadata

Every `list()` takes `limit` (1–100, default 10), `starting_after` or
`ending_before`, `created` (Unix seconds, or `{ gt, gte, lt, lte }`) and the
resource's own filters, and returns a promise of one page
(`{ object: 'list', data, has_more, url }`, newest first) that is ALSO an async
iterable over every page:

```ts
const page = await peable.paymentIntents.list({ status: 'succeeded', limit: 20 });
for await (const refund of peable.refunds.list({ payment_intent: intent.id })) {
  reconcile(refund);
}
const sellers = await peable.connectedAccounts.list().autoPagingToArray({ limit: 1000 });
```

Listable (and, for six of them, searchable — see Search below): `paymentIntents`, `charges`, `paymentLinks`, `checkout.sessions`, `refunds`,
`transfers`, `disputes`, `connectedAccounts`, `tax.transactions`, the
per-payment `listForPaymentIntent` sub-lists. Iterating from
`ending_before` walks backwards, away from the cursor.

A reference to another object (`payment_intent`, `connected_account`) is its id
unless you `expand` it — dot paths up to four levels, `data.`-prefixed on a list:

```ts
const session = await peable.checkout.sessions.retrieve(id, {
  expand: ['payment_intent.connected_account'],
});
await peable.refunds.list({ expand: ['data.payment_intent'] });
```

`metadata` holds at most 50 keys (40-character keys, 500-character values). An
update is a patch — a key sent as `''` is removed — and every update is a `POST`:

```ts
await peable.paymentIntents.update(intent.id, { metadata: { shipped: 'yes', draft: '' } });
await peable.paymentLinks.update(link.id, { active: false });
```

### Search (0.19.0)

Stripe's Search API on `paymentIntents`, `charges`, `customers`, `products`,
`prices` and `refunds` — and, since 0.20.0, `subscriptions` and `invoices`: `search({ query, limit?, page?, expand? })` answers a
promise of one page — `{ object: 'search_result', data, has_more, next_page,
url }` — that is ALSO an async iterable over every match, following
`next_page` with the same query:

```ts
const page = await peable.customers.search({ query: 'email:"jenny@example.com"' });
for await (const intent of peable.paymentIntents.search({
  query: "status:'succeeded' AND amount>1000 AND metadata['order_id']:'6735'",
})) {
  fulfil(intent);
}
const counted = await peable.charges.search({
  query: 'payment_method_details.card.last4:"4242"',
  expand: ['total_count', 'data.payment_intent'],
});
```

The language is Stripe's: `field:value` (exact, case-insensitive for text),
`field~"sub"` (substring, at least 3 characters), `>`, `<`, `>=`, `<=`, `=` on
amounts (base units) and `created` (Unix seconds), `-field:value` to negate,
`field:null` for no value, `metadata['key']:'value'`. Text values are quoted;
clauses join with spaces / `AND` or with `OR`, never both; at most 10 clauses
and 1000 characters. A malformed query is a `PeableInvalidRequestError` with
`param: 'query'` and the position in its message. Searchable fields per
resource are at <https://oxy.so/developers/docs/peable/lists/#searchable-fields>.

### Reporting: report runs (0.19.0)

`peable.reporting.reportTypes` lists what can be run (`payments.itemized.1`,
`balance.summary.1`, `payouts.itemized.1`, with `columns`, `default_columns`
and the interval data exists for). A run is produced in the background:

```ts
const run = await peable.reporting.reportRuns.create({
  report_type: 'payments.itemized.1',
  parameters: { interval_start: 1_780_000_000, interval_end: 1_782_592_000 },
});
// Later — or on `reporting.report_run.succeeded`:
const done = await peable.reporting.reportRuns.retrieve(run.id);
if (done.status === 'succeeded' && done.result) {
  const { bytes } = await peable.files.contents(done.result.id); // the CSV
}
```

`interval_end` is exclusive and may not be in the future; `columns` picks a
subset of the type's columns (written in the layout's order); `currency` narrows it. A ledger report
for a merchant without a fiat account is a 404 `account_missing`. A run that
cannot be produced is `failed` with `error`. `reportRuns.list({ report_type })`
pages like every list.

### Payment statuses, confirm, capture and cancel (ADR 0019)

A PaymentIntent walks Stripe's seven statuses — `requires_payment_method`,
`requires_confirmation`, `requires_action`, `processing`, `requires_capture`,
`succeeded`, `canceled` — on both rails. A FairCoin payment starts in
`requires_action` (`next_action.faircoin_payment` has the address, amount and
`faircoin:` URI), is `processing` once the payer broadcasts (`faircoin.txid`,
`faircoin.confirmations`) and ends `succeeded` or `canceled`
(`cancellation_reason: 'abandoned' | 'underpaid' | …`). A declined card returns
to `requires_payment_method` with `last_payment_error` and can be retried.
Refunds never change the status: read `amount_refunded`, or the refunds.

```ts
const intent = await peable.paymentIntents.create({
  amount: '1999', rail: 'card', currency: 'EUR',
  customer: 'cus_…', payment_method: 'pm_…', confirm: true, off_session: true,
  capture_method: 'manual',
});
await peable.paymentIntents.capture(intent.id, { amount_to_capture: '1500' });
await peable.paymentIntents.cancel(other.id, { cancellation_reason: 'requested_by_customer' });
try {
  await peable.paymentIntents.confirm(id, { payment_method: 'pm_…' });
} catch (error) {
  if (error instanceof PeableCardError) offerAnotherCard(error.paymentIntent);
}
const charge = await peable.charges.retrieve(intent.latest_charge as string);
```

Events are Stripe's names: `payment_intent.created|requires_action|processing|
amount_capturable_updated|succeeded|payment_failed|canceled`, `charge.refunded`,
`charge.dispute.created|updated|closed|funds_withdrawn|funds_reinstated`,
`refund.created|updated|failed`, `customer.*`, `payment_method.*` and
`setup_intent.*`.

### Files (0.16.0)

A file (`file_…`) is bytes given to Orbit for ONE purpose, stored in Oxy Files.
The purpose sets the policy, and the format is recognised from the bytes:

| `purpose` | Formats | Max | Visibility |
|---|---|---|---|
| `dispute_evidence` | PDF, PNG, JPEG | 5 MiB | private — attach to a dispute |
| `business_logo` | PNG, JPEG | 512 KiB | public — `merchants.update({ business_logo })` |
| `identity_document`, `additional_verification` | PDF, PNG, JPEG | 10 MiB | private |
| `finance_report_run` | CSV | 64 MiB | private — written by report runs only, never uploaded; read with `files.contents(id)` |

```ts
const receipt = await peable.files.create({
  purpose: 'dispute_evidence',
  file: new File([await readFile('receipt.pdf')], 'receipt.pdf'),
});
// An Oxy file you already own, without uploading it again:
const logo = await peable.files.create({ purpose: 'business_logo', oxy_file: 'oxy_file_id' });
await peable.merchants.update({ business_logo: logo.id }); // beside avatar_file_id
for await (const file of peable.files.list({ purpose: 'dispute_evidence' })) console.log(file.id);
```

The upload is `multipart/form-data` and still carries an `Idempotency-Key`; a
retry under the same key with the same bytes answers the stored file.
`url` is set on an available `business_logo` (public) and `finance_report_run`
(the authenticated `GET /v1/files/:id/contents`, which `files.contents(id)`
reads); evidence and documents are never addressable by URL.
`FILE_UPLOAD_PURPOSES` lists the purposes `create` takes.

### Disputes: stage, submit once, or accept (0.16.0)

```ts
// Stage — text goes to the provider as a draft; files attach by id.
await peable.disputes.update(dispute.id, {
  evidence: { product_description: 'Blue enamel mug', receipt: receipt.id },
});
// Submit — the attached files are uploaded to the provider now, and the
// response is sent. ONE shot: a second submission is refused.
await peable.disputes.update(dispute.id, { submit: true });
// Or accept the dispute (it becomes `lost`):
await peable.disputes.close(dispute.id);
```

Peable stores none of the evidence text: the draft lives at the provider, and
`dispute.evidence` is read live on `retrieve`, `update` and `close` only —
lists and webhook events never carry it. What Peable keeps is the `file_…` ids
you attached and `evidence_details` (`due_by`, `has_evidence`, `past_due`,
`submission_count`, `submitted_at`). An empty string unsets a field. `reason`
is Stripe's enum; `charge` is expandable.

### Payment methods: configurations and wallet domains (0.16.0)

`paymentMethodConfigurations` (`pmc_…`) say which card-rail methods payers are
offered: `card`, `apple_pay`, `google_pay`, `sepa_debit`, `ideal`,
`bancontact`, `eps` (and `bizum`, reported `unavailable_reason:
'provider_unsupported'`), plus `faircoin`, which is always on and `locked: true`
(ADR 0021: every payer can always pay with FairCoin; setting it `off` is a 400
`payment_method_locked`, and it is `unavailable_reason:
'faircoin_account_missing'` until the merchant registers its FairCoin key). Each
method carries `available`, `display_preference`, `locked`,
`unavailable_reason` and the `currencies` it is offered in. A card PaymentIntent uses the default configuration unless it names
`payment_method_configuration` or explicit `payment_method_types`.

```ts
const [config] = (await peable.paymentMethodConfigurations.list()).data;
await peable.paymentMethodConfigurations.update(config.id, {
  ideal: { display_preference: { preference: 'on' } },
});
await peable.paymentIntents.create({
  amount: '2500', rail: 'card', currency: 'EUR',
  payment_method_types: ['card', 'sepa_debit'],
});

// Apple Pay / Google Pay on your own pages (Peable's hosted checkout needs none):
const domain = await peable.paymentMethodDomains.create({ domain_name: 'shop.example.com' });
if (domain.apple_pay.status === 'inactive') await peable.paymentMethodDomains.validate(domain.id);
```

Card data and bank credentials are entered in the provider's hosted fields and
never reach Peable. Currencies: FAIR, EUR, USD, GBP, CHF, SEK, NOK, DKK, PLN,
CZK, CAD, AUD and JPY — JPY is zero-decimal (`CURRENCY_DECIMALS.JPY === 0`),
so `amount: '1500'` is ¥1,500.

### Catalog: products, prices, coupons, promotion codes (0.14.0)

What you sell and on what terms, as Orbit objects (ADR 0018): `products`
(`prod_…`), `prices` (`price_…`), `coupons` and `promotionCodes` (`promo_…`),
each with create / retrieve / update / auto-paginating `list` (and `del` on
products and coupons). Every amount is a **base-unit string** — `'999'` is
9.99 EUR, `'100000000'` is 1 FAIR — never a number.

```ts
const plus = await peable.products.create({
  name: 'Plus',
  tax_code: 'txcd_10103000',
  default_price_data: { currency: 'EUR', unit_amount: '999', recurring: { interval: 'month' } },
});
const yearly = await peable.prices.create({
  product: plus.id, currency: 'EUR', unit_amount: '9900',
  recurring: { interval: 'year' }, lookup_key: 'plus_yearly', transfer_lookup_key: true,
});
const { data: [current] } = await peable.prices.list({ lookup_keys: ['plus_yearly'] });

await peable.coupons.create({ id: 'LAUNCH20', percent_off: 20, duration: 'once' });
await peable.promotionCodes.create({ coupon: 'LAUNCH20', code: 'LAUNCH', max_redemptions: 100 });
```

- **Prices are immutable** except `active`, `nickname`, `metadata`,
  `lookup_key` and a `tax_behavior` that is still `unspecified`. To change an
  amount, create a price and archive the old one (`active: false`). The product's
  `default_price` cannot be archived until another default is set.
- **`lookup_key`** is unique among your prices (per mode). `transfer_lookup_key:
  true` moves it from the price holding it, so the key always names the current
  price of a plan. `lookup_keys` (at most 10) filters a list by them.
- Tiered prices: `billing_scheme: 'tiered'`, `tiers_mode: 'graduated' |
  'volume'`, `tiers: [{ up_to, unit_amount?, flat_amount? }]`, the last `up_to`
  `'inf'`. `transform_quantity` packs per-unit quantities. A metered price
  (`recurring: { usage_type: 'metered', meter: 'mtr_…' }`) bills a meter's usage.
- A product with prices (or named by a coupon's `applies_to`) cannot be
  deleted — archive it. **Coupon ids are never reused**, even after `del`.
  Coupons change only `name` and `metadata`.
- **Promotion codes** are case-insensitive and unique among your ACTIVE codes;
  restrict them with `customer`, `max_redemptions`, `expires_at` (never after the
  coupon's `redeem_by`) and `restrictions` (`first_time_transaction`,
  `minimum_amount` + `minimum_amount_currency`). Change `active` and `metadata`.
- Events: `product.created|updated|deleted`, `price.created|updated`,
  `coupon.created|updated|deleted`, `promotion_code.created|updated`. Prices
  and promotion codes are archived, never deleted, so there is no
  `price.deleted` or `promotion_code.deleted`.

### Checkout Sessions v2 (Orbit Phase 3)

A session is an ORDER — line items, a discount, tax and what to collect — that
the payer completes on Peable's hosted checkout (`session.url`) or the embedded
one (`session.client_secret`). **No payment exists until the payer confirms**:
`payment_intent` (or `setup_intent` in `setup` mode) is `null` until then, and is
created with the amount the session computed.

```ts
const session = await peable.checkout.sessions.create(
  {
    mode: 'payment',
    line_items: [
      { price: 'price_…', quantity: 1, adjustable_quantity: { enabled: true, maximum: 5 } },
      {
        price_data: { currency: 'EUR', unit_amount: '500', product_data: { name: 'Gift wrap' } },
        quantity: 1,
      },
    ],
    allow_promotion_codes: true, // or discounts: [{ promotion_code: 'promo_…' }]
    customer_email: 'ana@example.com',
    billing_address_collection: 'required',
    shipping_address_collection: { allowed_countries: ['ES', 'PT', 'FR'] },
    phone_number_collection: { enabled: true },
    tax_id_collection: { enabled: true },
    custom_fields: [{ key: 'engraving', label: { type: 'custom', custom: 'Engraving' }, type: 'text' }],
    consent_collection: { terms_of_service: 'required' },
    automatic_tax: { enabled: true },
    locale: 'es',
    success_url: 'https://shop.example/thanks?session={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://shop.example/cart',
    client_reference_id: order.id,
  },
  { idempotencyKey: `checkout:${order.id}` },
);
// redirect the payer to session.url
```

- `mode`: `payment`, `setup` (save a card; give `currency` and a `customer`, no
  `line_items`) or `subscription` — the last answers 400 `param: 'mode'` until the
  native billing engine fulfils it; nothing is faked.
- Amounts are base-unit strings: `amount_subtotal`, `amount_total`,
  `total_details.{amount_discount, amount_tax, amount_shipping}`. All line items
  share one currency.
- **FairCoin is always offered (ADR 0021).** A fiat session's
  `payment_method_types` is `['card', 'faircoin']` (a `FAIR` one's
  `['faircoin']`); leaving `faircoin` out is 400 `payment_method_locked`. The
  payer chooses — `createPeableCheckout().confirmCheckoutSession(id, secret,
  { payment_method_type: 'faircoin' })` — and FairCoin on a fiat order is a
  FairCoin payment for the total quoted in FAIR for 10 minutes
  (`payment_intent.faircoin.quote`: currency, fiat amount, rate, sources).
  Completion is the same `checkout.session.completed`. The public session's
  `faircoin` says whether FairCoin can be paid with right now, and why not
  (`price_unavailable`, `faircoin_account_missing`).
- `status` is `open` → `complete` | `expired`; `payment_status` is `paid`,
  `unpaid` (a manual capture, or a FairCoin payment still confirming —
  `checkout.session.async_payment_succeeded|failed` follows) or
  `no_payment_required`. **Fulfil on `checkout.session.completed`** (or by
  retrieving the session), never on the payer arriving at `success_url`.
- `automatic_tax` is Peable Tax with the collected address as location evidence;
  a covered sale it cannot price fails closed and the payer cannot pay.
- `expires_at` is 30 minutes to 24 hours from now (default 24 h).
  `expire(id)` ends an open session now and cancels its unpaid payment.

```ts
await peable.checkout.sessions.expire(session.id);
for await (const item of peable.checkout.sessions.listLineItems(session.id, {
  expand: ['data.price'],
})) {
  console.log(item.description, item.quantity, item.amount_total);
}
await peable.checkout.sessions.list({ payment_link: 'link_…', status: 'complete' });
```

Events: `checkout.session.completed`, `checkout.session.expired`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`.

### Payment Links v2

A link is a shareable URL over catalog **prices**. A payer visiting `link.url`
starts a Checkout Session with its line items and options — a link never mints a
payment on its own.

```ts
const link = await peable.paymentLinks.create({
  line_items: [{ price: 'price_…', quantity: 1, adjustable_quantity: { enabled: true } }],
  allow_promotion_codes: true,
  shipping_address_collection: { allowed_countries: ['ES'] },
  after_completion: { type: 'hosted_confirmation', hosted_confirmation: { custom_message: '¡Gracias!' } },
  // or { type: 'redirect', redirect: { url: 'https://shop.example/thanks?session={CHECKOUT_SESSION_ID}' } }
  restrictions: { completed_sessions: { limit: 100 } },
});
await peable.paymentLinks.update(link.id, { active: false });
const items = await peable.paymentLinks.listLineItems(link.id);
```

Line items are fixed once a link exists (create another link to change them);
every other option can be updated. Events: `payment_link.created|updated`.

### Branding and customer emails

```ts
await peable.merchants.branding.update({
  primary_color: '#0A7CFF',
  accent_color: '#0B1F33',
  font: 'inter', // a fixed list of system font stacks
  border_style: 'rounded', // rounded | rectangular | pill
  use_avatar_as_icon: true,
  logo: 'file_…', // a File of purpose business_logo (peable.files.create); null removes it
});
await peable.merchants.emailSettings.update({
  payment_receipts: true,
  refund_notices: true,
  checkout_confirmations: false,
  support_email: 'help@shop.example',
});
```

Branding is applied to the hosted checkout, the embedded checkout and Peable's
receipts. `null` resets a field to Peable's default.

### Embedded checkout and Elements (`@peable.to/sdk/checkout`)

Create the session with `ui_mode: 'embedded'` and hand its `client_secret` to the
browser. The checkout is framed from `checkout.peable.to`; messages are checked
for origin and source on both sides, and the secret travels only in the frame's
URL fragment.

```ts
import { PeableCheckout } from '@peable.to/sdk/checkout';

const checkout = PeableCheckout.mountCheckout('#checkout', {
  clientSecret, // cs_…_secret_…
  appearance: { theme: 'night', variables: { colorPrimary: '#0A7CFF' } },
  locale: 'es',
  onComplete: ({ sessionId, successUrl }) => showThanks(sessionId),
});
// checkout.updateAppearance({...}); checkout.destroy();
```

`onComplete` fires only after the gateway says the session is complete; without
it the page navigates to the session's `success_url`. Still fulfil server-side.

Elements mount the card provider's own secure fields (card data never touches
your page or Peable) inside Peable chrome, styled by one `appearance`:

```ts
import { createPeableElements } from '@peable.to/sdk/checkout';

const elements = createPeableElements({
  publishableKey, // or paymentIntent: { id, client_secret } to fetch it
  amount: '2700',
  currency: 'EUR',
  appearance: {
    theme: 'peable', // 'peable' | 'night' | 'flat'
    variables: { colorPrimary: '#0A7CFF', borderRadius: '8px', fontFamily: 'Inter, sans-serif' },
    rules: { '.Input': { boxShadow: '0 1px 2px rgba(0, 0, 0, 0.08)' } },
  },
});
await elements.create('expressCheckout').mount('#wallets');
await elements.create('payment', { label: 'Card' }).mount('#card');
await elements.create('address', { provider: { mode: 'billing' } }).mount('#address');

const result = await elements.confirmPayment({ paymentIntent: { id, client_secret } });
if ('error' in result) showError(result.error.message);
else if (result.status === 'pending') keepWatching(result.paymentIntent);
else showPaid(result.paymentIntent);
```

`confirmPayment` / `confirmSetup` confirm with the provider and then **wait for
the gateway's own status** (realtime, with a REST poll beside it): they resolve
`succeeded`, `processing` or `requires_capture` only when the gateway says so, an
error for a fresh decline, and `pending` if the gateway has not decided within
`timeoutMs` (default 60 s). Invalid `appearance` values (anything that is not a
colour, a length, a font list, or a rule property from a fixed set) are dropped,
never passed to CSS or the provider.
### Billing engine: subscriptions, invoices, credit notes, meters, entitlements, portal (0.20.0, ADR 0018)

Orbit runs its own billing: subscriptions and invoices are Orbit objects with
Orbit ids, priced from the catalog, taxed by Peable Tax before an invoice
finalizes, and collected with a PaymentIntent — off-session against a saved
card, or by the payer from their wallet on FairCoin (never a debit).

```ts
const sub = await peable.subscriptions.create({
  customer: 'cus_…',
  items: [{ price: 'price_…', quantity: 2 }],
  trial_period_days: 14,
  automatic_tax: { enabled: true },
  expand: ['latest_invoice'],
});
await peable.subscriptions.update(sub.id, {
  items: [{ id: sub.items.data[0].id, price: 'price_pro' }],
  proration_behavior: 'always_invoice',
});
await peable.subscriptions.cancel(sub.id, { invoice_now: true, prorate: true });

const draft = await peable.invoices.create({ customer: 'cus_…', currency: 'EUR' });
await peable.invoiceItems.create({ customer: 'cus_…', invoice: draft.id, amount: '4200', currency: 'EUR' });
const open = await peable.invoices.finalizeInvoice(draft.id); // numbered PREFIX-0001, gapless
await peable.invoices.pay(open.id); // a decline is a PeableCardError
await peable.creditNotes.create({ invoice: open.id, amount: '1000', reason: 'order_change' });
const next = await peable.invoices.retrieveUpcoming({ customer: 'cus_…' });
```

- **Statuses** are Stripe's: subscriptions `incomplete`, `incomplete_expired`,
  `trialing`, `active`, `past_due`, `unpaid`, `canceled`, `paused`; invoices
  `draft` → `open` → `paid` | `void` | `uncollectible`. Every change records its
  event (`customer.subscription.*`, `invoice.*`, `invoiceitem.*`, `credit_note.*`).
- **Signed amounts**: a proration credit line, an invoice whose credits exceed
  its charges and a customer balance (negative is credit) may start with `-`.
- **Customer balance**: `customerBalanceTransactions.create('cus_…', { amount:
  '-500', currency: 'EUR' })`; applied to the next invoice when it finalizes.
- **Test clocks** (test mode): `testHelpers.testClocks.create({ frozen_time })`,
  attach a customer with `customers.create({ test_clock })`, then
  `testClocks.advance(id, { frozen_time })` runs trials, renewals and dunning
  up to that time before it answers.
- **Dunning**: `billingSettings.update({ dunning: { retry_schedule_days: [1, 3,
  5, 7], final_action: 'cancel' | 'unpaid' | 'past_due', invoice_action:
  'mark_uncollectible' | 'leave_open' }, emails: { … } })`.
- **Usage**: `billing.meters.create({ display_name, event_name, default_aggregation:
  { formula: 'sum' | 'count' | 'last' } })`, then
  `billing.meterEvents.create({ event_name, identifier, payload: {
  peable_customer_id, value } })` — idempotent by `identifier`.
- **Entitlements**: `entitlements.features.create({ lookup_key: 'mention_plus',
  name })`, `entitlements.productFeatures.attach('prod_…', { entitlement_feature })`
  for EVERY product that grants it, and `entitlements.activeEntitlements.list({
  customer })` is the access answer — one entitlement per feature however many
  products grant it. Listen for `entitlements.active_entitlement_summary.updated`.
- **Portal**: `billingPortal.sessions.create({ customer, return_url })` answers a
  one-hour `url` to Orbit's hosted portal, configured by
  `billingPortal.configurations`.

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


### HTTP deadlines and existing operation keys

`timeout` (default 80 000 ms, on the client or per request) bounds each token
mint and each gateway attempt, including reading its body. A timed-out or
interrupted attempt is a `PeableConnectionError` and is retried under the same
`Idempotency-Key` (above); set `maxNetworkRetries: 0` to recover yourself, with
the same durable key.

`paymentIntents.cancel` / `confirm` / `capture`, `refunds.create`, and `transfers.create` accept an
optional second `{ idempotencyKey }` argument; without it the client mints one
(above). Refund/transfer/reversal `external_ref` remains their durable business
identity; the key neither replaces it nor changes gateway financial semantics.

### Connect for FairCoin (0.4.0)

Pay a marketplace's sellers in FairCoin straight to their own wallets
(ADR 0012, guide at <https://oxy.so/developers/docs/peable/connect-faircoin/>):

```ts
const seller = await peable.connectedAccounts.create({
  external_ref: store.id,
  faircoin: { network: 'testnet', oxy_user_id: store.ownerOxyUserId },
});
const link = await peable.connectedAccounts.createAccountLink(seller.id, {
  rail: 'faircoin', return_url: returnUrl, refresh_url: refreshUrl,
});
// the seller registers their key at link.url, signed in with Oxy;
// you receive connected_account.updated with faircoin.status === 'active'
const intent = await peable.paymentIntents.create(
  { amount: '250000000', rail: 'faircoin', network: 'testnet', connected_account: seller.id },
  { idempotencyKey: `order:${order.id}` },
);
```

Events for an on-behalf payment carry `event.account`; `intent.can_expire` is `false` once a
payer has broadcast, so never cancel an order on `expires_at` alone. A seller
without a registered key is a 409 with `error.code === 'account_not_ready'`.

### Connect & money (0.17.0, ADR 0015)

Fiat funds never reach a Peable bank account: a merchant that takes cards has
its OWN provider account, opened and onboarded through Peable. Orbit mirrors
that account's balance, balance transactions and payouts into a double-entry
ledger reconciled against the provider daily, and instructs payouts the
provider executes. Nothing here is computed by Orbit — a figure the provider
has not given is `null`, never `0`.

```ts
// The merchant's own account. The first update opens it (country + business_type).
let account = await peable.account.retrieve(); // 404 code 'account_missing' when there is none
account = await peable.account.update({
  settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'friday' } } },
});
account.requirements.currently_due; // ['individual.verification.document', …] — identifiers, never values

// Hosted onboarding. Mint on click, never store; a return proves nothing — read the account back.
const link = await peable.accountLinks.create({
  return_url: 'https://you.example/account',
  refresh_url: 'https://you.example/account?refresh=1',
});

// The balance, per currency. `informational` is FairCoin received in the merchant's
// own wallet: on the books, never payable.
const balance = await peable.balance.retrieve();
for await (const txn of peable.balanceTransactions.list({ type: 'charge', currency: 'eur' })) {
  // txn.amount is signed; txn.fee / txn.net are null when the provider gave no figure
}

// Payouts: the provider executes them. `create` is for a manual schedule.
const payout = await peable.payouts.create(
  { amount: '10000', currency: 'EUR' },
  { idempotencyKey: `payout:${weekId}` },
);
await peable.payouts.cancel(payout.id); // while still pending
const report = await peable.reports.payoutReconciliation({ payout: payout.id });
report.summary; // { count, amount, fee, net } over every transaction the payout paid out

// Orbit's fee on a destination charge, and its refunds.
const fees = await peable.applicationFees.list({ payment_intent: 'pi_…' });
await peable.applicationFees.listRefunds(fees.data[0].id);
```

**`peableAccount` — a platform acting for a seller.** `account`, `accountLinks`,
`balance`, `balanceTransactions`, `payouts` and `reports.payoutReconciliation`
take `{ peableAccount: 'ca_…' }` in their last (options) argument — or the
client's `peableAccount` default — sent as the `Peable-Account` header, to read
or act on one of the platform's connected accounts with the platform's own
credential. No other method has the option: the gateway refuses the header
elsewhere.

```ts
await peable.balance.retrieve({}, { peableAccount: seller.id });
await peable.payouts.create(
  { amount: '5000', currency: 'EUR' },
  { peableAccount: seller.id, idempotencyKey: `payout:${seller.id}:${day}` },
);
```

Card payments for a seller: `paymentIntents.create({ …, transfer_data: { destination:
'ca_…' }, application_fee_amount: '150' })` (a destination charge), or `on_behalf_of`
to make the seller the merchant of record.

**Refunds** gain `reason`, `metadata`, `refund_application_fee` and
`reverse_transfer` on `create`, plus `refunds.update(id, { metadata })` and
`refunds.cancel(id)` — read the answer's `status`; only `canceled` means the
money stayed. Events: `account.updated`, `application_fee.created|refunded`,
`payout.created|updated|paid|failed|canceled` and `balance.available`.

### Pay with Peable: the payment sheet

`PeableSheetCheckout` (`@peable.to/sdk/checkout/ui`) is the one way an Oxy app
pays an order in-app: the Bloom detached bottom sheet over a Checkout Session
(`sessionSource(clientSecret)`, or `sheetSourceFromUrl(hostedUrl)` when your
backend hands you Peable's hosted URL) or a single PaymentIntent
(`intentSource(id, clientSecret)` plus an `order`). It reads the order through
the anonymous payer client, asks only for what the session collects (an email
when it has none, a shipping address only with `shipping_address_collection`,
a billing country when tax needs one — before the card, so card and wallets
pay the taxed total), pays the card in the secure fields below (Peable's secure
page where no DOM can host them) with Apple Pay and Google Pay above them on the
web (the provider's Express Checkout element on the order's own card payment:
offered exactly when the merchant's payment method configuration, a registered
wallet domain and the device allow; the secure page offers them from a native
app) and always lists FairCoin —
quoted, paid through the Peable wallet's `peable://pay` request (button on a
phone, QR elsewhere), or disabled with the gateway's reason. `onSettled` fires
once when the gateway closes the order; success is shown only when the host's
own backend answers `outcome: 'succeeded'`, and `expected` refuses an order
that is not the reviewed one. Mention Plus and Mercaria (plans and the
marketplace) use it; there is no host copy of this logic.

Its copy is ONE catalog in the SDK (`src/ui/locales/`): ar, bn, ca, de, en,
es, fr, hi, id, it, ja, pt (Brazil), ru, tr and zh (Simplified) —
`CHECKOUT_UI_LOCALES`. `locale` is a BCP 47 tag or `'auto'` (default: the
browser or device), resolved by `resolveCheckoutLocale`; an unknown language
reads English. Every catalog has exactly the English keys (`tsc`) and the same
placeholders (`messages.test.ts`). A host never translates the sheet;
`messages` overrides product copy by key.

The payer routes it calls answer any origin without credentials
(`Access-Control-Allow-Origin: *`; the gateway's `lib/payerCors.ts`), because
their authority is the client secret, so a merchant's own site can host it.
Its live updates use the gateway's payer socket (`PAYER_SOCKET_PATH`), which
answers any origin without credentials on the same terms. Merchant and dashboard
routes, and the Oxy socket a signed-in app uses, keep the Oxy-only CORS.

### Checkout presentation primitives

`@peable.to/sdk/checkout/ui` exposes the controlled `PeableCheckoutSheet` and
checkout view-model types. It composes Bloom's `CheckoutSheet` with Peable's
provided brand asset, localized copy and minor-unit currency formatting. The
host supplies quoted items, requirements, draft state, navigation and the
`onAuthorize` callback. Card collection is a provider-owned `cardEntry` slot;
the component never collects or stores card numbers, calls payment APIs, or
grants access. Shipping is conditional on the request. Optional `brandState`
controls presentation only; a host may restore the logo after confirmed
success before closing. Completion timers and authoritative outcomes belong
to the host.

This entry is ESM/React Native only, with optional React, React Native and Bloom
peers. Neither the server root nor the anonymous `/checkout` core imports it;
the module-graph isolation test enforces that boundary. The Peable logo is
copied into the ESM build and included in the package artifact.

The controlled UI also accepts `methodDetails` for a provider handoff or
FairCoin wallet/external-wallet presentation. Available choices come from host
capabilities and the request's allowed method IDs. Wallet availability is an
explicit callback/data capability, never inferred from a signed-in account or
platform. The host supplies quoted amounts, balance and remaining balance;
the UI performs no FX conversion, wallet reads, signing or automatic debits.
A wallet top-up uses the wallet owner's receive details, separately from the
merchant payment destination. Neither flow buys or sells cryptocurrency.
The external QR merely renders the host-provided payload; payment confirmation
and any incoming-funds recognition must remain authoritative host operations.

`checkoutFeedbackSounds` exposes the supplied success/failure AAC assets for
host-controlled playback. Original OGG files are retained byte-for-byte in the
artifact. The host owns terminal-transition deduplication, mute preferences,
playback cancellation and platform audio capabilities; the SDK imports no Expo
audio runtime. `resultIllustration` can carry a host-owned catalogue sticker,
without adding sticker services or account data to the SDK.

The optional installment detail variant displays a host-supplied schedule,
amount due today, full total and fees. It neither calculates a financing quote
nor approves credit. The host restricts this method to eligible requests and
supplies the corresponding review totals; it is not modeled as an automatically
renewing subscription. The generic checkout shell blocks interactive dismissal
while processing, while the host retains ownership of terminal outcomes and
session teardown.

Wallet observations are independent of spending permission. A ready public balance
can be displayed without an authorization callback; loading, unavailable and error
states never manufacture a zero. Retry/connect actions are optional host capabilities,
not a new identity-to-wallet synchronization API.

Installment presentation accepts supplied plan choices, decision states, dated
schedules and optional repayment/APR/terms details. `validInstallmentQuote` checks
structural consistency of integer amounts and dates only; it cannot authenticate a
provider, establish eligibility or approve credit. The host binds selected quotes to
the current order and merchant configuration. Method completion uses the compositor's
forward continuation and explicit payment confirmation rather than charging on selection.

External wallet presentation accepts authoritative observation phases. Waiting displays
a QR/address and progress ring; detection/confirmation are distinct from settlement.
The host owns observation and cancellation. Full addresses remain selectable and the
optional copy callback must resolve successfully before the UI reports a copy. Local
preview simulations and their nonpayable QR values stay in the consuming app.

`PeableProviderFields` renders the same Bloom `CardForm` used by the rest of
checkout. Only number, expiry and security-code inputs are provider-origin hosted
fields in atomic Bloom slots. Billing country/postcode, labels, validation chrome
and layout remain Bloom; no full processor form or competing payment selector is
embedded. Link autofill is disabled through the supported hosted-card option.
The split hosted Elements are an explicit compatibility choice for this layout;
they remain supported, while Payment Element is the provider's preferred general
integration. This choice never routes raw card values through React or Peable.

A host may supply `cardConfiguration: { publishableKey }` before `action` exists,
and `authorize(billing)` to obtain the action only when the payer continues (the
sheet records the billing location, confirms the session by card and fetches
the payment's client action there).
This read-only configuration mounts the secure fields immediately; it is not
payment authority. Supplying a matching verified `client_secret` action later
preserves the mounted fields and entered data. Until then, or if the keys differ,
no preparation callback is exposed. The host must validate the exact order,
account/session and offer binding, and unmount/dispose on a scope change.

Completeness publishes a **preparation** callback. Continue tokenizes the secure
fields without charging, returning masked metadata and an opaque, in-memory
prepared authorization. The host may then unmount the input fields and show its
Bloom confirmation. Only explicit Pay calls `authorization.confirm()`. The handle
survives field unmount, rejects concurrent confirmation, and must be disposed on
close, a new card, or an intent change. It owns no persistence or saved-card grant.
Provider acceptance still means pending: the host observes gateway settlement;
subscriptions additionally require authoritative active/paid readiness.

The hosted checkout and this UI share `loadProviderSdk` through the anonymous
`/checkout` browser entry. React/Bloom remain unreachable from that entry or the
server root. Provider text styling uses current Bloom typography/colors without
recreating secure frames on theme changes; the surrounding chrome is Bloom itself.
Postal code is optional unless explicitly required by the host. Readiness timeouts
and errors permit retry. Native hosts without browser-hosted-field capability
remain unavailable rather than falling back to raw card capture.

### Order details and optional rewards

The optional `@peable.to/sdk/checkout/ui` entry also exports
`PeableOrderDetailsSheet`. Its host supplies the order's quoted total, paid and
remaining amounts, dated repayment observations, and explicit optional actions.
It uses Bloom's order progress/timeline, grouped sections and dialog compositor;
it does not calculate a loan, initiate an early payment, or infer autopay.

Reward data is bound to an order and includes eligibility, a deadline, category
requirements, offer descriptions and full conditions. Browsing and selecting an
offer are separate from explicitly confirming a claim. The host must revalidate
order binding, eligibility and expiry and make claims idempotent. The SDK has no
reward service, persistence, fulfillment or entitlement side effects. A rejected
claim never changes the order's payment status. `claiming` blocks dismissal until
the host supplies a result. No reward is inferred for a successful payment.
