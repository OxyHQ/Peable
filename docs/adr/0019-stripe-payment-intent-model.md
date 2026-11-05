# ADR 0019 — Stripe's PaymentIntent model, at the root

**Status:** accepted.
**Date:** 2026-11-03.
**Amended by:** ADR 0021 D1 — an ORDER offers FairCoin beside its fiat methods; a PaymentIntent stays one rail.
**Amends:** ADR 0001 D5 (the per-rail status sets), ADR 0012 D9 (what can expire).
**Builds on:** ADR 0014 (one wire, changed at the root), ADR 0016 (Orbit owns its
objects), ADR 0017 (test and live).

## Context

Orbit is meant to read like Stripe to an integrator who knows Stripe. The
PaymentIntent was the one object that did not: thirteen statuses of Peable's own
(`created`, `awaiting_approval`, `approved`, `broadcast`, `confirming`,
`requires_action`, `processing`, `settled`, `refunded`, `partially_refunded`,
`expired`, `failed`, `rejected`), refunds as payment statuses, a `failed` that
meant "declined, retry" on a card and "underpaid, over" on the chain, a merchant
`reject` instead of `cancel`, no server-side confirm, no manual capture, no
customers or saved cards, and event names (`payment_intent.settled`,
`payment_intent.disputed`, …) that no Stripe integration listens for.

`awaiting_approval` and `approved` were never written by any path (audit of every
writer); they were a wallet flow that did not ship.

## Decision

### D1 — Seven statuses, Stripe's

`requires_payment_method`, `requires_confirmation`, `requires_action`,
`processing`, `requires_capture`, `canceled`, `succeeded` — on both rails, one
transition table (`shared-types/src/paymentIntent.ts`), with `succeeded` and
`canceled` terminal. The one exception stays where it was: a chain reorg rewinds
`succeeded → processing` (`applyEvent`, `reorg_below_threshold`).

| Rail | Lifecycle |
|---|---|
| FairCoin | created `requires_action` (`next_action.faircoin_payment` = address, network, amount, currency, `faircoin:` URI) → `submit_tx` → `processing` (the watcher counts `faircoin.confirmations` against `required_confirmations`) → `succeeded` · or `canceled` |
| Card | created `requires_payment_method` (or `requires_confirmation` when it names a saved `payment_method`) → `requires_action` (3DS; `next_action: use_peable_sdk`) → `processing` → `requires_capture` (manual) → `succeeded` · a declined attempt returns to `requires_payment_method` with `last_payment_error` · or `canceled` |

`CARD_ONLY_STATUSES` — `requires_payment_method`, `requires_confirmation`,
`requires_capture` — are refused on the chain by a CHECK: a FairCoin payment has
no payment method (the payer's wallet signs on their device), nothing to confirm
server-side and nothing to capture. `requires_action` and `processing` are
shared, so `applyEvent(status, event, rail)` now takes the rail and refuses a
card event on a chain payment (and the reverse) whatever the statuses say; the
CAS (`status = from`) and the same-transaction event (ADR 0001 D7) are unchanged.

### D2 — Cancellation is one status with a reason

`canceled` carries `cancellation_reason` and `canceled_at` (CHECKed to agree):

| Cause | `cancellation_reason` |
|---|---|
| The expiry sweeper (an unpaid intent ran out) | `abandoned` |
| `POST /v1/payment_intents/:id/cancel` | the merchant's `duplicate` / `fraudulent` / `requested_by_customer` / `abandoned`, or `null` |
| The provider cancelled it | `automatic` |
| A FairCoin transaction arrived that paid LESS than the amount | `underpaid` (Peable-only; with `last_payment_error.code = payment_underpaid`) |

An underpayment is terminal because Peable never holds the coins and the watcher
tracks one transaction; it emits `payment_intent.payment_failed` and then
`payment_intent.canceled`. `POST …/reject` is removed; `…/cancel` replaces it and
still cancels at the provider first (`cardCancellation.ts`), refusing with 400
`payment_intent_unexpected_state` when the payer won the race or the payment is
in flight. Expirable statuses are `requires_payment_method`,
`requires_confirmation`, `requires_action` — never `processing` (coins moving)
nor `requires_capture` (the merchant's to capture or release).

### D3 — Money is amounts, refunds are their own objects

The PaymentIntent gains `amount_capturable` (the authorized amount while
`requires_capture`), `amount_received` (stored; written with the transition to
`succeeded`, the captured amount — a partial capture receives less; any other
status resets it, so a reorg un-receives) and `amount_refunded` (the sum of
SUCCEEDED refunds, read in the same statement — never stored, the refund rows
are its one home). A refund moves no status: refund state is the Refund's,
reported by `refund.created` / `refund.updated` / `refund.failed`, and the
charge's running total by `charge.refunded`. `Refund.payment_status` is removed.
Refunds draw on `amount_received`.

### D4 — Charges (`ch_…`) are read-only records of the authorization

ONE per card PaymentIntent, written in the same transaction that first moves it
to `requires_capture` or `succeeded` (`ensureChargeForIntent`); failed attempts
are the intent's `last_payment_error`, not charges. `latest_charge` names it.
`GET /v1/charges/:id`, `GET /v1/charges?payment_intent=`; expandable from the
intent. Fields: amount, `amount_captured`, `amount_refunded` (sum of succeeded
refunds), `captured`, `refunded` (in full, or an uncaptured authorization
released by a cancellation), `disputed`, `outcome {network_status, risk_level,
type, seller_message}` and `payment_method_details.card` — a snapshot read from
the provider after the commit (best-effort, refreshed by `charge.*` events).
`seller_message` is Peable's own wording; `receipt_url` is `null` until
Peable-hosted receipts exist (the provider's URL would put the acquirer's brand
on Orbit's wire, ADR 0001 D3); `balance_transaction` is `null` until the ledger
(Phase 5). The provider charge id stays the binding it already was
(`payment_intents.provider_charge_id`). A FairCoin payment has no charge: its
chain side is `faircoin`.

### D5 — The chain side is one sub-object, and every id is public

`network`, `address`, `txid`, `confirmations` leave the top level for
`faircoin {network, address, txid, confirmations, required_confirmations}`
(`null` on a card); `next_action` carries what the payer must do;
`payment_method_types` is `['card']` or `['faircoin']`. `merchant_id` is the
merchant's PUBLIC `merch_…` (it was the internal uuid). The card's confirmation
credential is never on the intent — `next_action.use_peable_sdk` tells the
payer's client to fetch it through `POST …/client_action`.

### D6 — Customers, PaymentMethods, SetupIntents (ADR 0016)

`cus_…` (CRUD + list with `email`; delete is a tombstone that detaches every
method), `pm_…` (Peable's wrapper over a provider payment method: safe card
fields, billing details, customer; detach is permanent), `seti_…` (Stripe's six
statuses; its success creates the `pm_` attached to the customer). Card data is
collected by the provider's Elements in the browser and never reaches Peable.
The provider customer is a binding created lazily, per mode, the first time
something at the provider needs it (`customer_provider_bindings`,
`ensureProviderCustomer`); provider ids are never serialized and never accepted
where a Peable id is expected. A FairCoin customer has no `pm_`.

### D7 — The PaymentIntent API

Create accepts `customer`, `payment_method` (attached to that customer),
`confirm`, `off_session`, `setup_future_usage`, `capture_method`,
`receipt_email`, `description`, `statement_descriptor_suffix`, `shipping`,
`payment_method_types`, `return_url`. `POST …/confirm` confirms a card
server-side with a saved method (a decline answers **402** `card_error` with
`decline_code` and the intent; a challenge answers `requires_action`);
`POST …/capture {amount_to_capture}` captures a held authorization;
`POST …/cancel {cancellation_reason}`. Card-only fields on a FairCoin payment
are a 400 naming the field. `receipt_email`, `description` and `shipping` are
Orbit's and are not forwarded to the provider (a provider receipt would be the
provider's brand); `statement_descriptor_suffix` is, because it is what the
cardholder's statement shows. Every POST is under the generic idempotency layer.

### D8 — Stripe's event names

`payment_intent.created` (with the row), `.requires_action`, `.processing`,
`.amount_capturable_updated`, `.succeeded`, `.payment_failed`, `.canceled`;
`charge.refunded`; `refund.created|updated|failed`;
`charge.dispute.created|updated|closed`; `customer.*`, `payment_method.*`,
`setup_intent.*`. The status-derived events come from where the row landed
(`intentEventsFor`); a same-status write records nothing except a failed attempt.
`partially_funded` is not used: an underpayment is terminal (D2).

### D9 — Data is migrated, not projected

One wire (ADR 0014 D2): migration `0043` converts every stored row —
`payment_intents` statuses per rail (with reasons, `canceled_at`,
`last_payment_error` and `amount_received`), one `ch_…` per succeeded card
payment, stored `events` (types and `data_object`), webhook endpoints'
`enabled_events`, and empties the 24-hour `idempotency_keys` cache of the retired
wire. `0042` adds every new constraint on existing tables `NOT VALID`; `0045`
(post) validates them.

| Pre-0019 | 0019 |
|---|---|
| faircoin `created` / `awaiting_approval` / `approved` | `requires_action` |
| faircoin `broadcast` / `confirming` | `processing` |
| faircoin `failed` (underpaid) | `canceled`, `underpaid` |
| card `created` | `requires_payment_method` |
| card `failed` (declined) | `requires_payment_method` + `last_payment_error` |
| `settled` / `refunded` / `partially_refunded` | `succeeded`, `amount_received = amount` (refunds stay rows) |
| `expired` | `canceled`, `abandoned` |
| `rejected` | `canceled`, reason `null` (never recorded) |

## Consequences

- `@peable.to/shared-types` 0.11.0 and `@peable.to/sdk` 0.13.0 are breaking;
  checkout, the wallet, the Orbit dashboard and the browser SDK changed with them.
- The FairCoin billing acceptance (locking the FX quote) is now tied to the
  watcher's PROOF (`chainVerified`, `recordVerifiedChainPayment`) rather than to
  a status, since `submit_tx` and the watcher's sighting are one status now.
- A merchant integrating on Stripe's vocabulary reads statuses, reasons and
  events as Stripe documents them; the deliberate departures are amounts as
  strings (ADR 0014 D1), `faircoin` / `faircoin_payment`, `use_peable_sdk`, and
  the `underpaid` reason.
