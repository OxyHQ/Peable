<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# The PaymentIntent is Stripe's (ADR 0019)

Seven statuses on both rails — `requires_payment_method`,
`requires_confirmation`, `requires_action`, `processing`, `requires_capture`,
`canceled`, `succeeded` — one transition table in
`shared-types/src/paymentIntent.ts`, `succeeded`/`canceled` terminal (a chain
reorg's `succeeded → processing` is the one exception, in `applyEvent`).

- **The rail decides the path, and `applyEvent(status, event, rail)` takes it.**
  FairCoin: `requires_action` (`next_action.faircoin_payment`) → `processing` →
  `succeeded`/`canceled`. Card: all seven. `requires_action` and `processing`
  are SHARED, so a card event must never move a chain payment because the
  statuses match — the rail argument refuses it, `LEGAL_SOURCES` bounds each
  event's sources, and `CARD_ONLY_STATUSES` is a CHECK.
- **A declined card attempt is `requires_payment_method` + `last_payment_error`**
  (Peable's own message, chosen from the code — never the provider's prose), and
  stays payable; `payment_intent.payment_failed` is recorded even when the
  status does not move. A FairCoin underpayment is terminal (`canceled`,
  `underpaid`): Peable never holds those coins.
- **Cancellation is one status with a reason** (`cancellation_reason`,
  `canceled_at`, CHECKed together): expiry is `abandoned`, the merchant's
  `POST …/cancel` names one, the provider's is `automatic`. There is no
  `/reject`.
- **Refunds are not statuses.** `amount_refunded` is the sum of SUCCEEDED refund
  rows, read in the same statement and never stored; `amount_received` is
  written with the transition to `succeeded` (a partial capture receives less;
  leaving `succeeded` resets it) and is what refunds draw on. Refund events are
  `refund.*` and `charge.refunded`.
- **A card authorization that succeeded is ONE `ch_…`**, written by
  `transitionIntent` in the transaction that reaches `requires_capture` or
  `succeeded` (`ensureChargeForIntent`); its outcome/card snapshot is read from
  the provider after the commit. Failed attempts are not charges. The provider
  charge id stays the `provider_charge_id` binding.
- **Customers, payment methods and SetupIntents are Orbit's rows**
  (`cus_`/`pm_`/`seti_`, ADR 0016); the provider customer is a lazy per-mode
  binding (`customer_provider_bindings`), never serialized. Card numbers never
  reach Peable — the provider's Elements collect them.
- **Every id on the wire is public** — `merchant_id` is the `merch_…`; the chain
  side lives in `faircoin`; the card's confirmation credential is never on the
  intent (`next_action: use_peable_sdk` → `POST …/client_action`).

**Every merchant `POST` mounts `idempotent` (`lib/idempotency.ts`, ADR 0014 D3)
after its auth and scope middleware**, or is named with its reason in
`routes/__tests__/idempotencyCoverage.test.ts`, which walks the gateway. It is
a 24-hour request-replay layer IN FRONT of business idempotency (the intent's
unique key, `external_ref`), never a replacement for it — so never accept the
header as a business identity: the SDK mints a fresh one per call.

**Peable Tax (ADR 0011) decides whether a sale is taxed; a provider only says
how much.** `services/tax/` owns it for every rail. A covered sale the provider
cannot price fails closed, never zero; an uncovered one is zero and recorded as
`not_registered`. Only the owner's dashboard approval activates registrations,
and only official Oxy applications calculate on the platform's Stripe Tax
account. Location evidence never includes language, currency or timezone.
Refunds are reversals netted into the same report rows, never deletions of the
original transaction.

**Business compliance (ADR 0020) records and assesses; it never activates.**
`services/tax/compliance/*` holds onboarding facts, declared registration
statuses (always `unverified`), `tax_document` Files, the versioned rule set,
assessments, the review queue, deadlines and the action history. It writes no
`tax_settings` or `tax_registrations`, calls no provider, and nothing it stores
is read by the calculator — so no declaration, decision, service credential or
assistant can make Peable collect. Onboarding writes and review decisions are
Orbit-only (`billing:manage`); the merchant API reads and assesses. The rule
set is CODE, one immutable version per change (`ruleSet.ts`), with sources and
effective dates; an assessment stores its version and inputs and must replay
byte-for-byte. Everything outside the supported rules is `unsupported` —
report it, open a review item, infer nothing. Registration submission,
returns and remittance are `not_available` capabilities, never simulated
states. Never infer liability from an incorporation address, a company number,
a language or a currency, and keep company identifiers out of fixtures, logs
and issues.
