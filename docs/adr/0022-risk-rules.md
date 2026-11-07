# ADR 0022 — Risk rules: a merchant's allow / block / review rules on card payments

**Status:** accepted.
**Date:** 2026-11-07.
**Builds on:** ADR 0014 (one wire), ADR 0016 (Orbit owns its objects), ADR 0017
(test and live), ADR 0019 (Stripe's PaymentIntent), ADR 0021 (FairCoin is always
offered).

## Context

Stripe Radar lets a merchant write rules — *Block if `:card_country:` not in
`('US', 'CA')`*, *Review if `:risk_level:` = `'elevated'`* — and queue payments for a
human. Orbit is Stripe-parity (`docs/orbit/stripe-parity.md`, the "Risk rules" row
was ❌ later). Stripe's own rules live in Stripe's dashboard and act inside Stripe's
authorization pipeline; Orbit's merchants never see the provider (ADR 0016), so the
rules have to be Orbit's: data in Postgres, evaluated by the gateway, explained by
the gateway.

Two facts about the card rail shape everything below:

1. **Most card payments are confirmed by the payer's client directly at the
   provider.** The hosted checkout, Peable Elements and the in-app sheet ask the
   gateway for the provider's confirmation credential (`POST
   /v1/payment_intents/:id/client_action`) and confirm with it; the gateway hears of
   the authorization from the provider afterwards. Only a server-side confirm with a
   saved `pm_…` (`POST …/confirm`, a create with `confirm: true`, the billing
   engine's off-session collection) has the gateway itself ask the provider to
   authorize.
2. **The provider's own risk outcome exists only after authorization** (the charge's
   `outcome.risk_level` / `risk_score`).

## Decisions

### D1. Rules are data, in a small language compiled against a closed fact registry

A rule (`radar.rule`, `rule_…`) is `action` (`allow` | `block` | `review`), a
`predicate`, `enabled`, an optional `description`, and a `version` that moves on
every change of action or predicate. Rules belong to a MERCHANT row, which is one
mode (ADR 0017): a test-mode rule set and a live one are different rows, and the
wire's `livemode` is the merchant's, never a column (CONVENTIONS "Events and webhook
endpoints").

The predicate language is Radar's shape:

```
predicate  := or
or         := and ( "or" and )*
and        := not ( "and" not )*
not        := "not" not | primary
primary    := "(" predicate ")" | "is_missing" "(" fact ")" | comparison
comparison := fact op literal
            | fact [ "not" ] "in" "(" literal ( "," literal )* ")"
            | fact [ "not" ] "like" string
fact       := ":" name ":"
op         := "=" | "!=" | "<" | "<=" | ">" | ">="
literal    := string | integer            -- integers in base units, no sign or decimals
```

- **Parsed and compiled, never evaluated as code.** `services/radar/language.ts`
  parses to an AST and compiles it into a tree of closures over a fact record. No
  `eval`, no `new Function`, no SQL: a merchant's text never reaches a database
  statement. `like` is compiled to a matcher over `%`/`_` (`\%` and `\_` are the
  characters themselves), not to a regular expression built from the merchant's text.
- **Closed fact registry** (`RADAR_FACTS`, contracts vocabulary). An unknown fact, a literal of
  the wrong type for the fact or an operator the fact's type does not take is a parse
  error: 400 `parameter_invalid`, `param: 'predicate'`, with the 0-based position.
- **Bounded:** ≤ 1,000 characters, ≤ 25 comparisons, nesting ≤ 8, ≤ 50 values per
  `in` list, string literals ≤ 200 characters, integers ≤ 30 digits; ≤ 50 rules per
  merchant (409 `rule_limit_reached`), counted under the merchant's row lock.
- **Comparisons are case-insensitive** for strings (`'us'` = `'US'`), except an id
  (`:customer:`), which compares exactly; integers are `bigint`.
- **Three-valued logic.** A fact can be unknown (`null`): no card yet, no customer,
  no provider outcome before authorization. A comparison with an unknown fact is
  UNKNOWN, `not UNKNOWN` is UNKNOWN, and `and` / `or` are Kleene's. A rule matches
  only when its predicate is TRUE — an absent fact never makes a rule match, in
  either polarity. `is_missing(:fact:)` asks the question directly — about a fact the
  phase CAN know. **A fact a phase cannot know is UNKNOWN even to `is_missing`**:
  before authorization the provider's risk (`risk_level`, `risk_score`), and when the
  payer has not entered a card yet (handing out the credential) the card facts too
  (`RADAR_FACTS[…].preAuthorization` / `withoutCard`). Otherwise `block if
  is_missing(:card_country:)` would decline every payer before they typed a card, and
  `allow if is_missing(:risk_level:)` would cancel every pre-authorization block.
  Kleene logic is monotone in information, so a rule that matched on fewer facts still
  matches once more facts are known: the two phases (D3) never contradict each other.

### D2. The facts

| Fact | Type | Known |
|---|---|---|
| `amount` | integer, base units | always |
| `currency` | string | always |
| `card_country`, `card_brand`, `card_funding` | string | a saved `pm_…` (server confirm), or the charge (after authorization) |
| `customer` | string (`cus_…`) | when the payment names a customer |
| `email` | string | the customer's email, else the payment's `receipt_email` |
| `payments_per_customer_hourly` / `_daily` / `_weekly` | integer | with a customer |
| `amount_per_customer_hourly` / `_daily` / `_weekly` | integer, base units | with a customer |
| `payments_per_email_hourly` / `_daily` / `_weekly` | integer | with an email |
| `amount_per_email_hourly` / `_daily` / `_weekly` | integer, base units | with an email |
| `risk_level` | string (`normal`, `elevated`, `highest`, `not_assessed`) | after authorization |
| `risk_score` | integer 0–100 | after authorization, when the provider scores |

- **No normalised amount** (`amount_in_eur`). Converting needs a rate, and a rule
  that decides whether money is accepted must give the same answer on replay; a
  rate-converted figure would not, and a float would not be exact. A rule names its
  currency: `:currency: = 'EUR' and :amount: > 100000`.
- **Velocity** counts the merchant's other card-rail PaymentIntents created in the
  last hour / 24 hours / 7 days for the same customer, or for every customer of the
  merchant with the same email (case-insensitive); the amount is the sum of those in
  THIS payment's currency only (amounts in two currencies do not add). Each side is a
  range of `payment_intents_customer_id_created_at_idx` (customer, then the last seven
  days — a new index on the hot table, alone in its migration and built CONCURRENTLY
  out of band), an email naming at most 100 customers through
  `customers_merchant_id_lower_email_idx`, each side capped at 10,000 rows (a count
  past the cap reads 10,000). A payment
  without a customer counts toward no window: `receipt_email` is not indexed on the
  hot table, and an unindexed velocity read on every confirm is the wrong trade.
  The evaluated payment itself is excluded. Computed only when an enabled rule names
  a velocity fact.
- **No IP country.** The gateway reads `req.ip` only for rate limiting and stores no
  payer IP or location; deriving a country would be new processing of personal data
  (a GeoIP lookup on every payer). Not built; it needs its own decision.
- **`risk_score`** is read from the provider's charge outcome beside `risk_level`
  (`getChargeSnapshot`) and appears on `Charge.outcome`.

### D3. When rules run: two phases, one rule set

Precedence is Radar's: **allow beats block beats review.** Among the matching rules of
the winning action, the oldest is reported. Every enabled rule is evaluated each time.
Rules apply to the CARD RAIL only (`rail = 'card'`, a saved `pm_…` of type `card`, a
charge whose method is a card — wallets are cards). A FairCoin payment never consults
them (D6).

**Pre-authorization** — every fact but `risk_level` / `risk_score` — runs where the
gateway is about to let the provider authorize:

1. **A server-side confirm with a saved `pm_…`** (`confirmCardIntent`, behind `POST
   …/confirm` and the billing engine; and a create with `confirm: true`), before the
   provider is asked, with the card facts of the saved method — from
   `requires_payment_method` or `requires_confirmation`, where nothing is in flight at
   the provider and the gateway itself is about to confirm.
2. **Handing out the payer's confirmation credential** (`POST …/client_action`, and
   the `client_action` a create answers the merchant with — a replayed create
   re-judges without recording), before the credential is read from the
   provider — from `requires_payment_method` only, a payment with nothing attached at
   the provider. The payer has not entered a card yet, so the card facts are unknown
   there and only rules over amount, currency, customer, email and velocity can
   match.

**Never from `requires_action`.** A 3DS challenge is in flight at the provider:
declining the row locally would leave the provider's payment completable, and the
payer finishing the challenge would move it to `succeeded` under a "declined" row.
Such a payment is judged after authorization only. (A `requires_confirmation` payment
whose credential a payer already holds can likewise be confirmed at the provider after
a local decline; the provider's event then moves it on and the post-authorization
judgment decides — the decline never hid money.)

A `block` declines the attempt as Stripe does: one `transitionIntent` (CAS on the
status read) to `requires_payment_method` with `last_payment_error` = `{type:
'card_error', code: 'card_declined', decline_code: 'blocked_by_rule', message: 'The
payment was declined.'}`, recording `payment_intent.payment_failed`. The payment stays
payable (another card, or FairCoin on its order). The confirm answers 402
`card_error`, and so does a create with `confirm: true`; `client_action` answers 402
too and hands out no credential, and a create a rule blocks answers its declined
payment with no `client_action`. The same rule (and version) declining the same
payment again records nothing new: a payer page that asks twice is not two attempts.

**Payers never see the rule.** Every payer surface — the client-secret read, the payer
and Oxy sockets, the hosted checkout's session view, the payer's 402 — renders a rule's
decline as a plain card decline (`code: 'card_declined'`, no `decline_code`) and no
`review` (`toPayerPaymentIntentDTO`). Merchant surfaces keep `blocked_by_rule` and the
review. A payer probing a merchant's rules learns nothing from the answer. The
merchant's `GET /v1/payment_intents/:id` evaluates read-only and omits the credential
when a rule blocks — a read never records an attempt. A pre-authorization `review` or
`allow` does nothing yet: reviews are about a charge, and open after authorization.

**Post-authorization** — every fact — runs ONCE per charge, when the gateway first
holds the charge's provider snapshot (`syncChargeSnapshot`, whichever path reached
`requires_capture` / `succeeded`: a server confirm, a capture, a provider event,
reconciliation). The claim is `charges.radar_evaluated_at`, set by one guarded
`UPDATE`; a snapshot that cannot be read, or a judgment that threw, claims nothing and
is retried by the judge sweep (`services/radar/judgeSweeper.ts`, every minute, charges
between a minute and a day old whose payment is still held or captured) and by the
next `charge.*` event or reconciliation. **Charges that existed before this feature
are never judged**: the migration that adds the column marks every existing charge
judged (`coalesce(synced_at, created_at)`), so a rule written later cannot reach back
into payments authorized when no rule existed; a charge older than a day is never
swept. Then:

| Decision | `requires_capture` (manual capture) | `succeeded` (captured) |
|---|---|---|
| `block` | the authorization is cancelled through `cancelCardPaymentAtProvider` (`fraudulent`), and the intent moves to `canceled` through `transitionIntent` only when the provider says it is cancelled; any other answer opens a review instead, which holds capture | a review is opened — captured money is never refunded silently; the merchant refuses (refunds) or approves |
| `review` | a review is opened; capture is refused (409 `payment_intent_unexpected_state`) until it is approved | a review is opened |

`POST …/capture` on a payment whose charge was not yet evaluated runs the evaluation
first (snapshot read, then the claim): a merchant cannot capture ahead of their own
rules. When the snapshot cannot be read, capture answers 503 and nothing moves (the
capture needs the provider anyway). When the snapshot was read but the judgment keeps
throwing, capture proceeds after one more try and logs it — an evaluator defect never
holds a merchant's money for ever.

Why not a confirmation token, so every card is judged before authorization? Moving
every client to "create a token, send it to the gateway, the gateway confirms" is a
change to the hosted checkout, Peable Elements, the native sheet and every
integration that confirms with the credential today, and the in-app sheet's bundle has
no room for it. The post-authorization phase covers every payment however it was
confirmed; a merchant who needs a card-fact rule to be a hard block uses `capture_method:
manual`, where a post-authorization block releases the authorization before any money
moves. Revisit when the clients move to server-side confirmation.

**Failure modes, each deliberate.**

- Snapshot unreadable → no evaluation yet; it runs on the next read, and capture waits
  for it.
- A crash between the claim of a post-authorization `block` and the release
  leaves the authorization held with the block recorded: capture refuses it
  (409), and the merchant cancels it (`POST …/cancel`) or the provider's
  authorization expiry does.
- A refusal whose refund the provider refuses permanently leaves the review open
  (its claim let go); its refund row (`review:<prv>`) stays `failed`, and a refund the
  merchant makes through `POST /v1/refunds` closes the review when it succeeds.
- Cancellation lost to the payer (`settled`), in flight or unknown → a review is opened
  and the truth is reconciled; nothing announces a cancellation the provider did not
  make.
- An evaluation error (a defect, not a decline) → logged; the payment proceeds. Rules
  are the merchant's policy layered on the provider's own fraud screening, not the
  only screen, and a gateway defect must not decline every card.
- A rule edited between the phases → each phase records the version it used.

### D4. Every match is recorded, and that is the explanation

An evaluation that ACTED writes a `radar_evaluations` row — a pre-authorization
`block` (allow and review do nothing before authorization), and every
post-authorization match (allow included):
the phase, the decision, the rule's id, version, action and predicate AS THEY WERE,
and the values of the facts that rule names — nothing else (an amount, a card's
country / brand / funding, which the charge already stores, a customer id, an email
the customer row already holds, counts). Exposed as `radar.evaluation` (`reval_…`),
`GET /v1/radar/evaluations?payment_intent=pi_…`, and in Orbit on the payment. A
post-authorization match also shows on the charge: `outcome.rule` (`{id, action,
predicate}`, Stripe's expanded shape), `outcome.reason: 'rule'`, `outcome.type`
`manual_review` or `blocked`. `Charge.outcome` also carries the provider's
`risk_score`.

### D5. Reviews

A Review (`review`, `prv_…`) is Stripe's object: `open`, `reason` (the current reason,
`rule` while open, the closed reason after), `opened_reason` (`rule`), `closed_reason`
(`approved`, `refunded`, `refunded_as_fraud`, `canceled`, `disputed`),
`payment_intent`, `charge`, and the rule that opened it. ONE per payment
(`unique(payment_intent_id)`). `PaymentIntent.review` and `Charge.review` name it.

- `POST /v1/reviews/:id/approve` (Stripe's) closes it `approved`; a held capture may
  proceed.
- `POST /v1/reviews/:id/refuse` (Orbit's; Stripe refuses from its dashboard)
  releases an uncaptured authorization through the cancel path (`canceled`) or
  refunds a captured payment in full through the refund path (`refunded`, or
  `refunded_as_fraud` with `reason: 'fraudulent'`).
- **Racing closes are serialised by a claim, and the claim is a lease.** A refuse
  first claims the review (`pending_closed_reason`, `pending_closed_until` = now + 10
  minutes; a CAS on `open` and no live claim, or its own), acts at the provider, then
  closes; approve needs no live claim. A refuse that loses at the provider lets its
  claim go and answers the error; its retry may resume its own claim; a refusal that
  died between its claim and the provider stops holding the review when the lease
  runs out.
- **A refund still pending holds the claim** (`pending_closed_until` NULL): the review
  stays open — neither approvable nor closed — until the refund succeeds (the refund
  closes it `refunded` / `refunded_as_fraud` in its transaction) or fails (the claim is
  let go in the `refund.failed` transaction, and the review is open again).
- A cancellation, or **any** succeeded refund — partial ones included, Stripe's
  behaviour — closes an open review in ITS transaction (`canceled`, `refunded`, or
  `refunded_as_fraud` for a `fraudulent` refund); a dispute closes it `disputed`.
- Events `review.opened` and `review.closed` (Stripe's names), recorded with the
  change through `recordEvent`, intent-scoped.
- `opened_reason: 'manual'` (a person queueing a payment) is not built: Stripe opens
  those from its dashboard, and Orbit has no such action yet.

### D6. FairCoin is never touched

The evaluator returns no decision for any intent whose rail is not `card`; the
two pre-authorization gates and the post-authorization hook are on card-only paths
(`confirmCardIntent`, `client_action` of a card intent, a charge). A blocked card
attempt on an order leaves the Checkout Session open, so its FairCoin option stays
offered (ADR 0021 D1). Tests prove both.

### D7. Permissions

Rules decide which money is accepted, so writing them is `money` (`billing:manage`),
like disputes; approving and refusing a review moves money, `money` too. Reading
rules, reviews and evaluations is `read`. Validating a predicate and previewing it
against recent payments write nothing and are `read`.

## Consequences

- A rule over card facts or the provider's outcome cannot stop an AUTOMATIC capture of
  a client-confirmed payment; it opens a review. The merchant is told this in the guide
  and in Orbit's rule editor.
- `payment_intents` gains no column; reviews and evaluations are their own tables, and
  `charges` gains `radar_evaluated_at`.
- The velocity facts read at most two indexed sets per evaluation, only when a rule
  names them.
