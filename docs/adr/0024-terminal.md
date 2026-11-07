# ADR 0024 — Terminal: in-person card payments are card payments, collected by a reader

**Status:** accepted, built (Orbit Phase 8, item "Terminal").
**Date:** 2026-11-07.
**Builds on:** ADR 0014 (Orbit wire), 0015 (funds flow, charge routing, the live gate), 0016 (Orbit owns its objects), 0017 (test and live in one deployment), 0019 (the PaymentIntent is Stripe's), 0021 (FairCoin is always offered), 0023 (a provider capability, provider first), and the provider boundary (`docs/integrations/payment-provider-boundary.md`).

## Context

Merchants on Orbit sell at a counter as well as online. Stripe Terminal is the
contracted provider's answer: card readers registered to locations, a
`card_present` PaymentIntent, and either a server-driven collection
(`POST /v1/terminal/readers/:id/process_payment_intent`) or the provider's
client SDKs (which need a connection token). Orbit's job is Stripe's shape
(`terminal.location`, `terminal.reader`, `terminal.connection_token`), the
merchant's events and Orbit's screens — without a second payment model.

That last point decides the design: a tap on a reader moves money exactly as a
card typed into Elements does, so it must go through exactly the same code.

## Decision

### D1 — A `card_present` PaymentIntent is a card-rail PaymentIntent

`payment_method_types: ['card_present']` (alone — `CARD_RAIL_PAYMENT_METHOD_TYPES`
gained `card_present`, the `payment_intents_payment_method_types_check` was
widened by migration) on `rail: 'card'`. Everything the card rail is, it is:
`createIntent` (the row first, then the provider object under `pay:<pi>`), the
charge routing decided once at create and replayed from the row
(`chargeRouting.ts`: first-party platform charge, the merchant's own onboarded
account as a destination charge `on_behalf_of` it with the fee schedule's fee
for `card`, the live gate `assertLiveMoneyAllowed` for a third-party live
merchant), every status change through `transitionIntent` with its CAS and
`applyEvent`'s rail argument, `ensureChargeForIntent` at
`requires_capture`/`succeeded`, `capture_method` `automatic` or `manual`
(captured with `POST /v1/payment_intents/:id/capture`), refunds, disputes,
settlement reads, expiry and cancellation through `cardCancellation.ts`.
Stripe's documentation for Terminal with destination charges places locations
and readers on the PLATFORM account and the routing on the PaymentIntent — the
shape Orbit already has.

What is different is only how it is confirmed:

- **never in a checkout**: a Checkout Session's and a payment link's methods
  are `card`/`faircoin` (their own enums) and a configuration never yields
  `card_present` (it is not a configuration type);
- **never with a saved card**: `POST /v1/payment_intents/:id/confirm` refuses a
  `card_present` intent, and a create refuses `payment_method`, `confirm`,
  `off_session`, `setup_future_usage` and `return_url` with it;
- **never FairCoin**: `card_present` is card-rail only; a FairCoin intent's
  types are `['faircoin']`. FairCoin stays offered everywhere it is today — a
  Terminal sale changes no checkout, link or invoice (ADR 0021);
- the provider's confirmation credential (`client_action`) is still answered,
  for an integration that collects through the provider's Terminal SDK.

Not built: `interac_present`, on-reader tipping (`process_config.skip_tipping`
is always sent `true` — a tip would change the amount Orbit's row holds), the
`card_present` details on the Charge (`payment_method_details` stays `null`
for a reader payment), saving a card from a reader (`generated_card`),
`set_reader_display`, refunds on the device, and dashboard-built reader
configurations. Orbit uses the `card` fee schedule for `card_present`.

### D2 — Locations and readers: provider first, Orbit ids bound to provider ids

`terminal_locations` (`tml_…`: display name, address, metadata) and
`terminal_readers` (`tmr_…`: label, device type, serial, status, last seen,
the location — a composite key to the SAME merchant's location — metadata, and
its action) are created at the provider FIRST under `tml:<id>` / `tmr:<id>`,
then the row (ADR 0023 D3's reasoning: a refusal — Terminal not enabled —
must not leave a row nothing can use; an orphaned provider location or reader
moves no money). The provider's ids never reach the wire. The provider is sent
Orbit's correlation id (`peable_terminal_location_id` / `…_reader_id`) and
never the merchant's metadata. A location with readers cannot be deleted (409
`terminal_location_in_use`, checked and enforced in the delete statement); a
reader collecting a payment cannot be deleted (409 `terminal_reader_busy`). A
simulated registration code (`simulated-…`) is refused in live mode.

### D3 — A reader's action is CAS-written, and only the provider's current read settles it

The reader's one action Orbit drives is `process_payment_intent`. Its record
on the row moves by compare-and-swap only (`db/terminal/terminalRepository.ts`):

1. **claim** — `in_progress` for the payment, stamped `action_started_at`,
   refused while the row is already `in_progress` (409
   `terminal_reader_busy`, after asking the provider whether that is still
   true);
2. the provider is asked under `tmrpi:<reader>:<claim time>` — a DEFINITIVE
   refusal (busy, offline, any 4xx, Terminal unavailable) **releases** the
   claim back to what it was (busy and offline readers are 409
   `terminal_reader_busy` / `terminal_reader_offline`); an unknown answer (a
   timeout, a 5xx) KEEPS it — the reader may be asking for the card, so it is
   not shown idle and cannot be deleted, and the stale-claim rule below lets
   the provider's read settle it;
3. **acknowledge** — the provider took it (`action_acknowledged_at`);
4. **settle** — `succeeded` or `failed` with the provider's failure CODE, once,
   guarded on the claim still being that attempt `in_progress`, with
   `terminal.reader.action_succeeded|action_failed` recorded through
   `recordEvent` in the same transaction.

`reconcileReader` (`services/terminal/terminal.ts`) is the ONE place a
provider reader read becomes a change — the drain (every `terminal.reader.*`
provider event means "re-read the reader", never "apply the event's copy",
which can describe an earlier attempt of the same payment on the same
reader), a retrieve, a collection, a cancel and the simulated tap. It settles
only an acknowledged attempt (or a claim older than a minute, so a request
that crashed between the claim and the provider cannot hold a reader forever),
never moves an action backwards, and treats a provider reader that is no
longer collecting that payment (reset, deleted, replaced) as an ended attempt
whose outcome is the PAYMENT's: the PaymentIntent is read first, and one the
provider authorized or captured settles the attempt `succeeded` — never
`action_failed`, on which an integration would retry and charge twice; one
that cannot be read leaves the attempt in progress for a later read. One
payment is collected by one reader at a time
(`terminal_readers_collecting_intent_key`; a second claim is 409
`payment_intent_unexpected_state`). The
failure message on the wire is Orbit's sentence for the code
(`TERMINAL_ACTION_FAILURE_MESSAGES`), never the provider's prose.

### D4 — The payment's outcome is the card rail's, not the reader's

A reader action settling does not write the PaymentIntent. The intent moves
on the provider's `payment_intent.*` events through the existing drain path,
and `reconcileReader` additionally runs `reconcileIntentWithProvider` after a
settlement so a success does not wait on the webhook — both are the card
rail's one path (`applyProviderPaymentResult`: CAS on the status read,
`transitionIntent`, the charge, the merchant's events). A decline leaves the
intent `requires_payment_method` with `last_payment_error` and
`payment_intent.payment_failed` (from the provider's event; a reconciliation
never records a failed attempt twice), collectable again on any reader. A
canceled or expired intent cannot be moved by a late reader success: the CAS
refuses it and the disagreement is left for an operator, as for every card
payment.

### D5 — Modes (ADR 0017)

Creating a location, a reader or a connection token is a NEW operation: the
credential's mode (`selectCardProvider`). Everything on a stored row — update,
delete, retrieve, a collection, a cancel, the drain — resolves by the row's
`livemode` (`selectStoredProvider`). A mode with no key, or a provider account
without Terminal (the adapter maps Stripe's permission and "not activated"
refusals to `TERMINAL_UNAVAILABLE_CODE`), is 503 `terminal_unavailable`;
nothing falls through to the other key. The drain refuses an event naming the
other mode's reader. Production runs the card rail live only, so a production
merchant's readers are live readers.

### D6 — Connection tokens are passed through, never stored

`POST /v1/terminal/connection_tokens` asks the provider for a fresh token and
answers it with `Cache-Control: no-store`. Unlike Stripe, `location` is
REQUIRED and must be one of the merchant's: readers live on the one platform
account every merchant shares, and an unscoped token reaches every reader on
it — another merchant's included.
It is the one merchant `POST` here without the generic idempotency layer
(`idempotencyCoverage.test.ts` names why): replaying a stored answer would keep
a credential for 24 hours, and minting two moves nothing.

### D7 — Test mode: the simulated tap is a fake input to the real path

`POST /v1/test_helpers/terminal/readers/:id/present_payment_method` (Stripe's)
asks the provider's simulated reader to read a test card; the provider decides
the outcome (its test amounts: an amount ending in `05` is a generic decline)
and the answer goes through `reconcileReader` like any read. It is refused in
live mode (403 `test_mode_only`) before anything is read, and the adapter
refuses a live call too.

### D8 — Risk rules (ADR 0022) do not evaluate card_present payments

Stripe Radar does not screen card-present payments, and a merchant's rule
written for online card attempts (velocity of a customer, the card's country
at a payer page) has no pre-authorization point on a reader: the cardholder
is in front of the merchant and the collection is the merchant's own act.
Merchant risk rules are therefore **not evaluated** for `card_present`
PaymentIntents — neither before authorization (a collection is not a payer
credential nor a server confirm) nor after (no review is opened, nothing is
held before capture). It is explicit in code (`isCardPresent` in
`services/radar/gates.ts`, checked by `gatesBeforeAuthorization`, the
post-authorization judgment — which still claims the charge, so the judge
sweep does not keep it — and `holdBeforeCapture`), never a side effect of the
charge snapshot lacking a `card`. This is a deliberate gap, not an oversight:
rules for in-person payments would need their own signals and are not built.

### D9 — Who may do it, and the live gate

Creating a location, registering a reader, minting a connection token and
collecting a payment on a reader pass the live money gate
(`assertLiveMoneyAllowed`, ADR 0015): a live merchant that is not an Oxy
product is refused 403 `live_payments_gated` until
`ORBIT_THIRD_PARTY_LIVE_PAYMENTS` opens it. Test mode is never gated.

The merchant API: reads `payments:read`, writes `payments:write`, every POST
idempotent but the connection token. Orbit: reads are `read`; registering
locations and readers, collecting a payment, canceling a reader's action and
the simulated tap are `money` (`billing:manage`) — registering hardware that
takes cards, and taking one, is money work. Orbit's "collect a payment" is a
dashboard-only route that creates the `card_present` PaymentIntent through
`createIntent` and hands it to the reader in one request; when the reader
refuses it (busy, offline, Terminal unavailable), the payment it just created
is ended through the card rail's own cancellation (`expireIntentNow`) rather
than left for nobody to collect.

## Consequences

- **Owner actions** (nothing here changes the Stripe dashboard): enable Stripe
  Terminal on the LIVE Stripe account (and on the test account if it is not),
  and subscribe the platform webhook endpoints to `terminal.reader.action_succeeded`,
  `terminal.reader.action_failed` (and `terminal.reader.action_updated`)
  besides the `payment_intent.*` events they already receive. Until Terminal
  is enabled, a merchant gets 503 `terminal_unavailable`. Order physical
  readers only once the live account is enabled.
- A merchant who sells online and in person has one PaymentIntent list, one
  ledger and one set of events; a reader is just how a card arrived.
- Not built, and listed in the parity doc: `interac_present`, tipping,
  `set_reader_display`, reader configurations, `generated_card`, on-device
  refunds, and `card_present` details on the Charge.
