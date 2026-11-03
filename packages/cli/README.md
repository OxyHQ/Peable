# @peable.to/cli

The Peable command line: build and test a Peable integration from your
terminal. Forward test-mode events to a server on your machine, cause them on
demand, tail your API requests, and work with payment intents, checkout
sessions and webhook endpoints.

```sh
npm i -g @peable.to/cli    # then: peable --help
bunx @peable.to/cli --help # or run it without installing
```

Node 20 or later (or Bun).

> **Not on npm yet.** The package is `"private": true` until the owner
> configures its npm trusted publisher (`~/Oxy/docs/npm-releases.md`, "A
> brand-new package"); removing `private` is then the release. Until then, run
> it from a checkout: `bun run --filter @peable.to/cli build && node
> packages/cli/dist/bin.js --help`.

## Log in

Peable authenticates with an **Oxy application credential** (a `publicKey` and
a `secret`, created for your application in Oxy). Its environment decides the
mode: a `production` credential is **live**, every other environment is
**test**.

```sh
peable login                          # test mode, profile "default"
peable login --live                   # the live credential of the same profile
peable login --profile shop           # another set of credentials
echo "$PEABLE_SECRET" | peable login --public-key oxy_dk_…   # non-interactive
peable whoami
peable logout [--profile shop] [--test|--live] [--all]
```

`login` asks for the public key and reads the secret without echoing it, then
checks the credential against the gateway before storing anything — and refuses
a credential whose mode is not the one you asked for. Credentials are stored in
`~/.config/peable/config.json` (`$XDG_CONFIG_HOME/peable/config.json`), mode
`0600`, in a `0700` directory. The secret is never printed.

Every command takes `--profile <name>` (or `$PEABLE_PROFILE`), `--test` /
`--live` (default test) and `--json`. To work against a local gateway, log in
with `--base-url http://localhost:3000` (and `--oxy-api-url` for a non-default
Oxy); both are stored with the profile.

## Receive webhooks locally: `peable listen`

```sh
peable listen --forward-to http://localhost:3000/webhooks
peable listen --events payment_intent.succeeded,customer.* --print-json
```

`listen` streams every event your test-mode merchant records — as it commits,
rendered exactly as a webhook delivery carries it — and POSTs each one, in
order, to `--forward-to`, printing the status your server answered:

```
Ready! Your webhook signing secret is whsec_3f… (^C to quit)
2026-11-03 12:00:01   --> payment_intent.succeeded [evt_…]
2026-11-03 12:00:01  <--  [200] POST http://localhost:3000/webhooks [evt_…] 12ms
```

Each forwarded request is signed with the `whsec_…` printed for this session,
with the same algorithm and `Peable-Signature` header as a real delivery, so
your handler verifies it unchanged:

```ts
const event = peable.webhooks.constructEvent(rawBody, req.headers['peable-signature'], secret);
```

Use the session secret while you develop and the endpoint's own secret in
production. `listen` needs no public URL and registers no webhook endpoint; it
reconnects on its own and resumes after the last event it received. It is test
mode only.

## Cause an event: `peable trigger`

```sh
peable trigger payment_intent.succeeded
peable trigger            # lists the events it can cause
```

`trigger` creates real test-mode objects through the public API whose changes
record the event — never a synthetic event. A FairCoin fixture creates a
testnet payment and completes it with the test helper
`simulate_faircoin_payment`, which drives the real state machine without
touching the chain.

| Event | What it does |
|---|---|
| `payment_intent.created` | a FairCoin testnet payment intent |
| `payment_intent.processing`, `payment_intent.succeeded` | …paid and confirmed by the test helper |
| `payment_intent.payment_failed` | …underpaid by the test helper (also `canceled`) |
| `payment_intent.canceled` | …then cancelled |
| `customer.created` / `.updated` / `.deleted` | a customer, then updated or deleted |
| `product.created` / `.updated` / `.deleted` | a catalog product, then updated or deleted |
| `price.created` | a product and a one-time EUR 10.00 price |
| `coupon.created` | a 10%-off, once coupon |
| `webhook_endpoint.test` | a test event to your first enabled endpoint |

Events that need a card confirmed at the provider (charges, refunds, disputes,
setup intents) cannot be caused from the API alone; use the provider's test
cards in the hosted checkout. Test mode only.

## Tail your requests: `peable logs tail`

```sh
peable logs tail --status 4xx --method POST
```

```
2026-11-03 12:00:04 [400] POST /v1/payment_intents [req_…] 8ms
```

Your test-mode API requests as they are answered: method, path, status,
duration and `Idempotency-Key`. Bodies, headers and query strings are never
recorded.

## Resources

```sh
peable events list [--type payment_intent.*] [--limit 20]
peable events retrieve evt_…
peable payment_intents list [--status succeeded]
peable payment_intents retrieve pi_…
peable payment_intents create --amount 100000000 [--metadata order=42]   # FairCoin testnet
peable checkout_sessions create --amount 100000000 --name 'Test item' --success-url https://shop.example/thanks
peable checkout_sessions create --price price_… --quantity 2 --success-url https://shop.example/thanks
peable webhook_endpoints list
peable webhook_endpoints create --url https://shop.example/hook --events payment_intent.succeeded
peable webhook_endpoints delete we_…
```

Amounts are in base units, as strings (1 FAIR is `100000000`). Add `--json` for
the object exactly as the API returned it. Exit codes: `0` success, `1` the
operation failed (the error, its code and the request id are printed), `2` a
usage error.
