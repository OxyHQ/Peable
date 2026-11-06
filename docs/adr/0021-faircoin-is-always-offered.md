# ADR 0021 — FairCoin is always offered

**Status:** accepted.
**Date:** 2026-11-05; D5 amended 2026-11-06; D6 amended 2026-11-06 (multi-recipient), D8 added; D9 and D10 added 2026-11-06 (mainnet security review), both amended 2026-11-06 (review round 2).
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
entry answers `locked: false`). Its `available` is `true` unless the owning account's Peable wallet is not set
up (`unavailable_reason: 'faircoin_wallet_missing'`, D5). It is never pushed to the card provider and never appears in a card
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

### D5. FairCoin is received into the Peable wallet of the account that owns the payee — no key is ever registered

**Amended 2026-11-06 (owner's decision; supersedes the first D5 and #236 at the
root, reverted by #240).** A merchant must not paste or register a FairCoin key.
FairCoin paid to an Orbit merchant goes to the **Peable wallet of the Oxy
account that owns the merchant's application** — a person or an organization
(organizations get their own identity root: OxyHQ/oxy ADR on organization
wallets) — and a marketplace seller's FairCoin to the Peable wallet of the
seller's own Oxy account. There is ONE way: the identity wallet. The watch-only
xpub mechanism is removed.

- **Derivation is social receive's (ADR 0002).** The recipient's public key is
  its DID's `#key-1` (`resolveIdentityPublicKey`, by name), the address is
  `deriveSocialReceiveAddress(key, index, network)` from `@fairco.in/core`, and
  the index comes from the recipient's ONE cursor (`social_receive_cursors`,
  `INSERT … ON CONFLICT DO UPDATE … RETURNING next - 1`, the identity key written
  on every reservation). Merchant payments, seller payments and `@username`
  payments to the same account share that cursor and that tree — the wallet
  already scans it — so two payments can never be handed the same address. The
  gateway handles a PUBLIC key only; the private key lives on the holder's
  devices, and Peable never holds one.
- **Who receives is recorded, not re-derived.** The merchant row mirrors its
  application's VERIFIED owner account (`merchants.owner_account_id`, synced
  from the credential's `ownerAccountId` and the dashboard's application read on
  every authenticated request, like `first_party`). A FairCoin payment stores
  the account it pays (`payment_intents.faircoin_recipient_account_id`) beside
  the address it was reserved at; a key rotation afterwards does not move that
  address (ADR 0002: funds received under a key are spendable with that key).
  Since ADR 0002's 2026-11-06 amendment the address also records the key it was
  derived from, and a payment nobody has paid yet under a replaced key is
  canceled `recipient_key_changed` so the order takes a fresh address.
- **Network.** A merchant's FairCoin network is its environment's: `mainnet` in
  live mode, `testnet` otherwise (rows that already chose one keep it — their
  payments reference it). Minting a mainnet identity address is ADR 0002's
  deployment gate (`PEABLE_SOCIAL_PAY_NETWORK`); while that deployment says
  `testnet`, a live order's FairCoin option answers `faircoin_network_closed`.
- **A recipient without a wallet** (a keyless, custodial account; an
  organization whose owners have not created its root; a merchant whose owner is
  not yet known) is never refused and never silently card-only: the order is
  created, FairCoin is shown unavailable with `unavailable_reason:
  'faircoin_wallet_missing'` ("the merchant's Peable wallet isn't set up"), and
  confirming FairCoin is 409 `faircoin_wallet_missing`. Orbit shows the owners a
  setup task: open Peable, signed in as (or acting as) the owning account, and
  create its wallet. There is no live-mode payment gate.
- **Marketplace sellers (ADR 0012, amended).** The platform still names the
  seller's Oxy account (`faircoin.oxy_user_id`), and the seller still CONFIRMS
  from their own Oxy session through the hosted onboarding link — the consent
  that makes provenance a property of the code path (ADR 0012 D3). The link no
  longer carries a key: confirming activates the FairCoin half, refused 409
  `faircoin_wallet_missing` while the seller's account has no identity key.
  On-behalf payments reserve on the SELLER's cursor and pay the seller's wallet.
- **A fiat order on behalf of a seller** is accepted: its FairCoin payment pays
  the seller's wallet; its card payment is the platform's own charge, settled with
  the transfers it already makes (ADR 0015 §2). On-behalf CARD charges stay ADR
  0009's open question.
- **What is removed:** `merchants.xpub` and `next_derivation_index`, the
  connected accounts' `xpub` and `next_derivation_index`, `derivationIndex.ts`,
  `accountDerivationIndex.ts`, `reserveAddress.ts`, xpub derivation and
  `assertWatchOnly` (there is no extended key left to guard), the registration
  and onboarding `xpub` parameters, and the wallet's "register this pocket" step.
  **Existing rows** (read-only production read, 2026-11-05): three merchants
  (`merch_05af…`, `merch_28f7…`, `merch_ae2f…`, the "ctf" test merchants, owned by
  two personal accounts and one organization) and one seller (`ca_7a1c…`) hold an
  xpub. Their past payments keep their addresses, so the watcher still settles
  them (one is `processing`); the money is in those holders' xpub wallets, which
  Peable never touched. Their keys are dropped in a `post` migration; new
  payments for them go to their owners' identity wallets. No other row holds a key.

### D6. A FairCoin payment pays every seller of the order directly, in ONE transaction; the marketplace's fee on it: none

**Amended 2026-11-06 (owner's rule: *anyone can always pay with FairCoin* —
a marketplace cart of several sellers included).** The first D6 measured that a
second output could not be expressed or verified (one `faircoin:` address, one
`to` in `@peable.to/pay`, one address in the watcher). That is now built, for the
outputs that pay SELLERS — never for a fee:

- **A FairCoin payment has an ordered list of outputs** (`payment_intent_outputs`,
  one row per output, written in the intent's transaction; a payment to one
  payee is the one-output case, the same rows and the same code). Each output
  names the account it pays (`connected_account_id`, `null` for the merchant's
  own owner), the Oxy account whose Peable wallet receives, the address — ONE
  reservation per output on THAT account's cursor (ADR 0002, D5), so every
  seller's address is in the seller's own tree — and the amount.
  `payment_intents.address` / `faircoin_recipient_account_id` keep output 0
  (the CHECKs and the address index stand); an intent written before the table
  has no rows and reads as its one output from those columns.
- **Who a line pays.** A Checkout Session line may name its seller
  (`line_items[].connected_account`, exclusive with the session's
  `connected_account`). A line without one is the merchant's own sale. Every
  seller must be ready for FairCoin on the order's network, with a Peable wallet;
  otherwise FairCoin is shown unavailable on the order (`faircoin_wallet_missing`)
  and the card keeps working — the order is never refused for it.
- **The split is pricing, exact and in `bigint`** (`services/faircoin/split.ts`):
  the quoted FAIR total (D4) is divided by each recipient's subtotal (the sum of
  its lines' `amount_subtotal`, before discount and tax). Each share is the
  floor of `total × subtotal ÷ Σ subtotals`; the units left over (fewer than the
  number of recipients) go one each to the recipients with the largest
  remainders, ties to the earlier recipient (first line order) — the largest
  remainder method. A recipient whose share is zero gets no output; a share
  below the network's dust threshold refuses the FairCoin confirm (409
  `faircoin_amount_too_small`; the card keeps working), because the network
  would not relay it and no part of a seller's share may go to someone else.
- **One transaction, signed by the payer.** `next_action.faircoin_payment.outputs`
  (and `faircoin.outputs`) list every output; `address` and `uri` are the one
  output's when there is one and `null` when there are several (a BIP 21
  `faircoin:` URI names one address, so an external wallet cannot pay such an
  order and is not offered it). The `peable://pay` request carries
  `outputs=<address>:<amount>,…`; the Peable wallet signs one transaction with
  one output per entry plus its change. `@peable.to/pay`'s `sendPayment` and
  `quotePayment` take `recipients` (the fee is sized for every output).
- **The watcher verifies EVERY output** (`verifyPayment(tx, outputs)`): the
  payment is paid only when each output's address receives at least its amount
  in the reported transaction. Any output short → the whole payment is
  `canceled` `underpaid`, as before. The ledger's informational entry is posted
  per output against the account it paid.
- **No fee output, still.** The platform's address is never an output of a
  seller's sale: a FairCoin on-behalf payment carries **no application fee**
  (`application_fee_amount` stays a 400), each seller receives its whole share,
  and the marketplace takes its commission on the card rail, as ADR 0012
  recommended. Revisit only as its own decision.

### D8. A session's payments carry the merchant's identifiers

`payment_intent_data.metadata` on a Checkout Session is copied to EVERY payment
the session creates (each method the payer confirms, each fresh quote), so a
merchant matches a payment's events to its own records by its own id rather
than by amount or timing. The session's `client_reference_id` stays on the
session. Peable keys nothing on that metadata.

### D9. A recipient's tree is bounded: recycle before minting, cap what is open

**Added 2026-11-06** (independent security review, finding F4, which refused
mainnet). Every FairCoin payment reserves an address on the RECIPIENT's cursor
(D5), and the recipient's Peable wallet scans every index up to the highest
reserved (ADR 0002). Before this decision every confirm minted: anyone who can
open a checkout (payer routes are anonymous), a marketplace platform minting
on-behalf intents, a Pay with Peable sheet re-confirming on each switch or
lapsed quote, an orphaned intent of a confirm that lost a race — each pushed a
stranger's cursor up, and a few dozen addresses a day per attacker IP past
150 000 froze the wallet's scan. The number of addresses a recipient's tree
grows by is now bounded by REAL payments, whatever anyone does:

- **Recycle before minting** (`services/faircoin/addressPool.ts`). An address
  held by a payment that ended `canceled` at least **1 hour** ago (the
  quarantine: six quote lives, so a payer who pays a lapsed quote a little late
  still pays an address no other order holds), that still derives from the
  recipient's CURRENT key at its recorded index (`payment_intent_outputs.
  derivation_index`; a rotated key's tree is one nobody scans, ADR 0002), and
  that the chain shows never received anything (Explorer `GET /api/address/:a`:
  no transaction, nothing received, no unspent output), is handed to the next
  payment, lowest index first. The previous holder keeps its row, marked
  `recycled_at`; an address the chain shows used, or that no longer derives from
  the key, is marked `retired_at` and never offered again. An Explorer that
  cannot tell — an outage, or testnet's node, which has no address index and
  answers `isValid: false` with a note — recycles nothing: `unknown` is never
  read as unused.
- **Cap what is open.** A fresh index is minted only while fewer than **500**
  of the recipient's addresses (per network) are OPEN: held by a payment in
  `requires_action` or `processing`, or cancelled within the quarantine. At the
  cap the FairCoin confirm is refused **503 `faircoin_capacity_reached`** and
  the order shows FairCoin `temporarily_unavailable`; every other method keeps
  working, so nothing an attacker does can deny the card rail. The count and
  the mint run in the payment's own transaction under a per-recipient advisory
  lock (`pg_advisory_xact_lock`), so concurrent confirms cannot both pass it,
  and a payment that rolls back (including one that loses its idempotency-key
  race) returns its claim and its index with it. The reservation itself is
  unchanged: ONE statement on the cursor.
- **The bound.** A recipient's tree holds at most 500 addresses nobody paid,
  plus one per address something was actually sent to — a real payment, or
  coins an attacker spent (at least the network's dust threshold plus a fee)
  to dirty it. Outside an Explorer outage on mainnet that is a size bound, not a
  rate. On testnet (no address index) nothing is recycled and the cap bounds
  the rate instead: at most 500 abandoned addresses per hour.
- **The holes that fed it are closed.** A confirm that loses its session
  (`moved`) cancels the FairCoin payment it created in the transaction that saw
  it orphaned (`abandoned`). A repeated FairCoin confirm on an order whose
  linked payment still has more than a minute of quote answers that payment (as
  before; the invoice page does the same). `expires_in_seconds` is at most
  86 400 (24 h) in the contract and for every internal caller (F10): an address
  stays out of the pool only as long as its payment is payable. And a reported
  broadcast the Explorer has never seen for **24 hours**, that provably pays
  nothing at the payment's addresses (each reads unused, or reads used with the
  reported txid absent from its transaction list), while the Explorer answers,
  is **lost**: the watcher cancels the payment `abandoned` (`broadcast_lost`).
  Without that, a made-up txid — with or without dust sent to the address — held
  an address, and a place under the cap, for ever. Coins someone sent there stay
  the recipient's, and that address is retired, never recycled. **Amended
  2026-11-06 (N4):** an address that WAS paid in full, under another txid (a
  malleated or rebroadcast transaction, or a mistyped report), is not lost: the
  watcher lists the address's transactions, keeps those the list shows moving
  at least the output's amount no earlier than the payment (less 15 minutes for
  a staker's clock) — so dust costs no read and cannot push the payment out of
  reach — and reads at most 10 of them. One that pays every output its amount
  and is not another payment's `processing`/`succeeded` txid becomes the
  payment's `txid` and settles it as any observation. One that is another
  payment's, or more such candidates than are read, leaves it `processing`
  with a warning for review — never cancelled. Only dust, or nothing, at the
  address is lost. This narrows ADR 0012 D9
  ("once broadcast, never expires") to broadcasts that exist: a transaction
  nobody has seen in a day of two-minute, nearly empty blocks is not moving
  money.
- **`@username` addresses** are not payments and are not counted against the
  cap. A sender asking again for a recipient it has not paid is handed the
  address it already holds (its latest attribution, when it still derives from
  the recipient's key and the chain shows it unused), with the request's
  context written over the old one; so a sender holds at most ONE unpaid
  address per recipient, beside the per-pair limiter. The residual is distinct
  authenticated Oxy accounts, each one more address until it pays.
- **The tree has a ceiling (amended 2026-11-06, review round 2, N1).** The
  wallet watches indices `0 .. SOCIAL_RECEIVE_MAX_WATCHED − 1` (2 000) and
  reaches `SOCIAL_RECEIVE_GAP_LIMIT` (20) past the highest index reserved
  (`planSocialReceiveWindow`); past that it stops offering `@username` and
  watches nothing new. Before this the gateway kept minting, so once any
  recipient's tree — and the organization `oxy` has ONE tree for every
  first-party merchant, renewal and `@username` — passed 2 000, every new
  FairCoin payment settled `succeeded` at an address its wallet never looks at.
  Now ONE constant, `SOCIAL_RECEIVE_INDEX_LIMIT = SOCIAL_RECEIVE_MAX_WATCHED −
  SOCIAL_RECEIVE_GAP_LIMIT` (1 980, `@peable.to/contracts/vocabulary/
  receiveTree`, the wallet's import too), bounds both sides: an index `i` is
  minted only when `i + SOCIAL_RECEIVE_GAP_LIMIT ≤ SOCIAL_RECEIVE_MAX_WATCHED − 1`,
  i.e. `i < SOCIAL_RECEIVE_INDEX_LIMIT`, so the wallet's window always holds it
  and the gap above it. The refusal is the `WHERE` of the cursor's own `INSERT …
  ON CONFLICT DO UPDATE` (no row, nothing written; the row lock serializes the
  edge). A payment past it is refused **503 `faircoin_capacity_reached`** and
  the order shows FairCoin `temporarily_unavailable` unless an address can be
  recycled — recycling keeps working on a full tree; `@username` answers **503
  `faircoin_receive_tree_full`** (not 409: on that route a 409 alone means a
  keyless recipient to the wallet and `@peable.to/pay`). Cards are untouched. Orbit warns the owners
  (Home, beside the wallet setup task) once fewer than 200 fresh indices are
  left. Pinned on both sides: `db/__tests__/socialReceiveCursor.realdb.test.ts`
  (the gateway never mints `≥` the limit) and `packages/frontend/src/wallet/
  receive-tree-ceiling.test.ts` (every index below it is watched, gap
  included, without capping the wallet; the limit itself caps it).
- **Concurrent confirms recycle (amended 2026-11-06, N2).** The candidate was
  chosen outside the lock, so every overlapping confirm checked the SAME lowest
  one, one claimed it and the rest minted — a burst of N confirms spent N − 1
  indices while candidates sat unused. Now each confirm LEASES a different
  candidate for 60 s before its chain read (one `UPDATE … WHERE id = (SELECT …
  FOR UPDATE SKIP LOCKED)`), a read that finds it unused is stamped
  (`payment_intent_outputs.recycle_checked_at`), and under the pool's lock a
  confirm whose own candidate was taken claims the lowest one stamped within 10
  minutes — no HTTP call in the transaction — and mints only when none is
  left. N parallel confirms against N candidates leave the cursor where it was
  (`addressPool.realdb.test.ts`). The 10 minutes widen the late-payer residual
  below by that much: an address checked unused may be paid by a late payer of
  its old quote before the claim.
- **A recycled address is below the ceiling too (amended 2026-11-06, review
  round 3).** The recycling queries (`db/payments/faircoinAddressPool.ts`) and
  the claim's compare-and-swap carry `derivation_index <
  SOCIAL_RECEIVE_INDEX_LIMIT`, so an address minted above it before the
  ceiling existed is never handed out again. Every Explorer read the gateway
  makes is bounded by a timeout, and one that times out is `unknown` — never
  `unused`, never a missing transaction.
- **Not done: a sparse watch set.** The lasting fix is for the wallet to watch
  the indices the gateway reports HELD (reserved and not recycled away), not a
  contiguous range from 0, so a tree's size is bounded by what is open rather
  than by every index ever minted. Until then the ceiling makes a recipient
  whose tree is full depend on recycling for FairCoin, and the bound is a
  lifetime one: 1 979 payment and `@username` addresses that were actually used,
  per recipient per network.
- **Not done:** a unique `txid` across payments. One address has at most one
  holder that is not recycled (the unique index on `payment_intent_outputs
  (network, address)` is now partial on `recycled_at is null`), and a recycled
  address's previous holder is `canceled`, which is terminal: no transaction can
  settle both. A unique `txid` would also refuse one transaction paying two
  orders' outputs, which is legitimate.

The cost of the cap, written down: an attacker who keeps 500 of a recipient's
addresses open (an anonymous payment-link visit plus a confirm each, held for
the payment's life plus the quarantine) makes FairCoin `temporarily_unavailable`
for that recipient meanwhile. A fiat order still takes a card; a `FAIR`-priced
order has no other method and waits. That is the trade the bound requires —
availability of one rail for a while, instead of a wallet that can never be
scanned again — and it is the reason the cap is far above real concurrency.

The residual risk, written down: a payer who pays a cancelled quote more than an
hour after it was cancelled, AFTER its address was handed to another order,
pays that other order's address — the coins are still the recipient's, and the
later order's payer could report that transaction as their own if it pays at
least their amount. The quarantine makes this a late payment of an abandoned
quote, never a race of two live payments.

### D10. A mainnet payment settles at 6 confirmations, and is watched until a reorg cannot undo it

**Added 2026-11-06** (security review F9). `required_confirmations` defaulted to
1 for every merchant, and nothing re-read a payment once it succeeded, though
`reorg_below_threshold` existed.

- **Default 6 on mainnet.** FairCoin's own coinbase maturity on mainnet is 6
  blocks (`coinbaseMaturity` in `@fairco.in/core`), about 12 minutes of
  2-minute proof-of-stake blocks; one confirmation is one staker's say-so.
  `insertMerchant` writes 6 for a `production` (mainnet) merchant that names
  none; testnet keeps 1. Migration `0106` (post) raises mainnet merchants still
  at 1 — the old default, indistinguishable from a choice — to 6; any other
  value is kept, and a merchant that wants 1 sets it with `POST
  /v1/merchants/me`.
- **Watched to the chain's reorg bound.** The settlement watcher re-reads every
  `succeeded` FairCoin payment with fewer than `maxReorgDepth` (100)
  confirmations, settled within the last 7 days. A deeper count is recorded (no
  event). **Amended 2026-11-06 (N3):** a LOWER count is not a reorg — the
  Explorer is load-balanced, and one node behind its peers answered a block's
  `confirmations` as 1 and its transaction's as 4 in the same minute — and is
  neither acted on nor recorded. Only the chain saying so rewinds: the
  transaction missing for 10 minutes (five blocks) while the Explorer's tip
  answers, or read unconfirmed (0 confirmations, no `blockhash`) — or in a
  different block than the one it settled in, below the merchant's threshold —
  on reads at least 2 minutes (a block) apart. Before, one jittery read sent a
  spurious `payment_intent.processing` and, a minute later, a second
  `payment_intent.succeeded`, which an integration fulfilling on `succeeded`
  fulfils twice. The block is remembered per watcher task; after a restart the
  first read records it. Such a rewind takes it to `processing`
  (`reorg_below_threshold`): the merchant
  is told `payment_intent.processing`, the ledger posts the reversal, and the
  watcher settles it again when it is mined again, or — if the coins never come
  back — D9's lost-broadcast rule cancels it a day later.
- **A rewind does not undo the order.** A Checkout Session stays `complete`
  and an invoice stays `paid`: the payment's own status and its events
  (`payment_intent.processing`, then `succeeded` again or `canceled`) are what
  the merchant is told, the same way a card dispute leaves its charge's order
  alone. What was delivered against a payment the chain later dropped is the
  merchant's decision; un-paying an invoice (and the subscription and
  entitlements behind it) or un-completing a session would also un-commit tax
  and re-send receipts, and is not decided here. The 6-confirmation default is
  what makes a rewind rare.
- **A lost broadcast needs proof, not silence.** D9's rule cancels only after
  the watcher has itself seen the transaction missing on every read for an
  hour (a transaction-API outage also answers "missing"), the tip answers, and
  every output address reads unused, or used with the reported txid not among
  its transactions (`GET /api/address/:a/txs`, every page read — the
  Explorer serves 50 a page — up to 1 000 transactions, past which a
  single-use address was filled on purpose and the txid's absence is taken as
  read); on mainnet any
  `unknown` keeps the payment `processing`. Testnet's node only ever answers
  `unknown`, so there the missing transaction alone decides. A payer who paid
  the address but reported a wrong txid is ADR 0012 D9's residual case: the
  coins are the recipient's, and the order is between payer and merchant.

### D7. The ledger records the fiat equivalent

The informational FairCoin entry (ADR 0015 §5) stays in FAIR and never payable;
a quoted payment's balance transaction also carries its `faircoin_quote` (order
currency, fiat amount, rate), so the merchant's books and the reports show what
the sale was priced at. No fiat balance is created by it.

## Consequences

- Contracts, shared-types and the SDK gain fields and one choice parameter
  plus `payment_method_locked`, `faircoin_wallet_missing` and
  `faircoin_price_unavailable`; `PaymentMethodConfigurationEntry.locked` is new.
  A consumer that sends `payment_method_types: ['card']` on a fiat session must
  add `faircoin` (or omit the field).
- Migrations: `payment_intents.faircoin_quote` (hot table: alone, nullable, no
  default, CHECK `NOT VALID` then validated `post`); `checkout_sessions` drops
  the *network ⇔ FairCoin rail* and *connected account ⇒ FairCoin rail* CHECKs
  for *connected account ⇒ network*; `balance_transactions.faircoin_quote`.
- Removing the xpub mechanism (D5) is a contracts/SDK major: `Merchant.xpub`
  and the registration and onboarding `xpub` parameters are gone.
- **The two live first-party merchants are owned by the organization `oxy`**,
  which had no identity key (2026-11-05). Their FairCoin option answers
  `faircoin_wallet_missing` until an owner of `oxy` creates the organization's
  Peable wallet (OxyHQ/oxy organization wallets) — the one human step; nobody
  else can create it, because generating a key for them would be custody — and
  `faircoin_network_closed` until the deployment opens mainnet identity receive
  (ADR 0002).

## Not decided here

- A multi-rail PaymentIntent (D1), and with it FairCoin on raw card Elements.
- A FairCoin application fee (D6) and seller-assisted FairCoin refunds (ADR 0012 D10).
- Multi-recipient FairCoin on a raw PaymentIntent or a payment link (D6 builds it
  for Checkout Sessions, the marketplace cart).
- Which fiat reference applies beyond the ECB's set (no Orbit currency needs one today).

## Owner's mainnet waiver (2026-11-06)

D5's mainnet gate is ADR 0002's. On 2026-11-06 the owner (Nate I.) waived two of
its prerequisites — the legal opinion and physical-device verification — and
directed that mainnet open once the security review signs off and the testnet
canary passes. The waiver, its limits and where the gate stands are recorded in
ADR 0002 ("Owner's mainnet waiver") and `docs/audits/2026-11-06-mainnet-gate/`.
Until then a live order's FairCoin option answers `faircoin_network_closed`.

