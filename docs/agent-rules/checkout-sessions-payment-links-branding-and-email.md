<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Checkout Sessions, Payment Links, branding and emails (Orbit Phase 3)

A Checkout Session is an ORDER (`services/checkout/`): priced lines
(`checkout_session_line_items`, each keeping a snapshot of the price it was
priced with), at most one discount, Peable Tax and the fields to collect. Its
rules, each of which is easy to undo:

- **FairCoin is always offered, and nothing turns it off (ADR 0021).** A fiat
  order's `payment_method_types` is `['card', 'faircoin']` (a FAIR one's
  `['faircoin']`) and the session carries the payee's `network`; a session
  `payment_method_types` without `faircoin` is 400 `payment_method_locked`, and
  `['faircoin']` on a fiat order is a FairCoin-only one (`card_offered = false`:
  the fiat methods are the merchant's to turn off, FairCoin never is).
  The payer chooses at confirm (`payment_method_type`). FairCoin on a FIAT
  order is a FairCoin PaymentIntent for the QUOTED FAIR amount
  (`services/faircoin/quote.ts`, the ONE reader: Explorer FAIR/USD `wfair-base`
  ≤ 120 s, ECB reference rates ≤ 5 days for other fiat, exact bigint ceil, a
  10-minute quote stored on the intent as `faircoin_quote`), linked like any
  payment and compared by `orderAmountOf` (the quote's fiat amount). A stale or
  missing price fails CLOSED for FairCoin only (`price_unavailable`, 503
  `faircoin_price_unavailable`) — never a cached or guessed rate. Choosing the
  other method REPLACES an unpaid payment in one transaction that links the new
  one first and then cancels the old (a card at the provider before it); a
  quoted payment that lapses UNLINKS (the order stays open), never expires the
  session. It is pricing, not exchange: Peable never holds, buys, sells or
  converts FAIR. A fiat session naming a seller pays the seller's key in
  FairCoin; its card payment is the merchant's own charge.

- **The payment exists only once the payer confirms** (`POST
  /v1/checkout_sessions/:id/public/confirm`), created with the amount the
  session computed and the idempotency key `checkout:<cs>:<amount>`, so a
  retried confirm finds the same payment and a re-priced order a new one.
  Nothing about creating a session, or visiting a payment link, mints a payment
  or reserves an address.
- **Completion is the payment's, never a client's.** `recordIntentEvent` calls
  `followIntentForCheckout` (and `applySetupResult` calls
  `followSetupIntentForCheckout`) in the transition's transaction: succeeded →
  `complete`/`paid`; manual-capture authorized → `complete`/`unpaid`; FairCoin
  `processing` → `complete`/`unpaid`, then `async_payment_succeeded|failed`;
  cancelled → open session `expired` (a quoted FairCoin payment: unlinked).
  The rail is the PAYMENT's, never the session's (a fiat order can be a
  FairCoin sale). Hosted/embedded checkout redirect or post
  `complete` only after re-reading the session — never on a provider callback.
- **Totals come from `services/checkout/totals.ts` over `pricing.ts`** — the
  discount is the order's, a percentage rounded per line, an amount off
  allocated in proportion; tax is priced on the discounted line. Tax fails
  CLOSED: `automatic_tax.status: failed` blocks confirm, never zero.
- **A promotion code's redemption is reserved at confirm and counted at
  completion.** The confirm links the payment in ONE transaction under the
  code's (and coupon's) row lock, counting the open sessions already holding
  it; completion increments `times_redeemed` in one guarded `UPDATE`. A
  read-then-write here gives the last redemption to two payers.
- **Every session write is a compare-and-swap** — the payer's edit on
  `updated_at` and "no payment yet", completion and expiry on `status`.
- **Payer routes are anonymous** (`…/public`, `…/public/confirm`, `GET
  /v1/payment_links/:id/public`, `POST /v1/payment_links/:id/checkout_sessions`):
  authorized by the session's `client_secret` in `X-Peable-Client-Secret`,
  never an Oxy session, never a URL. A checkout event is merchant-scoped and carries no
  `payment_intent_id` (`events_intent_event_has_intent_check`).
- **A multi-seller order pays every seller in ONE FairCoin transaction (ADR 0021
  D6).** A line may name its seller (`line_items[].connected_account`, exclusive
  with the session's). FairCoin's quoted total is split by each recipient's
  lines' `amount_subtotal` in `services/faircoin/split.ts` (bigint, largest
  remainder, ties to the earlier recipient) — never re-derive it; one address is
  reserved per output on THAT recipient's cursor; the intent's outputs are
  `payment_intent_outputs`, read through `faircoinOutputsOf` (an older intent is
  its one output). The watcher pays only when EVERY output is paid; one short is
  `canceled` `underpaid`. A seller not ready makes FairCoin unavailable
  (`faircoin_wallet_missing`), never refuses the order; a share at or below dust
  is 409 `faircoin_amount_too_small`. The card payment stays the merchant's
  platform charge (it pays sellers with transfers). There is never a fee output.
- **`payment_intent_data.metadata` is copied to every payment a session creates**
  (each method, each quote; ADR 0021 D8) — a platform matches events by its own id.
- **`mode: 'subscription'`** is validated and refused with 400 `param: mode`
  until the billing engine calls `registerSubscriptionCheckoutFulfiller`.
- **Payment links are over prices**; their lines are fixed once shared and only
  contribution links keep an `amount` (`payment_links_amount_shape_check`). A
  link visit's `Idempotency-Key` is unique per link
  (`checkout_sessions_link_operation_key`).
- **Branding** is a closed set or a validated colour (`merchant_branding`);
  the icon is the avatar and the logo the merchant's `business_logo` File —
  written through `applyMerchantPatch`, never a second copy.
- **Emails are an outbox** (`customer_emails`, enqueued in the change's
  transaction, deduplicated per subject) rendered at send time and handed to
  the INJECTED `Mailer` (`services/email/mailer.ts`); no shared Oxy mail
  client exists, so production registers an adapter over the outbound relay
  (`~/Oxy/docs/outbound-mail-relay.md`). Receipt numbers are claimed by one
  upsert (`claimReceiptNumber`), the receive cursor's pattern.
