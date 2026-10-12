# Recurring checkout operation recovery

The official SDK exposes `billing.retrieveCheckoutOperation({idempotencyKey,
providerCustomerId, providerPriceId, storeId, planId})`. It sends an authenticated
`payments:read` GET to `/v1/billing/checkout_operations/:key`; the route sends
`Cache-Control: no-store`. The caller's registered merchant, app and environment
are resolved by existing auth. Customer/store and price/plan bindings must match
that owner and the existing operation exactly. Responses include the stored tax
quote identity, public merchant identity, app, environment and mode for consumer
correlation; quote identity is never supplied by the requester.

`not_found`, `pending` and `indeterminate` are observations, never cancellation
or permission to create again. A `succeeded` result includes `checkout.id` and
`checkout.expiresAt` indefinitely. Its sensitive URL is included only while it
is fresh. This read does not validate a new quote, claim/reacquire a lease, create
a checkout, or invoke any financial write. It can recover a lost response after
the original signed quote expires, including through a fresh service instance.
Legacy results without an embedded session ID use the separately stored provider
object reference; a conflicting embedded ID is rejected.

If the provider accepted but Peable never committed the response, the default
result remains uncertain. A trusted deployment can optionally register a named
`checkoutOperationReader` with exact read-only operation-key discovery. Its proof
must match the persisted remote idempotency key, complete request digest,
customer, price, mode and quote identity. Session expiry cannot exceed the
stored immutable quote expiry. A valid proof can complete only the existing
operation using a state/digest/lease compare-and-swap; concurrent completion or
lease replacement is preserved. Unknown/absent remote results never cancel an
operation. The native Stripe adapter has no read-by-idempotency-key capability,
and no session metadata adoption or provider-create fallback is introduced.

Checkout observations additionally return required nullable `initialInvoiceId`.
Peable exhausts provider invoice pages for the exact bound subscription, checks
customer, mode and `subscription_create` reason, requires exactly one candidate,
and verifies its single non-prorated line's subscription and price. The result
is pinned once on the checkout operation by a null-to-value compare-and-swap
(pre migration 0026). First discovery after renewal still finds the original
invoice. A renewal's `latestInvoiceId` is never substituted. Ambiguity, incomplete
pagination and contradictory evidence remain unknown or errors. This is invoice
identity discovery, not proof of payment; paid-state and signed final authority
verification remain separate and unchanged.

Commerce remains disabled. The prepared shared-types and SDK prerelease versions
are unpublished. No new provider credentials, tax decisions, monetary operations
or production database writes are part of these changes.
