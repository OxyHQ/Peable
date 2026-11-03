# ADR 0014 — Orbit API conventions, and a dated version that can change them

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
| Money | `amount` as a base-unit **string** (unchanged — a FAIR amount does not fit a JS number) plus a lowercase ISO-ish `currency` (`eur`, `usd`, `fair`) |
| Metadata | `metadata: Record<string,string>` on every mutable resource; ≤ 50 keys, key ≤ 40 chars, value ≤ 500 chars; an empty string value unsets a key |
| Lists | `{object:'list', data, has_more, url}`; `limit` (1–100, default 10), `starting_after`, `ending_before`, `created[gt|gte|lt|lte]` |
| Expansion | `expand[]`, dot paths, max depth 4, always resolved inside the caller's merchant scope |
| Errors | `{error:{type, code?, decline_code?, param?, message, doc_url?, request_id}}` |
| Status codes | 400 invalid request, 401 authentication, 402 payment refused (`card_error`), 403 permission, 404 not found, 409 conflict / idempotency in flight, 422 **not used** on the new version, 429 rate limit, 5xx ours |
| Request id | `Request-Id` response header on every response, and `request_id` inside every error body |

Amounts stay strings — that is the one deliberate departure from Stripe, and it
is a correctness rule (`CONVENTIONS.md` §Money), not a style.

### D2 — Versions are dated, pinned, and translated at the edge

- A request may send `Peable-Version: YYYY-MM-DD`. Without it, the merchant's
  pinned version applies (stored on the merchant, set to the latest version at
  registration, upgraded only by the merchant).
- Handlers produce ONE internal representation. Versioning lives in
  `backend/src/lib/apiVersion/`: an ordered list of versions, each with request
  and response transforms that convert between it and the next. A response is
  produced at the latest version and walked back to the caller's.
- `2026-07-18` is frozen as the **legacy** version: its transforms reproduce
  today's camelCase/ISO/422 wire byte-for-byte, proven by snapshot tests, so no
  published SDK or existing integration changes behaviour.
- The first Orbit version introduces D1. Later breaking changes add a version;
  additive changes (a new field, a new endpoint, a new event type) do not.
- A webhook endpoint carries its own `api_version`; its events are rendered at
  that version (D4).

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

### D4 — Events are a resource, and webhooks render them

An event is stored once (`evt_…`, queryable for 30 days via `/v1/events`) in the
same transaction that records the change — the rule `transitionIntent` already
enforces for webhook enqueueing (ADR 0001 D7). A webhook delivery is that event
rendered at the endpoint's `api_version` and sent to one endpoint.

### D5 — The contract is the source of truth

Every route's request and response schema lives in `packages/contracts` as Zod,
the backend validates with it, `/openapi.json` is generated from it for the whole
API, and the SDK's types are generated from that document. CI fails when the
generated document drifts, as it already does for contributions.

## Consequences

- The published `@peable.to/sdk` keeps working unchanged against the legacy
  version; the SDK 1.0 major moves to the Orbit version and pins it.
- Internal invariants are untouched: public vs internal ids, the status
  compare-and-swap, the reservation statement, non-custody. A new version changes
  how a fact is *spelled*, never what the gateway decides.
- The provider's API version (`providers/stripe/apiVersion.ts`) remains a separate
  pin; Orbit's version never leaks the provider's.
- A 500 never carries `err.message` on any version; the request id is how support
  finds the cause.
