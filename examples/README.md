# Peable examples

Small, runnable integrations of `@peable.to/sdk` against **test mode**. Each one
is a Bun server with its own README, `.env.example` and `bun run typecheck`.

| Example | Shows |
|---|---|
| [`checkout-node`](checkout-node) | A hosted Checkout Session for a one-time payment; the success page retrieves the session server-side. |
| [`elements-vite`](elements-vite) | Your own payment page with Elements; the server and its webhook decide when the order is paid. |
| [`subscriptions`](subscriptions) | The billing engine: a recurring price, a subscription through Checkout, entitlements, the customer portal and the billing webhooks. |
| [`marketplace-connect`](marketplace-connect) | Connect: seller onboarding, a destination charge with an application fee, a transfer, and a seller's balance. |
| [`webhooks-receiver`](webhooks-receiver) | Verifying on the raw body across a secret roll, typed dispatch, a fast 2xx, and idempotency by `event.id`. |

Every example needs a **test-environment** Oxy application credential
(`payments:read` + `payments:write`): its environment is what makes the calls
test mode. Local webhooks come from the [Peable CLI](../packages/cli/README.md):
`peable listen --forward-to http://localhost:4242/webhooks`.

In this repository the examples are not workspace members. They resolve the
workspace `@peable.to/sdk` build through the root `node_modules`, so run
`bun install` at the root and start an example from its directory. CI
typechecks all of them.
