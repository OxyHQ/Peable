<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Orbit money: the merchant's account, fees, ledger, payouts (ADR 0015)

Fiat funds stay at the provider in an account that belongs to the merchant;
Orbit instructs and MIRRORS. There is no Peable-held balance and no table that
could represent one — a design that adds one supersedes ADR 0015 first.

- **The merchant's own account is a `connected_accounts` row with
  `role = 'merchant'`** (one per merchant, card half only, no `external_ref`),
  opened by `services/accounts/merchantAccount.ts` through the same seller
  machinery with `dashboard: 'none'`. Every SELLER read filters on the role
  (`IS_SELLER` in the repository); `toConnectedAccountDTO` throws on a merchant
  row rather than serialize it as a seller. `/v1/merchants/me` is the
  registration and stays separate.
- **The charge is decided once, at create, and replayed from the row**
  (`services/money/chargeRouting.ts`, `providerRoutingFor`): first-party →
  platform charge, no fee; own onboarded account → destination charge
  `on_behalf_of` it with the fee schedule's fee; own account still onboarding →
  409, never a silent platform charge; no own account → platform charge.
  First-party is `merchants.first_party`, mirrored from the credential's
  VERIFIED `authority: 'first_party'` by `resolveMerchant` — never branding or
  tier.
- **The live gate is `config.orbit.thirdPartyLivePayments`**
  (`ORBIT_THIRD_PARTY_LIVE_PAYMENTS`, default false): `assertLiveMoneyAllowed`
  sits at opening an account, a destination charge and a payout. Do not add a
  live money path for a non-first-party merchant without it.
- **The ledger is never invented.** `balance_transactions` hold the provider's
  own figures verbatim, keyed by the provider id (`ingestion_key`); a
  re-ingested transaction whose figures differ is a reconciliation mismatch,
  not an update. `postJournal` is the ONE writer of `ledger_entries` and refuses
  a journal that does not sum to zero. A balance is read from the entries,
  never stored. A merchant without an account has no balance (404
  `account_missing`), never zeros.
- **Reconciliation records, it does not correct** (`services/money/reconciliation.ts`):
  compare first, record mismatches, then the ordinary ingestion; the next run
  resolves what it no longer sees.
- **FairCoin is informational** — `recordFaircoinLedger` in `transitionIntent`'s
  transaction, reversed by a reorg; never payable. A quoted payment's entry
  carries its `faircoin_quote` (the fiat equivalent, ADR 0021 D7).
- **`Peable-Account`** is accepted only on the routes in
  `PEABLE_ACCOUNT_ROUTES` (`routes/money.ts`) and refused elsewhere by
  `refuseMisplacedPeableAccount`.
- **Connect's cores are shared with Orbit.** `routes/connectedAccounts.ts` and
  `routes/transfers.ts` export `(req, res, merchant[, surface])` cores that the
  dashboard mounts behind its membership gate (`…/connected_accounts`,
  `…/transfers`, `…/transfers/:id/reversals`), writes under `runIdempotent`. A
  seller read is always `IS_SELLER`; there is still no dashboard (or service)
  path that sets a seller's FairCoin key (ADR 0012).

**A dispute response is one shot, and none of its words are stored — the
provider is the store of a draft.** `POST /v1/disputes/:id` (Stripe's) STAGES
evidence with `submit: false`: the TEXT goes to the provider's own draft
(`disputes.update`), and Peable records only the provider's answer that
evidence exists (`disputes.has_evidence`, a boolean) — a merchant reading the
dispute back gets the text LIVE from the provider (`readDisputeEvidence`), and
only `GET /v1/disputes/:id` and the answers of the two writes carry `evidence`;
lists and EVENTS never do (an event is stored, and `recordDisputeEvent` strips
it). FILE fields name the merchant's own `file_…` of purpose
`dispute_evidence` (`dispute_evidence_files`, ids only — the composite keys
make "this merchant's" and the purpose structural); their bytes go to the
provider at SUBMISSION and only then, each under
`dpfile:<dp>:<field>:<file>`, and the provider's file ids are used once and
not kept. `submit: true` submits once under `dpev:<dp>`: a second submission,
or a draft after one, is refused (409 `dispute_already_submitted`) by reading
`disputes.evidence_submitted_at` — a CLAIM, guarded on it still being null —
and never by asking the provider. `POST …/close` accepts the dispute (`lost`)
by a CAS on `needs_response`, and the provider's later `charge.dispute.closed`
is not told twice. `reason` is Stripe's enum on the wire (unknown →
`general`); the row keeps the provider's word.

**A settlement figure is `null` with a status, never `0`.**
`services/settlementReport.ts` reads gross/fee/net live from the provider and
answers `unknown` for every reason a figure can be missing. It reports what the
provider took and attributes that cost to nobody — which entity bears it is a
commercial decision that is still open, and no code here makes it. Three reads
answer the ONE `settlement` object, each one movement of the settlement balance:
a payment's (`GET /v1/payment_intents/{intentId}/settlement`, its charge), a
refund's (`GET /v1/refunds/{id}/settlement`, `refunds.refundSettlement`; failed
or canceled is `unknown`) and a dispute's withdrawal (`GET
/v1/disputes/{disputeId}/settlement`, `disputes.settlement`; an inquiry is
`unknown`), with `refund` / `dispute` naming whose it is. Signs, for all three:
`gross` the magnitude, `fee` as the provider signs it (positive charged,
negative returned), `net` the signed balance effect — `gross − fee` for a
payment, `−gross − fee` for a refund or dispute — in the SETTLEMENT currency
(ADR 0015 "as built"). Every read goes through the one never-throwing
`readSettlement` in the row's own mode, over `SettlementReportingProvider`.
