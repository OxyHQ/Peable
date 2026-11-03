# Subscriptions: Peable's billing engine

A monthly "Pro" plan sold with Peable's own billing engine:

- `bun run setup` creates the catalog once: a product, its recurring price
  (`lookup_key: 'example_pro_monthly'`, 9.00 EUR a month) and the entitlement
  feature the product grants (`example_pro`). It finds each by key first, so it
  is safe to run again.
- `POST /subscribe` creates a customer for the signed-in browser session and a
  Checkout Session in `mode: 'subscription'`. The hosted page collects the card;
  when the payer confirms, Peable creates the subscription and its first taxed
  invoice and saves the card for renewals. The subscription is `active` when
  that payment succeeds, not when the payer returns.
- `GET /account` reads the customer's subscriptions and **active entitlements**
  live. Access is the entitlements (`activeEntitlements.list({ customer })`):
  they follow trials, renewals, dunning and cancellations without you caching a
  status.
- `POST /portal` mints a one-hour customer-portal link
  (`billingPortal.sessions.create`) where the customer changes plan, updates
  their card, cancels or downloads invoices. Mint it on click; never store it.
- `POST /webhooks` handles `customer.subscription.*` (re-reading the
  subscription, since events can arrive out of order), `invoice.paid`,
  `invoice.payment_failed`, `invoice.payment_action_required` and
  `entitlements.active_entitlement_summary.updated`, where you grant or
  withdraw access.

The browser session stands in for your app's sign-in: a request never names the
customer it acts for, because a portal link can cancel that customer's
subscriptions.

## Environment

| Variable | |
|---|---|
| `PEABLE_PUBLIC_KEY`, `PEABLE_SECRET` | A **test-environment** Oxy application credential with `payments:read` and `payments:write`. |
| `PEABLE_WEBHOOK_SECRET` | The `whsec_…` printed by `peable listen`, or your endpoint's secret. |
| `PORT`, `BASE_URL`, `PEABLE_API_URL` | Optional. Default `4242`, `http://localhost:4242`, `https://api.peable.to`. |

## Run it against test mode

```sh
cp .env.example .env    # fill in the credential
bun run setup           # once
bun run start           # http://localhost:4242
peable listen --forward-to http://localhost:4242/webhooks   # in another terminal
```

`peable listen` is the [Peable CLI](../../packages/cli/README.md); put the secret
it prints in `PEABLE_WEBHOOK_SECRET`. Subscribe with the test card
`4242 4242 4242 4242` (any future date, any CVC); the provider's declines and
3-D Secure cards are at <https://docs.stripe.com/testing>.

To run renewals and dunning in seconds, create the customer on a test clock
(`peable.testHelpers.testClocks.create({ frozen_time })`, then
`customers.create({ email, test_clock })`) and `testClocks.advance` it.

`bun run typecheck` checks the example against the workspace `@peable.to/sdk`.
