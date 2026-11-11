<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Events and webhook endpoints (ADR 0014 D4)

**An event is stored once and a delivery is that event sent to one endpoint.**
`services/events.ts`'s `recordEvent` is the ONE writer of `events` (`evt_…`):
it inserts the snapshot — `data.object` as the API renders it now, the
`api_version` it was rendered under, `previous_attributes`, and `request`
(`Request-Id` + `Idempotency-Key` from `lib/requestContext.ts`, opened by the
`idempotent` layer and the dashboard's writes; `null` for a background change)
— and, in the SAME transaction, one `webhook_deliveries` row per ENABLED
`webhook_endpoints` row of the merchant whose `enabled_events` holds the type
or `*`. Every producer goes through it: `recordIntentEvent` /
`recordIntentCreated` / `recordRefundEvent` / `recordChargeEvent` /
`recordDisputeEvent` / `recordConnectedAccountEvent` /
`recordCustomerObjectEvent` in `intentTransition.ts`,
the billing-observation relay, the test event. A producer that wrote a delivery
directly would be an event `/v1/events` never shows. An event exists whether or
not any endpoint wants it.

- **The body is rendered from the stored event at attempt time**
  (`toEventDTO`), never stored on the delivery and never rebuilt from the
  resource as it is now. A redelivery is a new delivery of the same event.
- **The endpoint secret is Peable's (`whsec_…`, `services/webhookEndpoints.ts`),
  shown only by the create and `roll_secret` responses**, and a protected
  column (`db/protectedColumns.ts`): only `findEndpointSigningTarget` reads it.
  A roll with `expires_in_seconds` (≤ 24h) keeps the previous secret signing
  beside the new one — two `v1=` per delivery — until then.
- **One URL rule, judged at create, update AND before every delivery**
  (`webhookUrlProblem`: https, http only in test mode, ports 80/443, no
  credentials, no blocked host or private IP literal). The outbox judges the
  STORED url: one that fails is never sent to and its endpoint is disabled
  `url_refused` (migration 0040 copied `merchants.webhook_url` without the
  rule); re-enabling judges the url it would be sent to. Never write
  `webhook_endpoints.url` on a path that skips it.
- **One lane decision, `webhookDeliveryLane`** (`services/webhookDispatcher.ts`):
  a VERIFIED first-party merchant's (`merchants.first_party`) endpoint on Oxy's
  own API — `oxy.isFirstPartyServiceUrl`, the SDK's answer, never a hostname
  list here — goes through `OxyServer`'s
  `createServiceClient({ baseURL: oxy.baseURL, audience: 'oxy-api' }).fetch`
  (inside the VPC `api.oxy.so` is a private address `safeFetch` refuses);
  every other URL through `safeFetch`, which resolves and checks DNS on every
  attempt. That lane carries Peable's bearer, so a third-party merchant's
  `api.oxy.so` URL stays on `safeFetch`. Same bytes, signature, deadline and
  classification on both lanes.
- **Retries span ~3 days** (`WEBHOOK_RETRY_SCHEDULE_MS`, ±20% jitter);
  `recordEndpointAttempt` folds every attempt into the endpoint's
  `failing_since` run in ONE statement and disables it with
  `disabled_reason = 'delivery_failures'` once the run is three days old. A
  claimed delivery whose endpoint is disabled ends `failed` without an attempt.
- **Retention is 30 days** (`services/eventSweeper.ts`); every read filters on
  the same horizon. Deleting an event or an endpoint cascades to its deliveries.
- **The catalog is `WEBHOOK_EVENT_SCOPES`** (`schema/valueSets.ts`) — Stripe's
  names since ADR 0019: `payment_intent.created|requires_action|processing|
  amount_capturable_updated|succeeded|payment_failed|canceled`,
  `charge.refunded`, `charge.dispute.created|updated|closed`,
  `refund.created|updated|failed`, `customer.*`, `payment_method.*`,
  `setup_intent.*`. The intent events derive from where the row landed
  (`intentEventsFor`); a same-status write records nothing but a failed
  attempt. A new type
  is one entry there plus `WebhookEventPayload`, and a migration for the
  `events_type_check` / `webhook_endpoints_enabled_events_check` it widens.
  `webhook_endpoint.test` is TARGETED (`TARGETED_WEBHOOK_EVENT_TYPES`): sent to
  the one endpoint it names, never subscribable.
- `merchants.webhook_url` / `webhook_secret` no longer exist; nothing routes an
  event through the merchant row.

An account acts through the provider on its OWN row, never
`resolveCardProvider()` — that is only for opening a new one.

**Identity verification keeps the verdict, never the person (ADR 0023).**
`verification_sessions` (`vs_…`) hold the merchant's configuration and the
provider's verdict (status, error CODE, redaction); `verification_reports`
(`vr_…`) each check's outcome. No column holds a name, date, number, address,
image or file id, and nothing ever will: `verified_outputs` is read LIVE on a
retrieve that asks for it (`no-store`, never in a list, an event or Orbit), the
hosted `url` / `client_secret` are passed through and never stored, and the
provider is sent Orbit's correlation id but never `client_reference_id` or
metadata. The Stripe adapter (`providers/stripe/identity.ts`) is the firewall:
`IdentityVerifyingProvider` carries verdicts only. A session is created at the
provider FIRST (an Identity-less account leaves no row); every later change goes
through `applyVerificationSnapshot` — CAS on status, the report once, the
`identity.verification_session.*` event in the same transaction. Redaction
erases the session's metadata and `client_reference_id` in the row (a CHECK) AND
in its stored events (`redactVerificationSessionEvents`). A mode without a key
or an account without Identity is 503 `identity_unavailable`. Orbit: reads
`read`, writes `money`.

**A Terminal sale is a card payment collected by a reader (ADR 0024).** A
`card_present` PaymentIntent (`payment_method_types: ['card_present']`, alone)
is on the card rail and takes ALL of it — `createIntent`, routing and the live
gate decided at create, `transitionIntent` with CAS, the charge, capture,
refunds — and is never offered in a checkout or a link, never confirmed with a
saved card, never FairCoin. Locations (`tml_…`) and readers (`tmr_…`) are created
at the provider first; a reader's action moves only through
`terminalRepository`'s compare-and-swaps (claim → acknowledge → settle, keyed by
`action_started_at`), and `reconcileReader` (`services/terminal/terminal.ts`) is
the ONE place a provider reader read becomes a change — always the provider's
CURRENT read, never an event's copy, settled once with its
`terminal.reader.action_*` event in the same transaction. The action never
writes the PaymentIntent: the intent moves on `payment_intent.*` events and
`reconcileIntentWithProvider`. Connection tokens are passed through, never
stored or replayed, and ALWAYS limited to one of the merchant's locations
(readers share the platform account; an unscoped token reaches every
merchant's readers). Merchant risk rules do not evaluate `card_present` (`isCardPresent` in
`radar/gates.ts`). A reader that no longer shows a collection settles it from
the PAYMENT's status, never `action_failed` for money the provider took; only a
definitive refusal releases a claim; one payment, one collecting reader. Live
Terminal objects and collections pass `assertLiveMoneyAllowed`. A mode
without a key or an account without Terminal is 503 `terminal_unavailable`.
Orbit: reads `read`, writes (and the collect / simulated tap) `money`.

**Stripe stays behind the provider interface.** Its SDK and adapter live under
`services/providers/stripe/`; the rest of the gateway talks to
`services/providers/provider.ts` through `registry.ts`, and
`providers/__tests__/providerBoundary.test.ts` fails on a Stripe import anywhere
else outside its named exceptions. A new provider capability is a method on the
interface, implemented there. There is no multi-provider routing until a second
provider is contracted (a business decision), and no abstraction built for one.

**Test and live live in ONE deployment, and the credential selects the key
(ADR 0017).** `STRIPE_SECRET_KEY_TEST` and `STRIPE_SECRET_KEY_LIVE` (each with
its own publishable key and platform/connect endpoint secrets, all `_TEST`/`_LIVE`)
are each optional; there is no `STRIPE_SECRET_KEY` and no fallback to one, and
the gateway refuses to BOOT on a key whose prefix contradicts its variable's
mode. The registry is keyed by `(provider, mode)`, and
`services/providers/environmentGuard.ts` is the SELECTOR: `production` ⟺ live,
every other environment ⟺ test, before the first provider call of a new
operation. An operation on a STORED object — refund, cancel, transfer,
reversal, dispute response, settlement read, account refresh, sweeps — resolves
by the row's `livemode` (`selectStoredProvider`), which every repository reads
from the row's merchant in the same statement (`db/merchants/merchantLivemode.ts`),
never by a process-wide default. A mode with no key is a card rail that is off:
503, and nothing falls through to the other key. Inbound Stripe webhooks arrive
on the same two paths for both modes: the mode whose secret verifies a delivery
is its mode, an event whose `livemode` disagrees with that secret (or whose mode
has no key) is refused 400, and the drain refuses an event of a key-less mode or
one naming an object of the other mode. Tax holds one Stripe Tax provider per
configured mode. Every merchant-scoped DTO and the event envelope carry `livemode`.
Peable holds the provider credentials and merchants supply none — ADR 0009,
which supersedes ADR 0001 D3 and leaves the merchant-of-record decision
explicitly open.

**Every status change fans out through ONE path**, and a route that writes a
status with `updateIntentState` and returns changes the database and tells
nobody. That path is `transitionIntent` in `services/intentTransition.ts`: it
advances the row AND records the merchant's event (with its deliveries) **in the
same transaction** (ADR 0001 D7), then the caller calls `announceIntentChange`
after the commit for the two transports that are not durable — the payer's
socket frame and the outbox kick. A batch producer that cannot go one row at a
time takes `recordIntentEvent` on its own `tx` instead, as the expiry sweeper
does.

The ordering is the whole point and it is easy to undo: enqueue after the commit
and the outbox becomes the best-effort delivery it was built to replace; emit
the socket frame inside the transaction and a payer is told about a transition
that then rolled back.

**A status write is a COMPARE-AND-SWAP, and `IntentStateChange.from` is the
compare half.** Every caller reads the intent, decides a target with
`applyEvent` — a pure function over that earlier read — and only then writes, so
without `status = from` in the WHERE the state machine is advisory: `ALLOWED`
has `canceled: []`, and an event racing `expireDueIntents` still wrote
`succeeded` over an expired intent and enqueued a second, contradicting outcome
for one payment. The same statement writes what the transition decides with it
— `last_payment_error` (cleared by any other transition),
`cancellation_reason`/`canceled_at`, `amount_received`, the txid.
`from` is required so a caller that cannot name where it started does not
compile, and the result is three-way — `updated` / `stale` / `missing` — because
a route answers 409 for a row that moved and 404 for one that is not there.
`expireDueIntents` needs none of this: its own statement carries the status
predicate and `for update skip locked`.

**The live tail is a `NOTIFY` inside the writing transaction, and test mode
only.** `recordEvent` (and the request-log writer, `lib/requestLog.ts`) signal
`services/liveTail.ts`'s channel for a TEST-MODE row on the same `tx`, so
`GET /v1/events/stream` / `/v1/request_logs/stream` (SSE, `lib/liveStream.ts`)
hear of a row at its commit and never of a rollback, on every ECS task. The
payload is ids only; the stream reads the row back through its repository.
Never emit to a stream from anywhere else, and never signal a live row (a
NOTIFY commit takes a database-wide lock on the shared instance). Test helpers
(`/v1/test_helpers/*`, `services/testHelpers.ts`) are fake INPUTS to the real
code — `reportFaircoinBroadcast`, the watcher's `applyChainObservation`, the
sweep's `expireIntentNow` — never a status write of their own.
