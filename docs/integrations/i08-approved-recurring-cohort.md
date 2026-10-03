# I08 — approved recurring cohort, 2026-10-03

Nate's authorization in the Oxy #1519 session approves completing the documented
recommendations, including I08. The reviewed implementation scope is the existing
Mercaria `BillingProvider`: ensureCustomer, createCheckoutSession,
createPortalSession, retrieveSubscription and cancelAtPeriodEnd. This supersedes
this issue's earlier “pending Nate approval” implementation gate.

This cohort preserves Mercaria's existing Stripe platform account, mode and
merchant-of-record flow. It does not decide the general commercial model for
other merchants in [Peable ADR 0009](../adr/0009-peable-holds-the-provider-credentials.md).
No `provider_connections`, merchant-supplied keys, Connect `on_behalf_of`, new
settlement rules, immediate cancellation, financial awards or entitlement engine
are introduced. Oxy and Mercaria retain plan and entitlement semantics.

Activation requires an explicitly reviewed merchant/app/environment/platform
account/mode cohort. An SDK release or deployment of the five routes does not
enable recurring billing globally. An internal verified import or a completed
operation binds each customer/price/subscription to that cohort; arbitrary event
metadata never establishes ownership. Historical references without such a
mapping are denied. An empty application database does not prove an empty Stripe
account and does not authorize creating a commercial product.

The financial subject provided by Mercaria's current contract is the stable
`storeId` within the authenticated application namespace. The receiving merchant
and the store are separate identities. No merchant owner is asserted to be the
payer; there is no invented Oxy account mapping. I01 independently tests a bot's
own financial authority in Oxy. These five methods impose no account-kind limit.

Repository requirements:

- Object references and financial idempotency keys have a global provider/account/
  mode identity. A different owner cannot turn the same key into a second intent.
- Subscription customer and price bindings must share the exact owner and
  deployment namespace; store and plan references must match.
- Claim and completion are durable, remote calls occur outside database
  transactions, and local binding/result completion is atomic. Unknown outcomes
  retry with the same remote key only within a conservative 23-hour recovery
  window; later retries require verified reconciliation.
- Successful ensureCustomer reuses the bound store customer, including a renamed
  store, without updating the remote display name or creating another customer.
- Hosted URLs are sensitive owner-only responses, excluded from public evidence
  and logs. Expired results cannot be replayed indefinitely. Portal expiry is a
  short gateway handoff deadline, not a provider validity guarantee.
- Portal uses an explicit server-side configuration verified at each call.
  Subscription updates must be disabled; cancellation must be disabled or at
  period end. Drift fails closed. Configuration must remain controlled during
  cohort operation; the provider offers no atomic read-and-create configuration
  guarantee.

The implementation, sandbox lifecycle (signup, renewal, payment authentication,
failure, cancellation, refund and reconciliation), SDK publication/adoption and
cohort transition remain separate acceptance gates in Peable #87. No sandbox
execution, release, adoption or production cutover is claimed by this document.

Sources: [I08](https://github.com/OxyHQ/Peable/issues/87),
[Mercaria's existing five-method contract](https://github.com/OxyHQ/Mercaria/blob/9e546e66b36b8050bfe07a37f53ee436444688cf/packages/backend/src/services/billing/provider.ts),
[Mercaria ADR 0009 D15/D17](https://github.com/OxyHQ/Mercaria/blob/9e546e66b36b8050bfe07a37f53ee436444688cf/docs/adr/0009-peable-payment-rail.md).
