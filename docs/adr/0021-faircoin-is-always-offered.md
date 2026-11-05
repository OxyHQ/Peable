# ADR 0021 — FairCoin is always offered

**Status:** accepted.
**Date:** 2026-11-05.
**Amends:** ADR 0012 (D5 `connected_account` on a fiat order, D12 the platform
fee), ADR 0015 §5 (the FairCoin ledger entry gains its fiat equivalent), ADR 0018
("as built" §3 *the rail follows the currency*, and the "not built" item
*FX-quoted FairCoin invoices on the engine*), ADR 0019 D5 (`payment_method_types`
of an order).
**Builds on:** ADR 0001 (non-custody, the reservation), ADR 0014 (one wire),
ADR 0016 (Orbit owns its objects), ADR 0017 (test and live).

## Context

The owner's rule (2026-11-05): *FairCoin must always be available and must not
be possible to turn off: anyone can always pay with FairCoin. The other (fiat)
methods are the merchant's to turn on and off, as in Stripe. Orbit must not be
able to disable FairCoin.*

Before this ADR the rail followed the order's currency. A `FAIR` order was
FairCoin-only and every fiat order was card-only (`sessionService.ts` `planRail`,
`linkService.ts`, `collect.ts` `railOf`, `createIntent.ts` `assertRailCurrency`).
A merchant without a watch-only key (both live first-party merchants, Oxy and
Mercaria, on 2026-11-05) could never be paid in FairCoin at all. The fiat-priced,
FX-quoted FairCoin path existed once, inside the Stripe-Billing proxy, and was
removed with it (#224, `f1dbf719`); ADR 0018 lists it as not built.

## Decisions

### D1. Every order surface offers FairCoin, and nothing can turn it off

An *order surface* is an object that holds an amount and lets the PAYER choose
how to pay it: a Checkout Session (hosted, embedded, and every SDK surface that
drives one — `mountCheckout`, the payer client behind *Pay with Peable*), a
payment link (a visit is a session) and an invoice's hosted page (one-off and
subscription invoices).

| Order currency | Offered |
|---|---|
| `FAIR` | FairCoin only, as before (no card can settle FAIR) |
| fiat | the merchant's fiat methods (its payment method configuration, unchanged) **and FairCoin** |

`payment_method_types` on a session (and on a public invoice) is therefore
`['card', 'faircoin']` for a fiat order and `['faircoin']` for a FAIR one. A
merchant may narrow the FIAT side (a session's `payment_method_types:
['faircoin']`, a configuration with card off); it can never remove FairCoin. A
request that would — a session's `payment_method_types` without `faircoin`, a
configuration's `faircoin.display_preference.preference: 'off'` — is a 400 with
the new closed error code **`payment_method_locked`**, `param` naming the field.
There is no flag and no per-merchant exception, Orbit's own dashboard included.

**A PaymentIntent stays ONE payment on ONE rail (ADR 0019).** The payer's choice
creates the intent for the chosen rail; it is never a rail switch on an existing
intent. A merchant that creates a raw card PaymentIntent and mounts the card
provider's Elements has chosen the card rail for that payment; Orbit's
documentation names Checkout Sessions (or a payment link, or an invoice) as the
integration that always offers FairCoin. Making a PaymentIntent multi-rail would
rewrite the status table, the rail CHECKs and every webhook consumer's model, and
is not done here.

### D2. The payment method configuration shows FairCoin, locked

`faircoin` is an entry of every `pmc_…` (`PAYMENT_METHOD_CONFIGURATION_TYPES`),
always `display_preference.value: 'on'`, with a new `locked: true` (every other
entry answers `locked: false`). Its `available` is `true` unless the merchant
has no FairCoin key (`unavailable_reason: 'faircoin_account_missing'`, test mode
only — D5). It is never pushed to the card provider and never appears in a card
PaymentIntent's `payment_method_types`. Orbit's Settings → Payment methods shows
it as a locked, always-on row with the reason in words.

### D3. The payer chooses; choosing FairCoin creates a quoted FairCoin intent

`POST /v1/checkout_sessions/:id/public/confirm` and `POST
/v1/invoices/public/:token/pay` take `payment_method_type: 'card' | 'faircoin'`
(default: the order currency's rail, so every existing client is unchanged).
Choosing `faircoin` on a fiat order:

1. reads a **quote** (D4) for the order's computed total — tax, discount and
   shipping included, exactly the amount a card would be charged;
2. creates a `faircoin`-rail PaymentIntent (currency `FAIR`, amount the quoted
   FAIR base units, address reserved from the payee's key in one statement, D5)
   that **carries the quote** (`faircoin_quote`) and expires when the quote does;
3. links it to the same session (or invoice) under the same compare-and-swap the
   card path uses — comparing the quote's FIAT amount with the order's.

Completion is unchanged and stays the payment's: `followIntentForCheckout` and
`onInvoicePaymentTransition` follow the FairCoin intent exactly as they follow a
FAIR-priced one (`processing` → `complete`/`unpaid`, `succeeded` → `paid`). An
invoice paid by a quoted intent records the quote's fiat amount as `amount_paid`,
never the FAIR figure.

**Switching.** A payer who confirmed one method may confirm the other while the
linked payment has not started moving money: the new intent is linked and the
old one cancelled in ONE transaction (a card one is cancelled at the provider
first; if that cannot be confirmed the switch is refused, because a card that may
still be charged must stay the order's payment). A FairCoin intent whose quote
lapses is cancelled by the expiry sweeper; because it is a QUOTED intent, the
session (or invoice) forgets it and stays open for a fresh quote instead of
expiring — the order's own deadline is the order's.

**Subscriptions.** FairCoin is never debited (ADR 0018 §3, unchanged). The rail
that pays a subscription's FIRST invoice decides its collection: a card is saved
and charged off-session (`charge_automatically`, as today); FairCoin moves the
subscription to `send_invoice`, so every renewal is an invoice the payer pays on
its hosted page, by card or by FairCoin, at that period's quote.

### D4. The quote is pricing, never exchange — one module, fail closed

`services/faircoin/quote.ts` is the ONE reader (the reader `faircoin-fx.ts` was,
rebuilt):

- **FAIR/USD** from the FairCoin Explorer's `GET /api/price` (verified
  2026-11-05: `{price, source: 'wfair-base', updatedAt, …}`), accepted only with
  `source: 'wfair-base'`, a positive price and an `updatedAt` no more than 120 s
  old (and not in the future).
- **Other fiat currencies** are priced through the European Central Bank's
  daily reference rates (`eurofxref-daily.xml`, every Orbit fiat currency is
  published there), crossed through USD; the rate set is accepted only when its
  date is no more than 5 days old (a weekend plus the TARGET Easter holidays).
  The Explorer publishes USD only, and Mercaria and Oxy sell in EUR: without a
  second, official source a EUR order could never offer FairCoin.
- The FAIR amount is `ceil(fiat base units ÷ rate)` in exact rational `bigint`
  arithmetic from the sources' decimal strings; no float enters it. The stored
  `rate` is the display rounding; the amount replays from the stored sources.
- A quote lives **10 minutes** (`expires_at`). Once the payer reports the
  broadcast (`processing`) the intent never expires (ADR 0012 D9); the watcher
  compares the FAIR amount, as for every FairCoin payment.
- **Unavailable or stale fails CLOSED for FairCoin only.** The option is shown
  with `unavailable_reason: 'price_unavailable'` and a confirm with `faircoin`
  is a 503 `faircoin_price_unavailable`; the card methods keep working. There is
  no cached, manual, last-known or guessed rate, and no fallback source.

The quote is stored with the intent (`payment_intents.faircoin_quote`, the wire
shape): order currency and fiat amount, `rate`, each source with its own rate
and `observed_at`, `quoted_at`, `expires_at`. It is a price label on a FairCoin
payment. **Peable never holds, buys, sells or converts FAIR** (AGENTS.md, product
boundary): the payer's wallet pays FAIR to the payee's own address; nothing is
exchanged, and no fiat moves on that payment.

### D5. FairCoin pays the payee's own watch-only key — so the key is required

Non-custody is unchanged: a FairCoin payment derives its address from the
merchant's (or the seller's) watch-only account xpub through the one-statement
reservation (`derivationIndex.ts`, `accountDerivationIndex.ts`).

- **A merchant's FairCoin key becomes required.** A merchant that registered
  without one may register it ONCE afterwards (`network` + `xpub`, immutable once
  set, `assertWatchOnly`, unique against every merchant and seller key — the
  rules of ADR 0012 D4) from Orbit (`money` permission) or its own service
  credential. Orbit's onboarding shows it as a required step.
- **A live merchant without a key cannot take payments**: creating a
  PaymentIntent, a Checkout Session or a payment link, and finalizing an invoice,
  answer 409 `faircoin_account_required` — never a silent card-only order. In
  test mode the order is created and the FairCoin option answers
  `unavailable_reason: 'faircoin_account_missing'`, so integrations can be built
  before the key exists.
- **Marketplace sellers (ADR 0012).** A seller is ready only once its OWN
  FairCoin key is registered from the seller's own Oxy session (D3 of ADR 0012,
  unchanged — a platform-supplied key is still impossible). A card-only seller
  reports the FairCoin key as a current requirement and is not payable — no
  transfer and no on-behalf payment — until it registers.
- **A fiat order on behalf of a seller** (`connected_account` on a fiat
  session, refused before) is now accepted: its FairCoin payment is an on-behalf
  intent paying the SELLER's key (ADR 0012 D5); its card payment is the
  platform's own charge, settled to the seller with the transfers it already
  makes (ADR 0015 §2, separate charges and transfers). On-behalf CARD charges stay
  ADR 0009's open question.

### D6. The marketplace's fee on a FairCoin sale: none

ADR 0012 D12 option (a), a second output to the platform's address in the payer's
transaction, cannot be expressed or verified today, measured in the code:

- a `faircoin:` URI (BIP 21, `@fairco.in/core`) names ONE address and one amount,
  so every external wallet could pay only the seller's half;
- `@peable.to/pay` `sendPayment` takes ONE `to` (`recipients: [{ address: to,
  value }]`);
- the settlement watcher verifies one transaction against ONE address and ONE
  amount (`verifyPayment(tx, address, amount)`); a fee output would be unverified
  money.

So a FairCoin on-behalf payment carries **no application fee**:
`application_fee_amount` on it stays a 400, the seller receives the whole amount
(the ledger already records `fee: '0'`), and the platform takes its commission on
the card rail, as ADR 0012 recommended. Revisit when a multi-output payment
request exists end to end (URI, wallet, `pay`, watcher).

### D7. The ledger records the fiat equivalent

The informational FairCoin entry (ADR 0015 §5) stays in FAIR and never payable;
a quoted payment's balance transaction also carries its `faircoin_quote` (order
currency, fiat amount, rate), so the merchant's books and the reports show what
the sale was priced at. No fiat balance is created by it.

## Consequences

- Contracts, shared-types and the SDK gain fields and one choice parameter
  (additive) plus `payment_method_locked`, `faircoin_account_required` and
  `faircoin_price_unavailable`; `PaymentMethodConfigurationEntry.locked` is new.
  A consumer that sends `payment_method_types: ['card']` on a fiat session must
  add `faircoin` (or omit the field).
- Migrations: `payment_intents.faircoin_quote` (hot table: alone, nullable, no
  default, CHECK `NOT VALID` then validated `post`); `checkout_sessions` drops
  the *network ⇔ FairCoin rail* and *connected account ⇒ FairCoin rail* CHECKs
  for *connected account ⇒ network*; `balance_transactions.faircoin_quote`.
- **The two live first-party merchants have no FairCoin key.** Until the owner
  registers Oxy Platforms' (and Mercaria's) own watch-only xpub in Orbit, their
  live checkouts answer `faircoin_account_required`. Only the key's holder can
  supply it: generating one for them would be custody.

## Not decided here

- A multi-rail PaymentIntent (D1), and with it FairCoin on raw card Elements.
- A FairCoin application fee (D6) and seller-assisted FairCoin refunds (ADR 0012 D10).
- Which fiat reference applies beyond the ECB's set (no Orbit currency needs one today).
