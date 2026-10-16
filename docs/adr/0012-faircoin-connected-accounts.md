# ADR 0012 — FairCoin connected accounts: a marketplace's sellers are paid in FairCoin, straight to their own wallets

- **Status:** Accepted for the model and the fee-agnostic implementation.
  **The platform fee is NOT decided here** — §D12 lays out the options and a
  recommendation for the owner.
- **Date:** 2026-10-16
- **Closes:** ADR 0001 open item #1 ("whether the FairCoin rail can settle a
  sub-merchant"). It can, and this is how.
- **Leaves open:** ADR 0001 open item #2 (a React Native payer surface) — §D11.
- **Builds on:** ADR 0001 (D1 rail on the intent, D6 the network firewall, D7
  the outbox), ADR 0009 (Peable holds the provider credentials; the
  merchant-of-record question for CARDS stays open and is not touched here).

## Context

Mercaria is a Peable merchant today (`merch_bd106296a0fef49a861ee6b7`), on the
card rail only: it has no `xpub` and no `network`. The owner decided on
2026-10-16 that Mercaria's buyers can pay its SELLERS in FairCoin "like Stripe
Connect, everything through Peable":

- each seller has its own Peable connected account holding its OWN watch-only
  xpub;
- Mercaria — the platform — creates payment intents and checkout sessions ON
  BEHALF OF a connected account;
- receive addresses derive from the SELLER's xpub, so the coins land in the
  seller's wallet and neither Peable nor Mercaria ever holds them;
- the platform receives the webhooks for its connected accounts' payments.

ADR 0001 D2 already said why the card rail's settlement model does not apply:
the FairCoin rail never holds the funds, so there is nothing to TRANSFER to a
seller afterwards. The only way to pay a seller in FairCoin non-custodially is
for the payer to pay the seller directly — which means the seller's key has to
be the one the address derives from, at the moment the intent is created.

## Decisions

### D1. One seller is ONE `ca_…`, and it may carry either rail or both

`connected_accounts` already exists for the card rail: a `ca_…` per
`(platform merchant, the platform's own seller id)`, holding a provider account.
The FairCoin half is added to THAT row, not to a parallel table, because a
marketplace's seller is one entity: Mercaria's store 42 is addressed by one
`ca_…` whether the buyer pays by card (separate charges and transfers, as today)
or in FairCoin (on-behalf intents, this ADR).

Both halves are now optional, and the row says which it has:

| Half | Columns | Agreement CHECK |
|---|---|---|
| card | `provider`, `provider_account_id`, `country` | all NULL or all set (`connected_accounts_card_fields_agree_check`) |
| FairCoin | `network`, `xpub`, `faircoin_oxy_user_id`, `faircoin_registered_at`, `next_derivation_index` | `xpub` ⇒ `network`, `xpub` ⇔ `registered_at`, `network` ⇔ `oxy_user_id` |
| either | — | at least one half (`connected_accounts_has_a_rail_check`) |

A row with a card half and no FairCoin half is exactly the row that existed
before this ADR, and every card path reads it the same way. A FairCoin-only
seller never reaches Stripe: no provider account is opened, no KYC is asked
for, and the card paths refuse it (`AccountNotPayableError` /
`AccountsUnavailableError`) rather than reading a NULL provider id.

The DTO gains `rails` (which halves exist) and `faircoin` (that half's status),
and `country` becomes nullable — the one widening a typed consumer has to
handle.

**Rejected: a separate `faircoin_accounts` table with its own id prefix.** It
would make a marketplace hold two ids for one seller and reconcile them, and
`connected_account.updated` would have to mean two different resources.

### D2. The PLATFORM opens the FairCoin half; it names the network and the seller's Oxy identity

`POST /v1/connected_accounts` keeps its card body (`country`, `businessType`)
and gains an optional `faircoin: { network, oxyUserId }`. Card fields only →
exactly today's behaviour. FairCoin only → no provider call at all. Both → both.
A repeated create converges on the existing `(merchant, externalRef)` row as
before, and ADDS a half the row does not have yet, so a card seller can be
given FairCoin later (and the reverse) without a second id.

- **`network` is immutable once set.** It is the address's chain; changing it
  would re-interpret every address already shown to a payer. The composite
  reference from `payment_intents` (D5) also makes it physically impossible
  once an intent exists.
- **The test/live firewall is the merchants' one, unchanged:** a non-production
  platform can only open a `testnet` FairCoin half. A production platform can
  open either, exactly as a production merchant can register either.
- **`oxyUserId` is the seller's Oxy identity** — the only person who will be
  allowed to register the key (D3). The platform supplies it because the
  platform is the one that knows who owns store 42; Peable cannot know that.
  It is fixed once set. A store that changes hands gets a NEW account (a new
  `externalRef`): the old owner's key keeps receiving whatever is paid to the
  old account, which is the correct outcome for payments already made to it.

### D3. Onboarding: the SELLER registers the key, in their own Oxy session, through a Peable-hosted link. Never the platform

The flow mirrors Stripe Connect's hosted onboarding:

1. The platform mints a link: `POST /v1/connected_accounts/:id/account_links`
   with `{ rail: 'faircoin', returnUrl, refreshUrl }` →
   `{ url: 'https://peable.to/connect/<token>', expiresAt }`.
2. The seller opens it in the Peable wallet, signed in with Oxy.
   `GET /v1/connect/onboarding/:token` (Oxy USER auth) tells them which
   platform is asking, for which network, and refuses anyone but `oxyUserId`.
3. The seller chooses the pocket that will receive the platform's sales; the
   wallet sends that pocket's ACCOUNT xpub to
   `POST /v1/connect/onboarding/:token/faircoin` (Oxy user auth again).
4. Peable runs the non-custody firewall, stores the key, consumes the link,
   emits `connected_account.updated` to the platform IN THE SAME TRANSACTION,
   and hands the seller back to `returnUrl`.

**Why not let the platform register the xpub through its API "with the
seller's consent".** Because the xpub decides WHO RECEIVES THE MONEY, and a
platform-supplied key is indistinguishable from the platform's own key.
Peable cannot verify consent claimed by the party that benefits from lying
about it, so "with the seller's consent" would collapse to "whatever key the
platform sends", and a compromised or dishonest platform could route every
seller's FairCoin to itself — custody by substitution, with Peable as the
instrument. Taking the key only from the seller's own authenticated session
makes provenance a property of the code path, not of a promise, and it is the
same trust root the rest of Oxy already uses: **the seller's Oxy identity IS
the seller.** It is also less work for the seller: the wallet already holds
the key, so registering is one tap rather than copying an xpub around.

What the link is and is not:

- **A bearer of nothing by itself.** The token alone cannot register a key; it
  must arrive with an Oxy session for `oxyUserId`. A forwarded or leaked link
  is useless to anyone else.
- **Stored only as a SHA-256 hash** (`connected_account_links.token_hash`); the
  plaintext exists in one response and the seller's address bar.
- **Single-use and short-lived (60 minutes).** Expired → 410 carrying the
  platform's `refreshUrl`, so the seller is sent back to ask for a fresh one —
  Stripe's `refresh_url` semantics. Not stored by the platform, for Stripe's
  reason: a stored link has already died by the time anyone follows it.
- **A wrong user is a 403 that does NOT consume the link**, so a seller who
  opened it on the wrong account can switch and try again.

**The Oxy-to-store binding is the platform's responsibility, and that is the
one trust the platform keeps.** A dishonest platform could open an account
naming ITS OWN `oxyUserId` for a seller and register its own key. Peable cannot
prevent a platform from choosing whom to pay — that is the platform's business
decision in every marketplace — but it guarantees three things it can: the
key is only ever registered by the identity the account names, once
registered it cannot be swapped (D4), and Peable never holds the coins. A
seller verifies the outcome where it matters, in their own wallet.

### D4. Rules on the key

- **Watch-only, always.** The same `assertWatchOnly` that guards
  `insertMerchant` (moved to `services/watchOnly.ts`, one implementation)
  runs at the single writer, `registerFaircoinKey`. An `xprv` is a 422 and is
  never stored.
- **Network-checked.** Deriving index 0 with the account's network's version
  bytes proves the key belongs to that chain.
- **Immutable once registered.** The writer is
  `UPDATE … SET xpub = … WHERE id = … AND xpub IS NULL`; a second registration
  answers 409 and changes nothing. Re-keying would re-interpret every address
  already handed to a payer (the counter would point into a different tree).
- **Unique across every connected account, and refused when it is any
  merchant's key.** Two derivation counters walking one key hand out the SAME
  addresses — two payments the gateway can attribute to neither. A unique index
  covers accounts (`connected_accounts_xpub_key`); the merchants table is
  checked at the writer (a cross-table rule cannot be a constraint, and a
  merchant registering a seller's key in the same millisecond is the residual
  risk, written down here rather than pretended away).
- **A DEDICATED account (pocket), recommended and explained on the page.**
  Peable derives receive addresses on the external chain from index 0 upward;
  a wallet that ALSO hands out that chain's addresses for personal receipts
  would collide with them. The wallet screen registers the active pocket and
  tells the seller to make it one used only for this platform.

### D5. Intents and checkout sessions ON BEHALF OF an account: `connectedAccount`

`POST /v1/payment_intents` and `POST /v1/checkout_sessions` accept
`connectedAccount: 'ca_…'` (SDK: `paymentIntents.create({ …, connectedAccount })`,
`checkout.sessions.create({ …, connectedAccount })`).

- **FairCoin only, and explicitly so.** A `connectedAccount` with `rail: 'card'`
  is a 422: on-behalf card charges are ADR 0009's open merchant-of-record
  decision and nothing here pre-empts it. Absent `rail` defaults to `faircoin`
  as it always has, so the platform never receives a card intent for a
  connected FairCoin checkout — and naming `rail: 'faircoin'` explicitly is
  supported and documented as the way to be sure.
- **The platform needs no xpub.** A card-only platform (Mercaria) creates
  FairCoin intents for its sellers; its own `network`/`xpub` stay `null`, and
  `GET /v1/merchants/me` keeps answering them as `null` (pinned by a test).
- **The address derives from the ACCOUNT's xpub through the ACCOUNT's own
  counter**, reserved in ONE statement exactly like the merchant's
  (`UPDATE connected_accounts SET next_derivation_index = next_derivation_index
  + 1 … RETURNING next_derivation_index - 1, xpub, network`). Two consecutive
  reservations are pinned by a test, for the reason AGENTS.md gives.
- **Readiness is checked before anything is reserved:** an account with no
  FairCoin half, or a `pending` one, is a 409 `account_not_ready`, and the
  requested `network` must equal the account's (422 otherwise).
- **The `Idempotency-Key` replay compares the account too.** A replayed key
  naming a different seller is a 409, never the other seller's intent.
- **The payment belongs to the platform.** `payment_intents.merchant_id` is the
  platform, so authentication, listing, `reject`, the outbox and every webhook
  are the platform's — the connected account is WHERE THE MONEY GOES, not who
  owns the record.

**The network firewall moves, structurally.** `payment_intents (merchant_id,
network) → merchants (id, network)` would refuse every connected intent of a
card-only platform (the platform's network is NULL). It now reads a STORED
GENERATED column, `merchant_network = CASE WHEN connected_account_id IS NULL
THEN network END`, so it binds every direct FairCoin intent exactly as before
and is vacuous (MATCH SIMPLE) for an on-behalf one. Its replacement for the
on-behalf case is `(connected_account_id, merchant_id, network) →
connected_accounts (id, merchant_id, network)`: the account belongs to THIS
platform and the intent's network is the ACCOUNT's, in one reference whose
implicit `ON UPDATE RESTRICT` also freezes the account's network once an
intent exists. `checkout_sessions` gets the same pair. A CHECK keeps
`connected_account_id` to the FairCoin rail. Payment LINKS are not extended —
a link is a merchant's own reusable price, and nothing has asked for a
seller's.

### D6. Who sees what

| Party | Sees | Does not see |
|---|---|---|
| Platform | the account, its `rails`, `faircoin.{network,status,oxyUserId,registeredAt}`, every on-behalf intent and its events | **the seller's xpub** |
| Seller (onboarding page) | which platform asks (its `MerchantDisplay`), the network, the link's expiry | the platform's `externalRef` for them |
| Payer | the address, the amount, the platform's display (as today) | the seller's other addresses |
| Peable | the xpub (it must, to derive) | any private key, ever |

The xpub is withheld from the platform deliberately: an account xpub reveals
every address of that account, so the platform would learn the seller's whole
history and balance in that pocket. Nothing the platform does needs it —
addresses arrive on each intent.

### D7. Webhooks and events

- Every event about an on-behalf intent is delivered to the PLATFORM's
  endpoint (it owns the intent, D5). The intent carries `connectedAccountId`
  and the envelope carries `account: 'ca_…'` — Stripe's `event.account` — so
  a platform routes it without parsing the intent. Both are additive and
  OPTIONAL on the published types, so no existing consumer stops compiling.
- `connected_account.updated` (the existing readiness event; no new
  `account.updated` spelling) fires when the FairCoin half becomes `active`,
  committed in the same transaction as the key (ADR 0001 D7). Opening the
  half is not an update and emits nothing — the create response is the news.
- The seller receives nothing from Peable. Telling a seller about a sale is the
  platform's product; a second channel would be a second, disagreeing one.

### D8. Live mode and testnet

The account inherits the platform merchant's environment (it has no
credential of its own). A non-production platform can only open a `testnet`
FairCoin half; a production platform can open either, as merchants can. The
mainnet gates in `PEABLE-ROADMAP.md` — legal opinion, testnet canary, device
checks — bind this flow exactly as they bind direct FairCoin intents; nothing
here clears any of them.

### D9. Expiry: a paid order must never be cancelled on the platform's clock

Unchanged semantics, now exposed. An intent expires only from `created`,
`awaiting_approval` (and `requires_action` on the card rail). Once the payer
has reported a broadcast (`broadcast`) the intent **never expires**, whatever
`expiresAt` says — coins are moving, and `confirming`/`settled` follow from
the chain. `PaymentIntent.canExpire` (and `canExpire(status)` in
`@peable.to/shared-types`) says so per intent. A platform:

- releases a reservation on `payment_intent.expired` or `payment_intent.rejected`,
  or after its own `reject` call succeeded — never because `expiresAt` passed;
- treats `reject` answering 409 as "the payer got there first".

The residual case is written down rather than hidden: a payer who pays the
address WITHOUT reporting the txid (an external wallet scanning the QR) is
invisible to the settlement watcher, so the intent can expire with the coins
already in the seller's wallet. The money is safe — it is the seller's — and
resolving the order is between payer, seller and platform.

### D10. Refunds

A FairCoin refund is a payment from the SELLER's wallet back to the payer.
Peable never held the coins, so it cannot return them, and the existing refund
route already refuses the FairCoin rail (`refundService`: "the chain rail,
whose money it never held"). That stays. What Peable can later ASSIST with —
a refund intent the seller pays, linked to the original, so the platform sees
both — is an open item, not built here.

### D11. A native payer surface (ADR 0001 open item #2)

Unchanged and still open. A native app reaches the hosted checkout or the
`peable://pay` deep link today, which works for on-behalf intents exactly as
for direct ones; nothing in this ADR makes the native surface cheaper or more
urgent.

### D12. The platform fee — NOT implemented; options for the owner

Non-custodial means the platform cannot skim a payment it never touches: the
coins go from the payer to the seller's own address in one transaction. A fee
therefore has to be either a SECOND movement of money or happen on a rail where
the platform does touch the money.

| | Option | How | For | Against |
|---|---|---|---|---|
| (a) | **Two-output payment** | The intent carries the seller's address AND a fee address (from the platform's xpub); the payer's wallet builds one tx with both outputs; the watcher settles only when both are paid | Fee collected atomically with the sale; still non-custodial (each party receives directly); transparent to the payer | Only payers whose wallet can build multi-output payments from Peable's request (Peable wallet / `@peable.to/pay` / hosted checkout via deep link). A plain `faircoin:` URI names ONE address, so any external wallet cannot pay — the fallback is (b) or refusing the sale. Changes the intent model (two addresses), the settlement watcher (partial payments per output), the checkout QR, the wallet and `pay`; the payer sees two recipients. Largest change by far |
| (b) | **Fee invoiced to the seller** | Peable sums the fee over settled on-behalf intents per period and issues the seller a FAIR invoice (an intent paying the platform's own xpub); enforcement is account standing — an overdue seller's FairCoin half is restricted for new intents | Payer flow untouched; works with every wallet; reuses intents and the existing outbox; amounts are exact because settlement is on-chain | Credit risk (a seller can sell and not pay); collection and dunning work; the platform must register its own xpub to be paid; the invoice is a B2B service the platform issues (tax/VAT and FX if the fee is priced in EUR) |
| (c) | **Fee only on the card rail** | Mercaria keeps taking its commission where it already does — the card rail's transfer amount, which Mercaria computes (ADR 0001: the split has one definition, Mercaria's) | Zero new work; no custody question at all | FairCoin sales are commission-free, so sellers have an incentive to steer buyers to FairCoin; a revenue decision, not a technical one |
| (d) | **None at launch** | No FairCoin fee until volume justifies one | Ships now; nothing to unwind; measures demand first | Same leakage as (c) for FairCoin, explicitly temporary |

**Recommendation: (d) at launch — which, because Mercaria already takes its
commission on cards, is (c) in practice — with (b) as the planned next step
once FairCoin volume makes the fee worth collecting.** (b) keeps the payer
flow and every wallet working, keeps Peable out of the money entirely, and its
weakness (credit risk) is bounded by account standing, which the platform
already controls. (a) is the only option that collects atomically, but it
excludes every payer outside Peable's own wallets and rewrites the settlement
model; it is worth revisiting only if Peable wallet coverage of buyers becomes
near-total. No code in this change computes, stores or reserves room for a fee.

## Failure modes

| What | What happens | Recovery |
|---|---|---|
| Seller never registers | FairCoin half stays `pending`; on-behalf intents answer 409 `account_not_ready` | Platform shows "not set up"; mints a fresh link on demand |
| Link expired | 410 with the platform's `refreshUrl` | Platform mints a new link |
| Wrong Oxy account opens the link | 403; link NOT consumed | Seller switches account and retries |
| Key already used elsewhere | 409 | Seller picks another pocket |
| `xprv` submitted | 422; nothing stored | — |
| Seller loses their wallet | Peable cannot help and must not be able to; coins already received are in their wallet's key | Platform opens a NEW account (new `externalRef`); key rotation in place is an open item (it needs per-intent key versions) |
| Many unpaid intents | Addresses beyond the seller wallet's gap limit | Same exposure as a direct merchant today; the wallet must scan past the gap or the expiry window must be short. Tracked, not solved here |
| Paid without a reported txid | Intent may expire with coins in the seller's wallet | D9 |
| Peable is down | No new intents; already-issued addresses still receive directly into the seller's wallet | — |
| Platform compromised | Can create intents (which pay the seller) and mint links (useless without the seller's Oxy session); cannot change a registered key; cannot receive a seller's coins | — |

## Non-custody guarantees, restated for this flow

- No column anywhere holds a private key, mnemonic or seed — for sellers as
  for merchants. `assertWatchOnly` runs at the single writer of each.
- The coins move payer → seller in one transaction. They never touch an
  address Peable or the platform controls.
- The key is supplied only by the seller's own Oxy session and is immutable
  once stored.
- Peable cannot refund, reverse or redirect a FairCoin payment, and no code
  path pretends otherwise.

These are properties of the code. They are not a regulatory conclusion: ADR
0009's warning that architecture alone establishes no exemption applies here
unchanged, and the EU legal opinion on the roadmap is still a release gate.

## Consequences

- `@peable.to/shared-types` 0.5.0 and `@peable.to/sdk` 0.4.0 — the unpublished
  versions already pending on `main` for Peable Tax — carry the new shapes (`ConnectedAccount.rails/faircoin`, nullable `country`,
  `PaymentIntent.connectedAccountId/canExpire`, `WebhookEvent.account`,
  `accounts` / `accountLinks`). Not published by this change.
- Migration `0032` is `pre` and additive for every image that predates it: the
  old image never writes a connected intent, and the generated column is
  computed by the server.
- The roadmap gains a row for this flow with **impl** only; sandbox, deployed
  and live need a person and a testnet canary.
