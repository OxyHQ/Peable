# Changelog

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
