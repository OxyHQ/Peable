# Embedded recurring checkout

The server SDK exposes `billing.embeddedCheckoutConfiguration()`,
`billing.createEmbeddedCheckoutSession(params, { idempotencyKey })` and
`billing.retrieveEmbeddedCheckoutAction(sessionId)`. These use the same
workload-authenticated merchant ownership as hosted Billing. Payer browsers never
receive a merchant credential. Wire fields use snake_case and Unix seconds.

Creation requires a valid signed Peable Tax quote and an enabled fiscal adapter.
It checks customer/store and price/plan bindings, freezes fiscal evidence, and
claims the existing durable checkout operation. Embedded presentation participates
in its request digest: the same key cannot switch between hosted and embedded.
Only the session ID, presentation and expiry are persisted. The ephemeral
processor client secret is fetched under verified merchant ownership, never
stored in Peable's operation record or Oxy's durable intent.

The adapter creates a subscription Checkout Session with `ui_mode: elements`,
using the exact signed amount and frozen tax rate, with automatic repricing and
adaptive pricing disabled. Its provider session remains the canonical link used
by renewal tax processing, subscription ownership discovery and invoice authority.
The secure Bloom card fields tokenize payment details; the explicit Pay action
confirms the session using that PaymentMethod. Provider session identity, mode,
currency and amount must still match the frozen action before confirmation.
Payer receipt email and billing location must be real collected or authorized
account data. Language, display currency and timezone are not tax evidence.

Owned action retrieval checks the exact provider customer, price, mode, currency,
gross/tax amount and expiry against the persisted fiscal snapshot. Completed or
expired sessions return their disposition with `action: null`, allowing the host
to wait for authoritative fulfillment without creating a second purchase.
Session completion alone is not an entitlement grant. Consumers continue to
verify the signed paid invoice and apply their own durable entitlement flow.

## Deployment prerequisites

Backend credentials have one source: AWS SSM SecureString under `/oxy/peable/*`.
GitHub deployments do not copy secrets into AWS. A secret owned by another app
must never configure Peable. The reviewed task references must match the intended
provider account and mode; `STRIPE_ACCOUNT_ID` independently pins that business
identity and startup refuses a different account before serving card payments.

The live rollout requires the matching secret/public key, platform and Connect
webhook signing secrets, the reviewed merchant cohort and provider catalogue,
approved fiscal settings, signing-key mount and tax webhook endpoint reference.
Configure the exact provider API version on webhook delivery. Missing or unknown
tax registrations must not be replaced with an invented empty registration list.
The isolated `__local` test endpoints are not a production integration or an
activation mechanism.

Read-only `countProviderInventory` in the billing repository supports an operator
same-network audit before replacing a deployment account. It returns aggregate
counts only; no payer data, private keys or payment capabilities.
