# Test Clock lifecycle evidence, separate from Checkout

C1 (`4ec49fd`) verified a real test-clock trial, first paid invoice, a distinct paid
renewal invoice, refund of that owned invoice's exact PaymentIntent and replay of
the same refund key/ID, then cancellation actually observed at the period end.
The two paid invoices and refund were USD100 minor units each in Stripe test mode.
No live money, proration policy, awards, settlement or new product API was involved.

C1 then failed its negative fixture: `pm_card_chargeDeclined` is rejected during
attachment (402/card_declined), before the intended renewal. Its two initial
payment-method cleanup assertions also failed: deleting a customer did not clear
those references. Both original failures remain in the evidence. A reviewed
recovery re-read each exact owned method/customer pair, detached only those methods
and confirmed two null-customer readbacks. Customer/subscription/clock/price/product
and database cleanup had succeeded already.

[Stripe's primary test catalogue](https://docs.stripe.com/testing) specifies
`pm_card_chargeCustomerFail` for a method that attaches successfully and fails a
later charge. C2 (`84b54a6 --failure-sca`) repeats only the pending cases with that
fixture and an explicit method/customer relation in its private ownership manifest:

- An initially active subscription renews with that method: SDK reports past_due,
  its exact invoice is open with zero paid, and the PaymentIntent requires a new
  payment method.
- A separate SCA fixture reports incomplete through the SDK, with an open unpaid
  invoice and PaymentIntent requires_action. The challenge is not resolved/bypassed.
- **11/11** cleanup readbacks pass, including three explicitly detached methods,
  two removed customers, two canceled subscriptions, deleted clock, inactive
  price/product and dropped own database.

This exercises real Stripe test resources, verified explicit local binding import,
the built Peable SDK, HTTP, domain and SQL. Oxy authentication is a synthetic seam.
The provider fixture directly creates subscriptions/payment methods and advances
its own clock; it does not prove that these subscriptions came through Checkout.
That separate real hosted path is documented in the sibling Checkout proof. It
also does not prove Mercaria's webhook projection/entitlements or production adoption.

Both exact owned databases are absent from pg_database after teardown. Immutable
Stripe test invoice/payment/refund history remains; the original retained Portal
default (from a1, untouched by Test Clock) remains active with zero mutating features.
No credentials, hosted URLs, raw provider response or card values are published.

[CI37096529545](https://github.com/OxyHQ/Peable/actions/runs/37096529545), source
`feb15cc`, passed **1464/1464** (backend758, SDK120, shared34, checkout34, pay130,
frontend388), plus image migration21. It includes the SDK response integrity fix
and typing followup; it precedes the opt-in Test Clock script. The final script
was checked separately with strict TypeScript and a dry run before execution.

Pending: published shared-types/SDK, backend-before-consumer deployment order,
Mercaria adapter and exact-cohort acceptance with its existing verified/deduplicated
webhook path, then coordinated activation. Commercial catalogue inventory was zero;
these fixtures neither migrate real subscriptions nor activate commercial plans.
