<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# The card rail's own invariants

Five, and each one exists because its absence was a defect:

- **A card payment is TWO things** — a row here, and a PaymentIntent at the
  acquirer that stays confirmable. Ending it locally (`POST …/cancel`, the expiry
  sweeper) without cancelling there leaves a payment the payer can still
  complete against a terminal status. `services/cardCancellation.ts` cancels and
  then reports what is TRUE, because the cancellation can lose; the sweeper
  handles the card rail one row at a time for that reason, and the chain rail
  keeps the fast set-based claim.
- **A payment and its CHARGE are different objects.** A transfer's
  `source_transaction` names the charge (`payment_intents.provider_charge_id`);
  handing it the `pi_…` makes Stripe answer `No such charge`, which reads as an
  outage.
- **An amount is not an identity.** `transfer_reversals` exists so two reversals
  of one settlement for the same amount are two operations. The cumulative total
  on `transfers.amount_reversed` is still the PROVIDER's figure and is never a
  sum of those rows.
- **A refund's `state` is read, always.** `pending` and `failed` are ordinary
  answers, and a bank can reject a refund days later (`refund.failed`): the row
  moves `succeeded → failed` and `amount_refunded`, being their sum, drops with
  it — no payment transition is needed, because a refund was never one.
- **A declined attempt is not terminal on the card rail.** It returns the
  payment to `requires_payment_method` with `last_payment_error`, confirmable
  again; an `underpaid` chain payment is `canceled`, and the rail argument of
  `applyEvent` plus `LEGAL_SOURCES` keep the two apart.

**Risk rules (ADR 0022) judge the card rail only, and act only through the
paths above.** A merchant's `rule_…` rules are DATA: `services/radar/language.ts`
parses Radar's language into closures over a fact record — never `eval`, never
`new Function`, never a regex from the merchant's text, never SQL — against the
closed `RADAR_FACTS` registry (contracts vocabulary), three-valued so an unknown
fact never matches. `allow` beats `block` beats `review`.
`services/radar/gates.ts` is the only place a decision acts:
`gateBeforeAuthorization` (in `confirmCardIntent`, a create with `confirm`, the
create's `client_action` and `POST …/client_action`, from
`requires_payment_method` and `requires_confirmation` — the latter judged with
the attached saved card; the payer's credential NEVER from `requires_action`,
where 3DS is in flight at the provider, while a server confirm from it is a new
attempt judged with the card it names; the merchant's GET evaluates read-only)
declines a `block`: from
`requires_payment_method` as a declined card — ONE `transitionIntentIn` to
`requires_payment_method` with `last_payment_error` (`blocked_by_rule`) plus the
evaluation row, still payable; from `requires_confirmation` or `requires_action` (a
card attached at the provider) WITHOUT moving the row — 402, no credential, nothing confirmed,
the evaluation recorded (a declined invoice collection records its failed
attempt itself). The same rule version declining again writes nothing. A fact a phase cannot know (the card before one is entered, the
provider's risk before authorization) is UNKNOWN even to `is_missing`. Payer
surfaces (client-secret reads, sockets, the checkout's session view, the
payer's 402) render through `toPayerPaymentIntentDTO`: no `blocked_by_rule`, no
`review`; `judgeAuthorization`, called from
`syncChargeSnapshot` after the snapshot is written, claims the charge ONCE
(`charges.radar_evaluated_at`) in a transaction that locks the payment row (no
review on a payment cancelled or fully refunded meanwhile), releases a blocked held authorization through
`cancelCardPaymentAtProvider` and moves the row only on `canceled`, and opens a
review for everything it cannot release — captured money is never refunded by a
rule. `POST …/capture` runs `holdBeforeCapture` first (judges if not judged, 503
when it cannot; 409 while a review is open). A review (`prv_…`, one per payment)
opens and closes only through `services/radar/reviewEvents.ts` with its
`review.*` event; a cancellation, a succeeded refund or a dispute closes it in
THEIR transaction; a refusal CLAIMS it (`pending_closed_reason`, a 10-minute lease
in `pending_closed_until`, held while its refund is pending) before it acts at
the provider. `services/radar/judgeSweeper.ts` retries a judgment that did not
land; existing charges were marked judged by the migration. Anything that is not `rail = 'card'` returns before the first
read: FairCoin never consults a rule, and a blocked card leaves the order's
FairCoin offered.
