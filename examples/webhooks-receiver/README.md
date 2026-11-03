# Webhook receiver

The mechanics every Peable webhook endpoint needs, in one small Bun server:

- **Verify on the raw body.** `peable.webhooks.constructEvent(rawBody, header,
  secrets)` checks the `Peable-Signature` header (`t=…,v1=…`) against the exact
  bytes received, within a five-minute tolerance, and returns a typed
  `WebhookEvent`. A bad, stale or missing signature is a 400.
- **Roll secrets without a gap.** `PEABLE_WEBHOOK_SECRET` takes several secrets,
  comma-separated. After `webhookEndpoints.rollSecret(id, {
  expires_in_seconds })` Peable signs every delivery with the new and the old
  secret, one `v1=` each, so a receiver holding either verifies it. Deploy with
  `whsec_new,whsec_old`, then drop the old one when the overlap ends.
- **Dispatch on `event.type`.** The switch narrows `event.data.object` to the
  right resource with no cast.
- **Answer 2xx fast.** The event is queued and acknowledged at once; the work
  runs after the response. A slow handler is a timed-out delivery, and that is
  retried.
- **Be idempotent by `event.id`.** Delivery is at least once (retries,
  redeliveries, `peable listen` reconnecting), so an `evt_…` already accepted
  is acknowledged again and not processed twice.

The in-memory set and queue stand in for durable ones: in production, insert
the event id into a table with a unique constraint and enqueue the work in the
same transaction, because an acknowledged event is never retried by Peable.
Events are not ordered either: when order matters, re-read the object the event
names and act on what it is now.

## Environment

| Variable | |
|---|---|
| `PEABLE_WEBHOOK_SECRET` | The `whsec_…` printed by `peable listen` or your endpoint's secret; several, comma-separated, while one rolls. |
| `PEABLE_PUBLIC_KEY`, `PEABLE_SECRET` | A **test-environment** Oxy application credential, for handlers that re-read objects. Verifying makes no request. |
| `PORT`, `PEABLE_API_URL` | Optional. Default `4242` and `https://api.peable.to`. |

## Run it against test mode

```sh
cp .env.example .env
bun run start
peable listen --forward-to http://localhost:4242/webhooks
peable trigger payment_intent.succeeded
```

`peable listen` is the [Peable CLI](../../packages/cli/README.md): it streams
your test merchant's events and signs each forwarded request with the secret it
prints, exactly as a real delivery is signed. `peable trigger` causes real
test-mode events. To receive from a registered endpoint instead, create one
with `peable.webhookEndpoints.create({ url, enabled_events })` and store the
`secret` it returns — it is shown only once.

`bun run typecheck` checks the example against the workspace `@peable.to/sdk`.
