# Marketplace: Connect

A platform that takes card payments for its sellers, as a small JSON API:

| Route | What it does |
|---|---|
| `POST /sellers` `{ ref, country, business_type }` | Opens the seller's connected account (`connectedAccounts.create`). `ref` is your own id for the seller and the idempotency: repeating it returns the same `ca_…`. |
| `GET /sellers/:ref/onboard` | Mints a hosted onboarding link (`accountLinks.create`, `rail: 'card'`) and redirects to it. Single-use and short-lived: open it from the click, never store or email it. |
| `GET /sellers/:ref/return` | Where onboarding returns. Arriving proves nothing, so it re-reads the account (`connectedAccounts.refresh`) and reports `payable` and what is still due. |
| `POST /orders` `{ seller, amount, flow }` | Creates the order's card PaymentIntent. `flow: 'destination'` is a **destination charge**: `transfer_data.destination` is the seller and the platform keeps `application_fee_amount` (10% here). `flow: 'separate'` is a platform charge settled to the seller afterwards. Returns the `client_secret` the payer confirms with Elements (see [`../elements-vite`](../elements-vite)). |
| `GET /sellers/:ref/balance` | The seller's balance (`balance.retrieve({ peableAccount })`, the `Peable-Account` header) and their last transfers (`transfers.list({ connected_account })`). |
| `POST /webhooks` | On `payment_intent.succeeded` for a `separate` order it pays the seller's share with `transfers.create` — `external_ref` makes a redelivered event converge on one transfer. Also logs `connected_account.updated` (a seller became payable, or stopped being) and `application_fee.created`. |

Peable never computes a split: the fee and every amount are the platform's.
Sellers are found by your own reference (`retrieveByRef`), so the example keeps
no seller table. A seller who has not finished onboarding is refused card
payments with a 409 `account_not_ready`.

## Environment

| Variable | |
|---|---|
| `PEABLE_PUBLIC_KEY`, `PEABLE_SECRET` | A **test-environment** Oxy application credential with `payments:read` and `payments:write`. Test mode is always open to third-party Connect; live is gated. |
| `PEABLE_WEBHOOK_SECRET` | The `whsec_…` printed by `peable listen`, or your endpoint's secret. |
| `PORT`, `BASE_URL`, `PEABLE_API_URL` | Optional. Default `4242`, `http://localhost:4242`, `https://api.peable.to`. |

## Run it against test mode

```sh
cp .env.example .env     # fill in the credential
bun run start
peable listen --forward-to http://localhost:4242/webhooks   # the Peable CLI, in another terminal
```

```sh
curl -X POST localhost:4242/sellers -H 'content-type: application/json' \
  -d '{"ref":"seller-1","country":"ES","business_type":"individual"}'
open http://localhost:4242/sellers/seller-1/onboard          # the provider's test onboarding
curl -X POST localhost:4242/orders -H 'content-type: application/json' \
  -d '{"seller":"seller-1","amount":"5000","flow":"destination"}'
curl localhost:4242/sellers/seller-1/balance
```

The provider's test onboarding accepts its documented test identity and bank
details. Confirm an order's `client_secret` with the test card
`4242 4242 4242 4242` on a page like [`../elements-vite`](../elements-vite).
`peable listen` is the [Peable CLI](../../packages/cli/README.md); put the
secret it prints in `PEABLE_WEBHOOK_SECRET`.

`bun run typecheck` checks the example against the workspace `@peable.to/sdk`.
