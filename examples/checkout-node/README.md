# Hosted Checkout: a one-time payment

A Bun server that sells one product through Peable's hosted checkout:

- `POST /checkout` records an order, creates a Checkout Session for it (an
  inline `price_data` line, the order id as `client_reference_id`, one
  `Idempotency-Key` per order) and redirects the payer to `session.url`.
- `GET /success?session_id=…` **retrieves the session from Peable** and shows
  what it says. Arriving at `success_url` proves nothing: the order is paid only
  when the session is `complete` with `payment_status: 'paid'`.
- `POST /webhooks` verifies each delivery on the raw body and re-reads the
  session on `checkout.session.completed`, `…async_payment_succeeded`,
  `…async_payment_failed` and `…expired`.

Both paths go through one idempotent `syncOrder`, so an order is fulfilled once
whichever arrives first. A FairCoin order completes the session while it
confirms on chain (`payment_status: 'unpaid'`) and is paid on
`checkout.session.async_payment_succeeded`.

## Environment

| Variable | |
|---|---|
| `PEABLE_PUBLIC_KEY`, `PEABLE_SECRET` | A **test-environment** Oxy application credential with `payments:read` and `payments:write`. Its environment is what puts every call in test mode. |
| `PEABLE_WEBHOOK_SECRET` | The `whsec_…` printed by `peable listen`, or your webhook endpoint's secret. |
| `PORT`, `BASE_URL` | Optional. Default `4242` and `http://localhost:4242`. |
| `PEABLE_API_URL` | Optional. Default `https://api.peable.to`. |

## Run it against test mode

```sh
cp .env.example .env      # fill in the credential
bun run start             # http://localhost:4242
```

Forward test-mode events to the server with the [Peable CLI](../../packages/cli/README.md)
and put the secret it prints in `PEABLE_WEBHOOK_SECRET`:

```sh
peable login
peable listen --forward-to http://localhost:4242/webhooks
```

Pay with one of the provider's test cards (`4242 4242 4242 4242`, any future
date, any CVC); see <https://docs.stripe.com/testing> for declines and 3-D
Secure.

`bun run typecheck` checks the example. Inside this repository it resolves the
workspace `@peable.to/sdk` (run `bun install` at the root first); copied out,
`bun install` takes the published package.
