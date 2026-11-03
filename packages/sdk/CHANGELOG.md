# Changelog

## 0.16.0 — Files, complete disputes, payment method breadth (breaking)

Requires `@peable.to/shared-types` 0.14.0.

- **Breaking:** `disputes.submitEvidence` (`POST /v1/disputes/:id/evidence`) is
  removed, with no alias. Use `disputes.update(id, { evidence, metadata, submit })`
  (`POST /v1/disputes/:id`): `submit` omitted or `false` stages a draft at the
  provider; `submit: true` uploads the attached files and submits, once. New
  `disputes.close(id)` accepts a dispute (`lost`). `DisputesResource` moved from
  `resources/merchants` to `resources/disputes`.
- **Breaking:** the `Dispute` object is Stripe's: `evidence_due_at` /
  `evidence_submitted_at` are replaced by `evidence_details {due_by,
  has_evidence, past_due, submission_count, submitted_at}`; new `charge`
  (expandable), `is_charge_refundable`, `metadata`, `reason` as Stripe's enum,
  and `evidence` on live reads only. File evidence fields (`receipt`,
  `customer_communication`, `shipping_documentation`, `uncategorized_file`, …)
  take `file_…` ids. New events `charge.dispute.funds_withdrawn` and
  `charge.dispute.funds_reinstated`, accepted by `webhooks.constructEvent`.
- New `peable.files` (`create` — multipart bytes or `{ oxy_file }` — `retrieve`,
  `list({ purpose })`). `RestClient` requests take a `form` (`FormData`) beside
  `body`.
- New `peable.paymentMethodConfigurations` (`create` / `retrieve` / `update` /
  `list`) and `peable.paymentMethodDomains` (`create` / `retrieve` / `update` /
  `list` / `validate`).
- `paymentIntents.create` takes `payment_method_configuration` and card-rail
  `payment_method_types` (`card`, `sepa_debit`, `ideal`, `bancontact`, `eps`);
  `PaymentIntent.payment_method_configuration_details` is new.
- `merchants.update` takes `business_logo` (a `file_…` of purpose
  `business_logo`), beside `avatar_file_id` — the wordmark, not the icon.
- Currencies widened: GBP, CHF, SEK, NOK, DKK, PLN, CZK, CAD, AUD and JPY
  (zero-decimal) join FAIR, EUR and USD. `CURRENCY_CODES`, `CURRENCY_DECIMALS`
  and `FIAT_CURRENCY_CODES` are re-exported.
- `@peable.to/sdk/checkout`: `mountCardElements` mounts the provider's wallet
  buttons (Apple Pay and Google Pay only; the provider's own wallet is off) above
  its Payment Element, which shows the card and local methods the intent offers.
  One confirmation path; an accepted confirmation is never success.
- `@peable.to/sdk/checkout`: `availableWallets`, `readRedirectReturn`,
  `withoutRedirectParams` and `delayedProcessingNotice` (SEPA Debit takes
  business days); new `ProviderFieldEvent` type export; provider types cover
  `expressCheckout` and its `confirm` event.
- `PeableCheckout.mount`: a card intent now renders wallets, payment fields and a
  Pay button instead of the FairCoin button; it handles bank-redirect returns
  (shows "confirming", removes the secret from the URL) and shows the gateway's
  status once the payment leaves the payer's hands.
- `@peable.to/sdk/checkout/ui`: `intentMethodAvailability` and
  `intentCheckoutMethods` list a card intent's wallets and local methods for the
  Bloom sheet. A method the device or host cannot run is listed as unavailable
  with a reason, never hidden or faked. New English and Spanish `method.*`
  messages.

## 0.15.0 — live tails, request logs and test helpers

Additive. Requires `@peable.to/shared-types` 0.13.0.

- New `peable.events.stream({ types, signal, onConnect, onDisconnect })` — an
  async iterable of every event as it is recorded, rendered exactly as a
  webhook delivery carries it (`GET /v1/events/stream`, Server-Sent Events).
  **Test mode only** (a live credential throws `PeablePermissionError`, code
  `test_mode_only`). Reconnects on its own and resumes after the last event it
  yielded (`Last-Event-ID`); ends when `signal` aborts.
- New `peable.requestLogs`: `list({ status, method, created, … })` (`status` is
  a code or a class, `'4xx'`), `retrieve(requestId)` and `stream({ status,
  method })` — your own API requests of the last 30 days, `id` being the
  `Request-Id`. Method, path, status, duration and `Idempotency-Key` only.
- New `peable.testHelpers` (test mode only):
  `paymentIntents.simulateFaircoinPayment(id, { outcome })` drives a FairCoin
  test payment through the real state machine (`processing → succeeded`, or
  `canceled` when `outcome: 'underpaid'`) without touching the chain;
  `checkoutSessions.expire(id)` cancels the session's payment as `abandoned`.
- New `peable.webhookEndpoints.sendTestEvent(id)` — a `webhook_endpoint.test`
  to one endpoint, as Orbit's "send test event".
- `createRestClient` returns a `GatewayClient` (`RestClient` plus `stream`);
  `RestClient`, the interface an integrator implements, is unchanged.

## 0.14.0 — catalog: products, prices, coupons, promotion codes (ADR 0018)

Additive.

- New `peable.products` (`create` / `retrieve` / `update` / `list` / `del`):
  `prod_…` with `default_price` (expandable), `tax_code` (Peable Tax),
  `images`, `marketing_features`, `unit_label`, `statement_descriptor`, `url`;
  `default_price_data` on create; `list({ active, ids })`. A product with prices
  cannot be deleted — archive it.
- New `peable.prices` (`create` / `retrieve` / `update` / `list`): `price_…`,
  per-unit or tiered (`graduated` / `volume`), `transform_quantity`, one-time or
  `recurring` (at most three years), `tax_behavior`, `lookup_key` with
  `transfer_lookup_key`; `list({ product, active, type, currency, lookup_keys,
  recurring: { interval, usage_type } })`. Immutable except `active`,
  `nickname`, `metadata`, `lookup_key` and an `unspecified` `tax_behavior`.
- New `peable.coupons` (`create` / `retrieve` / `update` / `list` / `del`):
  `percent_off` (two decimals) or `amount_off` + `currency`, `duration`,
  `max_redemptions`, `redeem_by`, `applies_to.products`, computed `valid`.
- New `peable.promotionCodes` (`create` / `retrieve` / `update` / `list`):
  `promo_…` redeeming a coupon, case-insensitive `code` unique among active
  codes, `customer`, `max_redemptions`, `expires_at`, `restrictions`;
  `list({ code, coupon, customer, active })`.
- Ten new event types, accepted by `webhooks.constructEvent`:
  `product.created`, `product.updated`, `product.deleted`, `price.created`,
  `price.updated`, `coupon.created`, `coupon.updated`, `coupon.deleted`,
  `promotion_code.created`, `promotion_code.updated`.
- Requires `@peable.to/shared-types` 0.12.0.

## 0.13.0 — Orbit payments core: Stripe's PaymentIntent, events, Customers, PaymentMethods, SetupIntents (breaking, ADR 0019)

- `PaymentIntent.status` is Stripe's vocabulary: `requires_payment_method`,
  `requires_confirmation`, `requires_action`, `processing`, `requires_capture`,
  `succeeded`, `canceled`. The old `created`, `awaiting_approval`, `approved`,
  `broadcast`, `confirming`, `settled`, `refunded`, `partially_refunded`,
  `expired`, `failed` and `rejected` are gone. Refunds are not statuses any more
  (`amount_refunded`, and `Refund.payment_status` is removed).
- The chain side of a FairCoin payment moved under `faircoin`
  (`network`, `address`, `txid`, `confirmations`, `required_confirmations`) and
  `next_action.faircoin_payment` (address, amount, `faircoin:` URI); the
  top-level `network`, `address`, `txid` and `confirmations` are removed.
  `merchant_id` is the public `merch_…`.
- New fields: `amount_capturable`, `amount_received`, `capture_method`,
  `setup_future_usage`, `customer`, `payment_method`, `latest_charge`,
  `next_action`, `last_payment_error`, `cancellation_reason`, `canceled_at`,
  `description`, `receipt_email`, `statement_descriptor_suffix`, `shipping`,
  `payment_method_types`.
- `paymentIntents.reject` is removed; `paymentIntents.cancel(id, { cancellation_reason })`,
  `confirm(id, { payment_method, off_session, … })` and
  `capture(id, { amount_to_capture })` are new. A declined confirmation throws
  `PeableCardError` (402) carrying `paymentIntent` and `declineCode`.
- New read-only `charges.retrieve` / `charges.list({ payment_intent })`.
- `list({ customer })` on payment intents.
- Event types are Stripe's (`payment_intent.succeeded`, `payment_intent.payment_failed`,
  `payment_intent.canceled`, `charge.refunded`, `charge.dispute.created`, …);
  `webhooks.constructEvent` accepts exactly the new catalog.
- `@peable.to/sdk/checkout`: the mount's events are `processing`, `succeeded`,
  `payment_failed`, `canceled` and `error` (were `confirming`, `settled`,
  `failed`, `error`). The UI kit's FairCoin transfer states `confirming` /
  `settled` are `processing` / `succeeded`.
- New `peable.customers` (`create` / `retrieve` / `update` / `del` / `list({ email })`),
  `peable.paymentMethods` (`retrieve` / `update` / `list({ customer })` / `detach`) and
  `peable.setupIntents` (`create` / `retrieve` / `list({ customer })` / `cancel`) —
  Orbit's own `cus_` / `pm_` / `seti_` objects (ADR 0016). A `pm_…` is created
  by a SetupIntent that succeeds (or a payment with `setup_future_usage`);
  card details are collected by the provider's Elements, never sent to Peable.
- Requires `@peable.to/shared-types` 0.11.0.

## 0.12.0 — events and webhook endpoints (breaking)

Events are a resource and webhooks render them (ADR 0014 D4). An event is
stored once, in the same transaction as the change it records, and kept 30
days; each enabled webhook endpoint whose `enabled_events` match it receives
one delivery of it, retried with backoff for about three days.

- New `peable.webhookEndpoints`: `create` / `retrieve` / `update` / `list` /
  `del` / `rollSecret`. Several endpoints per merchant (at most 16), each with
  its own `enabled_events` (`'*'` for all) and its own signing secret. The
  secret (`whsec_…`) is generated by Peable and returned ONLY by `create` and
  `rollSecret`. `rollSecret(id, { expires_in_seconds })` (≤ 86 400) keeps the
  previous secret signing beside the new one until then.
- An endpoint that fails every delivery for three days is disabled
  (`status: 'disabled'`, `disabled_reason: 'delivery_failures'`);
  `update(id, { disabled: false })` re-enables it.
- New `peable.events`: `list({ type, delivery_success, created, … })` —
  `type` exact or a `prefix.*` — and `retrieve(id)`.
- New `peable.webhookDeliveries`: `list({ event, webhook_endpoint })` and
  `redeliver(id)` (a new delivery of the same stored event).
- The event envelope gains `api_version` (the wire date it was stored under),
  `data.previous_attributes` (the moved fields' prior values, when the event is
  a change) and `request: { id, idempotency_key }` (the API request that caused
  it, both `null` otherwise). **`webhooks.constructEvent` requires
  `api_version` and `request`.** New event type `webhook_endpoint.test`, sent
  by Orbit's "send test event" to one endpoint.
- `webhooks.constructEvent(raw, header, secret)` accepts a header with several
  `v1=` signatures (a rotation overlap) and a list of secrets: it verifies when
  any signature matches any secret.
- **Removed:** `webhook_url` / `webhook_secret` from `merchants.register` and
  `merchants.update`, and `webhook_url` from `Merchant`. Register an endpoint
  instead; merchants that had a webhook were migrated to one endpoint each,
  `enabled_events: ['*']`, keeping their secret.
- `WebhookDelivery` names `event_id` (`evt_…`) and `webhook_endpoint_id`
  (`we_…`); `merchant_id` and `intent_id` are gone (the event carries the
  payment).
- Requires `@peable.to/shared-types` 0.10.0.

## 0.10.0 — test and live in one deployment (breaking)

The gateway holds a test and a live provider key side by side (ADR 0017); the
credential's environment selects the mode (`production` → live, every other
environment → test), and nothing the SDK sends chooses it.

- `livemode: boolean` on every object: `PaymentIntent`, `PaymentLink` (and the
  public link), `CheckoutSession` (and the public session), `Refund`,
  `Transfer`, `TransferReversal`, `Dispute`, `ConnectedAccount`, `AccountLink`,
  `Settlement`, `WebhookDelivery`, `Merchant` and `BillingObservation`. It is
  the mode of the object's merchant and never changes for an object.
- The webhook event envelope carries `livemode` too. **`webhooks.constructEvent`
  now requires it**: a signed event without a boolean `livemode` is rejected
  with `PeableSignatureVerificationError`, and a `billing.observation.updated`
  whose observation names a different mode than its envelope is rejected as
  well. Upgrade the gateway before (or with) this SDK; events from an older
  gateway do not carry the field.
- Card operations in a mode the deployment has no key for answer `503`
  (`PeableApiError`), like any unavailable rail. The former `403` for a
  credential of "the other" mode no longer exists.
- Requires `@peable.to/shared-types` 0.8.0.

## 0.9.0 — lists, expand and metadata (breaking)

- A reference to another object is named without `_id` and is expandable:
  `payment_intent` (was `payment_intent_id`) on checkout sessions, refunds,
  transfers, disputes and settlements; `connected_account` (was
  `connected_account_id`) on payment intents, checkout sessions and transfers.
  Typed `string | Object`; `expand` returns the object. Create bodies follow:
  `refunds.create({ payment_intent })`,
  `transfers.create({ payment_intent, connected_account })`.
- Every `list()` returns an `ApiListPromise`: a promise of one page
  (`{ object, data, has_more, url }`) that is also an async iterable over every
  page, with `autoPagingEach` and `autoPagingToArray({ limit })`. Lists take
  `ending_before` and `created` beside `limit` / `starting_after`. New:
  `refunds.list/retrieve`, `transfers.list/retrieve`, `disputes.list/retrieve`,
  `checkout.sessions.list/update`, `paymentIntents.update`; `listForPaymentIntent`
  pages. `ContributionsResource.iterate` is gone — iterate `list()` instead.
- `tax.transactions.list` takes the list parameters (`created` filters the tax
  date) instead of `{ from, to }`, and is newest first.
- Updates are `POST`: `paymentLinks.update`, `merchants.update` and contribution
  `setActive` no longer send `PATCH`. `metadata` on an update is a patch (`''`
  removes a key); at most 50 keys, 40-character keys, 500-character values.

## 0.8.0 — generic idempotency (breaking)

The gateway now answers `Idempotency-Key` on every merchant `POST` (ADR 0014
D3): within 24 hours a retried request gets the stored response with
`Idempotent-Replayed: true`, the same key with a different request is a 400
`idempotency_error`, and a key still in flight is a 409 `idempotency_error`.

- Every `POST` now carries an `Idempotency-Key`. Without `{ idempotencyKey }`
  the client mints a uuid per call, reused by that call's own re-attempt, so a
  retried call cannot run twice. Pass your own key (one per order) to make a
  retry from another call converge.
- `paymentIntents.create`'s `idempotencyKey` is optional; the gateway no longer
  requires the header.
- **Breaking:** `transfers.reverse` requires `external_ref`. The
  `Idempotency-Key` is no longer accepted as a reversal's identity — it is the
  24-hour retry layer, and an automatic key would give every reversal a random
  identity.
- A key reused with different terms on `paymentIntents.create` /
  `checkout.sessions.create` is a 400 with `code: 'idempotency_error'` (was 409).

## 0.7.0 — the Orbit wire (breaking)

The gateway now speaks one Stripe-style wire (ADR 0014), changed at the root with
no legacy shape kept:

- Every request parameter, response field and webhook payload is `snake_case`
  (`success_url`, `payment_intent_id`, `connected_account_id`); `createdAt` is
  `created`.
- Every instant is integer Unix seconds (`created`, `expires_at`, …). Amounts
  remain base-unit strings and currencies stay uppercase.
- Errors are `{ error: { type, code?, param?, message, request_id } }`, validation
  answers 400 (never 422), and request bodies are strict: an unknown field is a
  400 naming it in `param`. `PeableError` exposes `param` and `requestId`.
- Contribution lists use the common list envelope with `starting_after`.
- Signed billing documents are `schema_version: 2` only.
- Client options (`idempotencyKey`, `requestTimeoutMs`, `toleranceSec`) stay
  camelCase, as in Stripe's SDKs.

Requires `@peable.to/shared-types` 0.6.0 and `@peable.to/contracts` 0.3.0.

## 0.6.0

- Add the optional `@peable.to/sdk/checkout/ui` entry with controlled Peable
  checkout, payment-method details, order details and optional reward presentation.
  Backend and anonymous headless entries remain independent of React and Bloom.
- Compose secure provider-hosted card fields inside Bloom CardForm. Preparing a
  card creates an opaque authorization; explicit confirmation remains a separate
  action, and verified backend observations establish payment completion.
- Include Peable brand/feedback assets and verify published export paths during
  the build. The UI entry requires Bloom 16.10.0 or newer and has no CommonJS entry.

The release does not activate merchant offers, tax registrations, live payment
methods or product entitlements. Hosts supply authoritative capabilities and
quotes; illustrative checkout scenarios remain development fixtures.
