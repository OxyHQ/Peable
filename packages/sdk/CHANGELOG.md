# Changelog

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
