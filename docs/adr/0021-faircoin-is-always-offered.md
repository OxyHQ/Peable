# ADR 0021 — FairCoin is always offered

**Status:** accepted.
**Date:** 2026-11-05; D5 amended 2026-11-06; D6 amended 2026-11-06 (multi-recipient), D8 added; D9 and D10 added 2026-11-06 (mainnet security review), both amended 2026-11-06 (review rounds 2 and 3); D9 replaced 2026-11-06 by the sparse watch set (owner's decision), amended 2026-11-06 (review round 4).
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
  watches every address handed out on it (D9) — so two payments can never be
  handed the same address. The
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

### D9. A recipient's addresses are never reused; its wallet watches exactly what was handed out

**Added 2026-11-06** (independent security review, finding F4, which refused
mainnet). **Amended 2026-11-06, the same day, three times** (review rounds 2
and 3: a ceiling on the tree, concurrent recycling, recycled addresses below
the ceiling) and then **replaced at the root on 2026-11-06** by the owner's
decision ("Fix F5, F1 and D9"): a sparse watch set instead of a bounded
contiguous tree. What the first versions decided, and why it went, is under
"History" at the end of this decision.

Every FairCoin payment reserves an address on the RECIPIENT's cursor (D5), and
so does every `@username` request (ADR 0002). F4 found that anyone able to open
a checkout (payer routes are anonymous), a marketplace platform minting
on-behalf intents, a Pay with Peable sheet re-confirming on each switch, an
orphaned intent of a confirm that lost a race — each pushed a stranger's cursor
up, and the recipient's wallet, which scanned every index from 0 to the highest
reserved, froze past 150 000. The rules now:

- **Every address is fresh, and handed out once, for ever.** A payment
  (merchant, seller, invoice, raw intent, each output of a split payment) and an
  `@username` request each take the NEXT index of the recipient's one cursor —
  the one-statement reservation, unchanged — through ONE function,
  `reserveFreshAddress` (`services/faircoin/addressPool.ts`), which also skips
  an index whose address history already holds (only possible where migration
  0009 left a cursor behind attributions it had derived). Nothing is recycled:
  a cancelled payment's address stays that payment's, and a payer who pays a
  quote late — an hour, a year — pays an address no other order holds. The
  coins are the recipient's either way; the order is between payer and
  merchant, as for any late payment of an expired quote (ADR 0012 D9).
  `payment_intent_outputs (network, address)` is unique again, not partial
  (migration 0114 drops the recycling columns).
- **Every address handed out is recorded with its index, network and key, in
  the reservation's own transaction**: an output in `payment_intent_outputs`
  (inserted in the intent's transaction), an `@username` address in
  `social_send_attributions` (since this amendment inserted in the
  reservation's transaction, under the same lock; before it the attribution was
  a second write after the cursor had committed). Each row carries the
  recipient account, `derivation_index` and the `identity_public_key` the
  address derives from (ADR 0002's amendment). Those two tables ARE the
  recipient's address set; no third table copies them.
- **The wallet watches exactly that set** (`GET /v1/social/me/receive_addresses`,
  a user-session route: for whoever the session acts as, an organization's set
  when acting as it). Each item is `{ address, derivation_index,
  identity_public_key, network, created }` — every key the account ever had,
  each address with its own, so a wallet can watch and spend addresses of a
  replaced key (ADR 0002's F1 work) — in ascending `derivation_index`, paged by
  `after` = the previous answer's `sync_cursor`. **The index is the sync
  cursor, and it is exact:** the cursor upsert's row lock is held until the
  reserving transaction ends and the address's row is written in that
  transaction, so for one account an index commits only after every lower one
  has committed or rolled back; a wallet that has seen everything through `n`
  misses nothing by asking for `> n` (migration 0113 moved each cursor above
  the indices already recorded, so this holds for older rows). The wallet also
  re-reads the whole set once a week, idempotently. Index 0, the stable
  default address, is never handed out and is always the wallet's own.
- **What the wallet does with a set that only grows**
  (`packages/frontend/src/wallet/social-receive-watch.ts`). ACTIVE — in the SPV
  Bloom filter — are index 0 (of the current key and of every previous key the
  wallet reaches), the at most **1 000** best-funded addresses (highest value
  first) holding at least **0.001 FAIR** (`SOCIAL_RECEIVE_ACTIVE_FLOOR`, ten
  times the relay fee floor) or shown that much by the Explorer in the last
  7 days, and the newest addresses handed out in the last 7 days — at most
  **2 000 in all, whatever anyone pays anywhere** (the size the contiguous
  window proved safe; the filter saturates near 15 000 entries). **Amended
  2026-11-06 (review round 4, R4-2):** every funded address, dust included, used
  to be active, so dusting ~1 000 fresh addresses a day pushed the set past the
  bound and froze the wallet (F4 again). Below the floor coins no longer make an
  address active, a dormant address showing only dust is recorded as read and
  never rescanned for, and funded addresses past the 1 000 are dormant like any
  other (their coins stay held and spendable); a test pins the 2 000 against
  any mix of funded, found and recent rows. Every other address is DORMANT and
  read on the Explorer on a doubling schedule: a new address once (unless no
  historical rescan has begun, whose first pass covers it), then again after as
  long as it has existed — between a day and **30 days** (a year until round 4)
  — so reads at about 1, 2, 4, 8, 16 and 32 days of age and every 30 days for
  ever; at most 200 reads per resync (every 2 minutes while the wallet runs,
  and on foreground, push and the Receive sheet), never-read first, then most
  overdue, and a batch is recorded only when every read in it answered (an
  outage records nothing; every Explorer read times out after 15 s and every
  watch-set gateway read after 20 s, so a read that never answers cannot stall
  the scheduler — R4-10). Coins found at a dormant address make it active and
  send the SPV rescan back to their block, so they are credited through the
  same merkle-checked path and are spendable. **The late-payment bound, stated
  once:** a payment of at least 0.001 FAIR to ANY address ever handed out
  appears within minutes while the address is in its first week, and otherwise
  at most **30 days after the address was last read, plus the time until the
  wallet next runs long enough to reach it in the queue** (immediately when its
  transaction pays an active address too). The queue is reached in time while
  the dormant set needs no more than the 200-reads-per-resync budget a running
  wallet spends: a recipient with 30 000 addresses needs ~1 000 reads a day
  (five resyncs); one held at D9's worst sustained abuse for a year (below)
  needs ~12 000 a day, about two hours of a running wallet, and past that the
  bound stretches in proportion — the reads are queued most-overdue first, so
  nothing is skipped, only later. The wallet re-derives every row the gateway
  lists from its key at its index before storing it and drops (and logs) a row
  that does not reproduce its address (I-2). The HD (non-social) wallet is
  untouched.
- **What bounds the set is a rate per recipient, not a budget it can run out
  of.** A new PAYMENT address is handed out only while fewer than **500** of
  the recipient's payment addresses of the last **24 hours** (per network) are
  unpaid — their payment anything but `succeeded`: waiting, cancelled, or
  `processing` (a reported txid that never settles still counts, so a made-up
  one buys nothing) — and a new `@username` address only while fewer than
  **500** were handed out fresh to the recipient in the last 24 hours, or
  fewer than **250** when the asking sender was already handed one of the
  recipient's in that window (a sender asking again for one it holds and has
  not paid is handed it back and adds nothing). **Per (sender, recipient)**
  (review round 4, R4-3): one Oxy account is handed at most **5** fresh
  `@username` addresses of one recipient's per network per 24 hours, however
  it treats them — dusting each address it is handed defeats the hand-back
  (the address now reads used) and buys at most 5; a sixth is answered **429
  `rate_limit_error`** to that sender alone. Every one of these counts is read
  from the database (`payment_intent_outputs`, `social_send_attributions`) in
  the reservation's transaction, under a per-recipient advisory lock, with the
  reservation as one decision — so concurrent confirms or asks cannot both
  pass, and they hold across every ECS task. Past a recipient bound, FairCoin
  is refused **503 `faircoin_capacity_reached`** for that recipient
  (`temporarily_unavailable` on the order) and every other method keeps
  working; nothing anyone does to one recipient touches another, and paid
  addresses never count, so real volume is never limited. **Per payer**, in
  front of that: a hosted checkout's FairCoin confirm and a hosted invoice's
  FairCoin pay take at most **20 per client network per hour** — an IPv4
  address, or an IPv6 **/56** as `@oxy.so/core`'s rate limiter buckets it, so
  a host rotating through its IPv6 allocation is one payer
  (`lib/faircoinPayerLimit.ts`, beside the public limiter's 30 requests per
  15 minutes); an Oxy account is handed at most **30 fresh `@username`
  addresses an hour** across all recipients and asks about one recipient at
  most 6 times in 10 minutes, holding at most one unpaid address per
  recipient. Those three per-payer limits are in-memory, so per ECS task; the
  5 a day per (sender, recipient) and both recipient bounds are not.
- **The bound, written down.** Under a sustained attack, one recipient's set
  grows by at most 1 000 unpaid addresses a day per network (500 payment, 500
  `@username`) — 365 000 a year — plus one per real payment. The payment half
  costs client networks: each IPv4 address or IPv6 /56 takes 20 an hour per
  task, so 25 network-hours reach the 500. The `@username` half costs Oxy
  accounts: an account adds at most 5 a day of one recipient's, and past 250
  only senders the recipient has not served that day are served, so filling
  the 500 takes at least **300 distinct Oxy accounts per recipient per day**
  (50 filling the first 250 at 5 each, then 250 more at one each) — more than
  the 500 / 5 = 100 the per-sender bound alone would require — and refusing a
  sender the recipient already served today takes at least 50. One account
  dusting each address it is handed no longer pauses `@username` for anyone
  but itself. The wallet syncs the set a page of up to 1 000 at a time and
  keeps at most 2 000 of it active; the dormant schedule (each address read
  about six times in its first month, then every 30 days — round 4) costs
  about 6 000 reads a day for each day's 1 000 new addresses plus one read per
  older address per 30 days: ~12 000 a day after a year of such an attack,
  about two hours of a running wallet's 200-per-2-minutes budget, past which
  the late-payment bound stretches in proportion (see the wallet bullet). The cost of the bound is the same trade as before, without the
  permanence: while an attacker holds a recipient at 500 unpaid addresses a
  day, FairCoin is `temporarily_unavailable` for that recipient until the
  window rolls — a fiat order still takes a card, a `FAIR`-priced order waits.
  No recipient ever runs out: the lifetime budget of 1 979 used addresses
  (round 3's residual) and the late-payer residual (a late payment settling
  another order at a recycled address) are gone.
- **The holes that fed it stay closed.** A confirm that loses its session
  (`moved`) cancels the FairCoin payment it created in the transaction that saw
  it orphaned (`abandoned`). A repeated FairCoin confirm on an order whose
  linked payment still has more than a minute of quote answers that payment
  (the invoice page does the same). `expires_in_seconds` is at most 86 400
  (24 h) in the contract and for every internal caller (F10). And a reported
  broadcast the Explorer has never seen for **24 hours**, that provably pays
  nothing at the payment's addresses (each reads unused, or reads used with the
  reported txid absent from its transaction list), while the Explorer answers,
  is **lost**: the watcher cancels the payment `abandoned` (`broadcast_lost`).
  Coins someone sent there stay the recipient's, at an address its wallet keeps
  watching. **Amended 2026-11-06 (N4):** an address that WAS paid in full,
  under another txid (a malleated or rebroadcast transaction, or a mistyped
  report), is not lost: the watcher lists the address's transactions, keeps
  those the list shows moving at least the output's amount no earlier than the
  payment (less 15 minutes for a staker's clock) — so dust costs no read and
  cannot push the payment out of reach — and reads at most 10 of them. One
  that pays every output its amount and is not another payment's
  `processing`/`succeeded` txid becomes the payment's `txid` and settles it as
  any observation. One that is another payment's, or more such candidates than
  are read, leaves it `processing` with a warning for review — never
  cancelled. Only dust, or nothing, at the address is lost. This narrows ADR
  0012 D9 ("once broadcast, never expires") to broadcasts that exist.
- **Not done:** a unique `txid` across payments. One address has one output for
  ever, so no transaction can settle two payments' outputs at one address; a
  unique `txid` would also refuse one transaction paying two orders' outputs,
  which is legitimate.
- **Residual, recorded:** outputs written before migration 0105 have no
  recorded index and are not in the set (testnet only — mainnet never minted);
  a wallet upgraded from the contiguous window keeps watching the indices it
  already watched, a new device does not. During the rolling deploy of this
  change the previous image still writes an `@username` attribution after its
  reservation commits; the weekly full re-read covers what an incremental sync
  could miss in that window.

#### History (superseded 2026-11-06)

What D9 decided before the sparse watch set, each step a fix of the one before:

- *Recycle before minting* (first version): an address of a payment cancelled
  over an hour ago, still derived from the current key and read unused on the
  Explorer, was handed to the next payment (`recycled_at`, `retired_at`), and a
  fresh index was minted only while fewer than 500 of the recipient's addresses
  were OPEN. It bounded the tree by real payments but left a written residual:
  a payer paying a quote more than an hour late, after its address was
  recycled, paid the new holder's order, which could claim that transaction.
- *A ceiling* (round 2, N1): the wallet watched `0 .. 1 999` and reached 20
  past the highest reserved, so the gateway stopped minting at index 1 980
  (`SOCIAL_RECEIVE_INDEX_LIMIT` in `@peable.to/contracts/vocabulary/receiveTree`,
  in the cursor statement's `WHERE`), answering `faircoin_capacity_reached` to
  payments and `faircoin_receive_tree_full` to `@username`, and Orbit warned the
  owners 200 indices before. That made every recipient's FairCoin depend on
  recycling once full, for life: round 3 named it a lifetime budget of 1 979
  used addresses, burnable for under 1 FAIR.
- *Concurrent recycling* (round 2, N2) leased candidates (`recycle_lease_until`,
  `recycle_checked_at`) so parallel confirms recycled different ones, and
  *recycled addresses below the ceiling* (round 3) kept an address minted
  above 1 980 before the ceiling from being handed out again.

The owner's acceptance of the last two residuals was one of the conditions of
round 3's sign-off (`docs/audits/2026-11-06-mainnet-gate/`, items 1.4 and 1.5);
this decision removes both instead.

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

