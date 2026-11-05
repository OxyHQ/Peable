# ADR 0014 — Orbit API conventions: one wire, changed at the root

**Status:** accepted.
**Date:** 2026-11-03.

## Context

Orbit by Peable is the merchant platform — dashboard, API, SDKs and hosted
checkout — and it is meant to be to Oxy what Stripe is to the web. An integrator
who knows Stripe should find the same objects, the same list/idempotency/error
behaviour and the same versioning discipline, without the wire being literally
Stripe's (`docs/orbit/stripe-parity.md` is the gap list).

The API that exists today grew per route and is internally inconsistent:

- bodies and DTOs are camelCase (`successUrl`, `paymentIntentId`, `createdAt`)
  while list and payer fields are snake_case (`has_more`, `starting_after`,
  `client_secret`, `connected_account`);
- timestamps are ISO-8601 strings; tax and billing amounts are JSON numbers while
  every other amount is a base-unit string;
- validation answers **422** with Zod's first message and no `param`; an uncaught
  error answers 500 with the raw `err.message`;
- `Idempotency-Key` is required on one create, optional on another, ignored on
  refunds and transfers (which use a body `externalRef`), and is never replayed —
  the current object is returned instead of the stored response;
- `Peable-Version: 2026-07-18` is **echoed** on every response, but a caller can
  neither send nor pin it, so there is no way to change the wire without breaking
  every published SDK at once;
- contributions page with `{items, nextCursor}`, tax with `hasMore`, everything
  else with `{object:'list', data, has_more}`.

## Decision

### D1 — One house style, Stripe's

Every Orbit resource on the new version uses:

| Concern | Rule |
|---|---|
| Field names | `snake_case`, in requests, responses, query strings and events |
| Object identity | `id` (public, prefixed — `pi_`, `cus_`, …) and `object` on every object, including lists and errors' nested objects |
| Mode | `livemode: boolean` on every object |
| Time | `created` and every other instant as **integer Unix seconds** |
| Money | `amount` as a base-unit **string** (a FAIR amount does not fit a JS number) plus an uppercase ISO 4217 `currency` (`EUR`, `USD`; `FAIR` for FairCoin) |
| Metadata | `metadata: Record<string,string>` on every mutable resource; ≤ 50 keys, key ≤ 40 chars, value ≤ 500 chars; an empty string value unsets a key |
| Lists | `{object:'list', data, has_more, url}`; `limit` (1–100, default 10), `starting_after`, `ending_before`, `created[gt|gte|lt|lte]` |
| Expansion | `expand[]`, dot paths, max depth 4, always resolved inside the caller's merchant scope |
| Errors | `{error:{type, code?, decline_code?, param?, message, doc_url?, request_id}}` |
| Status codes | 400 invalid request, 401 authentication, 402 payment refused (`card_error`), 403 permission, 404 not found, 409 conflict / idempotency in flight, 422 **not used**, 429 rate limit, 5xx ours |
| Request id | `Request-Id` response header on every response, and `request_id` inside every error body |

Amounts stay strings — that is the one deliberate departure from Stripe, and it
is a correctness rule (`CONVENTIONS.md` §Money), not a style.

### D2 — A clean cut, no legacy wire

There is ONE wire. The handlers, serializers, `shared-types`, SDKs, hosted
checkout and apps are changed at the root to speak D1 directly; there is no
legacy version kept alive and no translation layer at the edge rewriting one
shape into another. A layer like that would be a second contract every change
has to keep true, and an object would have two spellings depending on who asked.

- The change lands in lockstep: the gateway, `@peable.to/shared-types`,
  `@peable.to/sdk` and `@peable.to/pay` (new majors), `packages/checkout` and
  `packages/frontend` in the same release, and every Oxy consumer (Mention,
  Mercaria, Homiio, the oxy API) upgraded to those majors.
- `Peable-Version` names the date of the wire on every response. Dated,
  side-by-side versions are a tool for when external merchants depend on the API;
  adopting them is a later decision, and it will be made with the same rule —
  no legacy surface kept beyond its replacement.
- A webhook payload is the same object the API returns (D4).

### D3 — Idempotency is generic, and it replays

Every `POST` accepts `Idempotency-Key`. The middleware stores, per merchant and
key: method + path, a hash of the canonical request body, the response status and
body, and a lease while the first request is in flight. Within 24 hours:

- same key, same request → the **stored** response, with `Idempotent-Replayed: true`;
- same key, different request → 400 `idempotency_error`;
- same key while the first is still running → 409 `idempotency_error`.

Business idempotency stays where it is load-bearing and is not replaced:
`payment_intents (merchant_id, idempotency_key)` keeps its unique index, and the
`external_ref` of refunds, transfers and reversals keeps deciding whether money
moves twice. The generic layer sits in front of them.

As built (`lib/idempotency.ts`, table `idempotency_keys`): the key is optional,
a 2xx/4xx is stored and a 5xx releases the key, and the scope is the merchant
the credential resolves to. A reversal's identity is its body `external_ref`
only — the header is the retry layer, never a business identity. Three merchant
`POST`s stay outside it, each named in `routes/__tests__/idempotencyCoverage.test.ts`:
registration (it creates the scope), `client_action` (a read), and billing
(its own durable operation ledger with recovery).

### D4 — Events are a resource, and webhooks render them

An event is stored once (`evt_…`, queryable for 30 days via `/v1/events`) in the
same transaction that records the change — the rule `transitionIntent` already
enforces for webhook enqueueing (ADR 0001 D7). A webhook delivery is that event
sent to one endpoint.

As built (`services/events.ts`, tables `events`, `webhook_endpoints`,
`webhook_deliveries`): `recordEvent` is the one writer and fans out, in the same
transaction, one delivery per enabled endpoint whose `enabled_events` holds the
type or `*`. The envelope is `{id, object, type, created, livemode, api_version,
account?, data: {object, previous_attributes?}, request: {id, idempotency_key}}`;
`request` comes from the merchant API call (or dashboard write) the change was
part of and is `null` for a background change. Endpoints (`we_…`, at most 16 per
merchant) carry a Peable-generated `whsec_…` shown only on create and
`roll_secret`; a roll may keep the previous secret signing for up to 24 hours,
and every delivery in that window carries one `v1=` per secret. Deliveries retry
for about three days; an endpoint failing every attempt for three days is
disabled (`delivery_failures`). The merchant's single `webhook_url` /
`webhook_secret` were removed in the same change, each existing pair migrated to
one `['*']` endpoint keeping its secret.

Where a delivery may go is decided twice, by one rule each:

- **The URL rule is `webhookUrlProblem`** (`services/webhookEndpoints.ts`):
  https, http only in test mode, ports 80/443, no credentials, no blocked host
  or private/loopback/reserved IP literal. It refuses a URL at create and
  update (and re-enabling an endpoint judges the URL it would be sent to), AND
  the outbox judges the STORED URL by it before every delivery: a row that
  fails is never sent to, its delivery ends `failed` without an attempt, and
  the endpoint is disabled `url_refused`. The second judgement exists because
  the migration above did not go through the first: it copied
  `merchants.webhook_url`, which had been accepted as any `z.string().url()`,
  with only a scheme check, and so carried a live `http://127.0.0.1:9/ssrf`
  endpoint (`we_dcc4e42ee41ae60ad31bde53`) in as enabled. `safeFetch` refused
  each of its deliveries (`disallowed port 9`); nothing reached loopback.
- **The transport is `webhookDeliveryLane`** (`services/webhookDispatcher.ts`),
  the one place it is chosen. A VERIFIED first-party merchant's
  (`merchants.first_party`) endpoint whose URL is Oxy's own API — the SDK's
  `oxy.isFirstPartyServiceUrl`, exactly the configured API origin, never a
  hostname list here — goes through the shared `OxyServer`
  (`createServiceClient({ baseURL: oxy.baseURL, audience: 'oxy-api' }).fetch`,
  Peable's workload authority, no redirects). Every other URL goes through
  `safeFetch` with its full SSRF checks. Inside the VPC `api.oxy.so` resolves
  to a private address, which `safeFetch` refuses by design, so without this
  Oxy could never receive its own events. The merchant half is required
  because this lane carries Peable's bearer: a third-party merchant naming
  `api.oxy.so` stays on `safeFetch` and is refused there. Both lanes send the
  same signed bytes, with the same header deadline, and classify the answer
  the same way (2xx delivered, 5xx/timeout/transport failure retried, other
  4xx and SSRF refused).

### D5 — The contract is the source of truth

Every route's request and response schema lives in `packages/contracts` as Zod,
the backend validates with it, `/openapi.json` is generated from it for the whole
API, and the SDK's types are generated from that document. CI fails when the
generated document drifts, as it already does for contributions.

As built (`@peable.to/contracts` 1.0): one `defineRoute` per public route in
`packages/contracts/src/resources/<group>/`, objects registered once
(`defineObject`, expandable and embedded references resolved by `Expand<>`), the
backend importing the very schema objects it validates with, a test preload
checking every route-test answer against its contract, and a coverage test proving
the mounted routes and the contracts are one set. `docs/openapi.json` (OpenAPI 3.1,
with the webhook payloads) is gated by `check:openapi`; `@peable.to/sdk`'s
methods are generated from the routes' `sdk` paths (`check:sdk-resources`); the
API reference and the errors page of the developer docs are generated from the
document and from the error vocabulary (`check:api-docs`), and every `doc_url`
points at that page. Dashboard routes are not contracts.

D1 holds without exception: Peable Tax calculations, transactions, reversals and
the report, and the signed billing documents (tax quotes and final invoice
authorities, `schema_version: 3`), answer base-unit strings like every other
amount. Their last JSON numbers were cut at the root in one release
(`@peable.to/contracts`, `@peable.to/shared-types` and `@peable.to/sdk` 2.0;
migrations `0075`–`0076` rewrote the stored objects).

## Consequences

- Every published package that carries the wire takes a major version, and its
  consumers move with it; nothing keeps speaking the old shape.
- Internal invariants are untouched: public vs internal ids, the status
  compare-and-swap, the reservation statement, non-custody. The wire changes how
  a fact is *spelled*, never what the gateway decides.
- The provider's API version (`providers/stripe/apiVersion.ts`) remains a separate
  pin; Orbit's version never leaks the provider's.
- A 500 never carries `err.message` on any version; the request id is how support
  finds the cause.
