### The wire: snake_case, Unix seconds, one error envelope

Request parameters and returned objects are exactly the gateway's wire
(ADR 0014): `snake_case` field names, every instant an integer of **Unix
seconds**, amounts as base-unit strings. Only SDK options stay camelCase
JavaScript — constructor config, `{ idempotencyKey }` request options and
`toleranceSec`:

```ts
const intent = await peable.paymentIntents.create(
  { amount: '1999', rail: 'card', currency: 'EUR', metadata: { order_id: order.id } },
  { idempotencyKey: `order:${order.id}` },
);
new Date(intent.created * 1000); // Unix seconds, not an ISO string
```

Every failure is a typed `PeableError` built from
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

// In the handler, with the RAW body:
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
you pass none, the client mints a uuid for that call and reuses it for the
call's own re-attempt, so a retried call never runs twice. Pass your own — one
stable key per order — to make a retry from ANOTHER call (after a crash, from a
job queue) converge too:

```ts
await peable.checkout.sessions.create(params, { idempotencyKey: `checkout:${order.id}` });
```

Within 24 hours, per merchant (application + environment), the gateway answers:

- same key, same request → the stored response, with `Idempotent-Replayed: true`;
- same key, different request → `PeableInvalidRequestError`, `code: 'idempotency_error'` (400);
- same key while the first is still running → `code: 'idempotency_error'` (409) — retry later.

A 5xx is never stored, so retrying it with the same key runs it again. The
key is a request-retry layer, not a business identity: refunds, transfers and
reversals still take `external_ref`, which is durable and decides whether money
moves twice.

Signed billing documents (tax quotes and final invoice authorities) carry
`schema_version: 2`, whose instants are Unix seconds; the verifiers accept no
other version.

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

Listable: `paymentIntents`, `charges`, `paymentLinks`, `checkout.sessions`, `refunds`,
`transfers`, `disputes`, `connectedAccounts`, `tax.transactions`, the
per-payment `listForPaymentIntent` sub-lists and contributions. Iterating from
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
`charge.dispute.created|updated|closed`, `refund.created|updated|failed`,
`customer.*`, `payment_method.*` and `setup_intent.*`.

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
  `'inf'`. `transform_quantity` packs per-unit quantities. Metered usage
  (`usage_type: 'metered'`) is refused until meters exist.
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

SDK0.2.1 accepts `requestTimeoutMs` on `new Peable(...)`. It bounds each token
mint and gateway HTTP attempt, including reading its body. Omitting it preserves
the previous timeout behavior. A consumer replacing a20s HTTP client should
pass `requestTimeoutMs: 20_000`. A401 may still trigger the existing single token
refresh/retry; timeouts and interrupted responses never retry a payment POST.
The remote outcome may be unknown: recover explicitly with the same durable key.

`paymentIntents.cancel` / `confirm` / `capture`, `refunds.create`, and `transfers.create` accept an
optional second `{ idempotencyKey }` argument; without it the client mints one
(above). Refund/transfer/reversal `external_ref` remains their durable business
identity; the key neither replaces it nor changes gateway financial semantics.

### Connect for FairCoin (0.4.0)

Pay a marketplace's sellers in FairCoin straight to their own wallets
(ADR 0012, guide in `docs/connect-faircoin.md`):

```ts
const seller = await peable.accounts.create({
  external_ref: store.id,
  faircoin: { network: 'testnet', oxy_user_id: store.ownerOxyUserId },
});
const link = await peable.accountLinks.create({
  account: seller.id, rail: 'faircoin', return_url: returnUrl, refresh_url: refreshUrl,
});
// the seller registers their key at link.url, signed in with Oxy;
// you receive connected_account.updated with faircoin.status === 'active'
const intent = await peable.paymentIntents.create(
  { amount: '250000000', rail: 'faircoin', network: 'testnet', connected_account: seller.id },
  { idempotencyKey: `order:${order.id}` },
);
```

`peable.accounts` is `peable.connectedAccounts` under its Stripe name. Events for
an on-behalf payment carry `event.account`; `intent.can_expire` is `false` once a
payer has broadcast, so never cancel an order on `expires_at` alone. A seller
without a registered key is a 409 with `error.code === 'account_not_ready'`.

### Optional checkout presentation (local development)

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

This UI currently requires the coordinated **local** Bloom checkout/status-ring
build and local SDK build. Registry version 0.5.0 does not acquire these APIs
until a separately authorized package release. Local Mention development uses
an explicit source resolver/artifact override; no publication is implied.

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

A host may supply `cardConfiguration: { publishableKey }` before `action` exists.
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
