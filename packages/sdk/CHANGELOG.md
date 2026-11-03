# Changelog

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
