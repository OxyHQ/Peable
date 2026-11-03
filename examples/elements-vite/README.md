# Elements: your own payment page

A Vite page that collects a card with `@peable.to/sdk/checkout` Elements, and a
small Bun server that owns the payment:

- `POST /api/orders` creates the order's card PaymentIntent — the amount is the
  server's, with one `Idempotency-Key` per order — and returns its `id` and
  `client_secret`, the payer's capability over that one payment.
- The page mounts `createPeableElements({ paymentIntent })` →
  `create('payment').mount('#payment')` and calls `confirmPayment` on submit.
  Card data goes to the provider's own fields and never reaches the page's
  code, the server or Peable.
- **The server decides when the order is paid.** `GET /api/orders/:id` retrieves
  the payment from Peable and fulfils the order once it `succeeded`; the
  webhook (`payment_intent.succeeded`, `…processing`, `…canceled`) does the same.
  The page shows "Paid" only when the server says so, never because the
  browser's confirmation resolved.
- The order id lives in the URL, so a reload or a 3-D Secure redirect resumes
  the same payment instead of creating a second one.

A declined card (`payment_intent.payment_failed`) is not the end: the payment
returns to `requires_payment_method` and the payer can try another card.

## Environment

| Variable | Read by | |
|---|---|---|
| `PEABLE_PUBLIC_KEY`, `PEABLE_SECRET` | server | A **test-environment** Oxy application credential with `payments:read` and `payments:write`. |
| `PEABLE_WEBHOOK_SECRET` | server | The `whsec_…` printed by `peable listen`, or your endpoint's secret. |
| `PORT`, `PEABLE_API_URL` | server | Optional. Default `4242` and `https://api.peable.to`. |
| `VITE_PEABLE_API_URL` | page | Optional, public. The gateway the Elements read the payment from. |

## Run it against test mode

```sh
cp .env.example .env    # fill in the credential
bun run server          # the API, on :4242
bun run web             # the page, on http://localhost:5173 (proxies /api to :4242)
```

Forward test-mode events with the [Peable CLI](../../packages/cli/README.md) and
put the secret it prints in `PEABLE_WEBHOOK_SECRET`:

```sh
peable listen --forward-to http://localhost:4242/webhooks
```

Pay with `4242 4242 4242 4242` (any future date, any CVC), `4000 0000 0000 9995`
for a decline, or `4000 0027 6000 3184` for 3-D Secure; the provider's full list
is at <https://docs.stripe.com/testing>.

`bun run typecheck` checks the page (`tsconfig.json`) and the server
(`tsconfig.server.json`). Inside this repository it resolves the workspace
`@peable.to/sdk` (run `bun install` at the root first).
