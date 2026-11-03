# ADR 0020 — Business tax compliance: Peable Tax decides, Orbit asks, people approve

**Status:** accepted for slice 1 (milestones 1–3 of OxyHQ/Peable#201). Milestones 4–6 are proposed here and stay unavailable until built.
**Date:** 2026-11-03.
**Builds on:** ADR 0011 (Peable Tax), 0012 (card rail), 0013 (renewals and reversals), 0014 (Orbit wire), 0016 (Orbit owns its objects), 0017 (test and live).

## Context

Peable Tax (ADR 0011–0013) prices a sale once the owner says where the business
is registered and approves. It does not help an owner work out WHERE they need
to register, track registrations they made outside Peable, hold the documents
behind them, or see deadlines. Oxy, the first internal customer, needs those
workflows. External businesses need them after tenant isolation and the
supported jurisdictions are proven.

ADR 0011 says "which registrations a seller needs is a legal question, never
code". This ADR keeps that rule. Code may compare recorded facts with a
versioned, sourced rule. It may say what the rule indicates and send the
finding to a person. It never concludes, and it never acts.

## Ecosystem audit (2026-11-03, read from each repository's `origin/main`)

Status words: **implemented** means merged code with tests. **Deployed** means
a production deploy is recorded. **Incomplete** means it exists but does not do
the whole job. **Proposed** means a design only. A README is not taken as proof
of any of these.

| Area | Capability | Status | Evidence |
|---|---|---|---|
| Peable | Tax settings, registrations, owner approval (`billing:manage`), Stripe Tax provider, fail-closed calculation | implemented, deployed | `services/tax/taxService.ts`, `routes/tax.ts`, ADR 0011 |
| Peable | Location evidence rules (no language, currency or timezone) | implemented, deployed | `services/tax/evidence.ts` |
| Peable | Signed FairCoin and card quotes; renewal repricing; reversals | implemented, deployed | `services/tax/billingTaxQuotes.ts`, `services/billing/stripeInvoiceTax.ts`, ADR 0012–0013 |
| Peable | `automatic_tax` at Checkout v2 through Peable Tax | implemented, deployed (#202, `1f247b9`) | `docs/orbit/stripe-parity.md` |
| Peable | Summary report and CSV per jurisdiction and rate | implemented | `TaxService.report`; it is not a return |
| Peable | Orbit Tax screen (settings, registrations, approval, report) | implemented | `packages/orbit/app/(orbit)/tax.tsx` before this change |
| Peable | Obligation assessment, onboarding, documents, deadlines | absent before this ADR | — |
| Oxy | Accounts and organization accounts; `organization_profiles` (legal name, country, type, staff-reviewed claim) | implemented (ADR 0039) | `packages/api/src/db/schema/organizationProfiles.ts`, `oxy@a813cba` |
| Oxy | Account roles and permissions, including `billing:read` and `billing:manage`; application-declared roles | implemented | `utils/accountRoles.ts`, `docs/auth/application-roles.md` |
| Oxy | KYC or verified legal identity, registration numbers, VAT IDs | absent | Mentioned only as an open question in `docs/auth/proposals/bot-autonomous-auth.md` |
| Oxy | Files: private visibility, references by entity type, signed file events, blocked and lost states | implemented; storage deployed (R2, ADR 0047) | ADR 0043 (header says "proposed", but stages 1–4c are built), `fileEvents.ts` |
| Oxy | Retention, legal hold | absent; lifecycle enforcement probably still report-only | `FILE_LIFECYCLE_MODE` defaults to `report` |
| Oxy | First-party workload authority for Peable | implemented, recorded as deployed | ADR 0049, `docs/architecture/first-party-integration-migration.md` |
| Oxy | Tax engine of its own | absent; Oxy One's tax-inclusive sale is blocked pending tax configuration | `docs/products/oxy-one-launch-readiness.md` |
| Alia | Agent runtime that calls Oxy-app tools | implemented, deployed (rollout gated per its ADR 0022) | `packages/api/src/lib/tools/oxy-services.ts`, `Alia@d76bed3` |
| Alia | Human approval before a tool acts | deliberately absent; financial-effect tools run directly | `oxy-no-approvals.test.ts`, `agent/governance.ts` |
| Alia | Any tax or Peable Tax tool | absent | — |
| Mercaria | Its own tax engine: merchant-set `tax_rates`, applied at checkout | implemented, deployed | `services/pricing.service.ts`, `services/tax.service.ts`, `Mercaria@92a03b7` |
| Mercaria | Peable Tax | not used | Nothing under `services/payments/**` sends tax to Peable |
| Mercaria | Digital paid launch with tax sign-off | incomplete (the tax gate is open) | `HANDOFF.md` §3 |

What follows from the audit:

- **One financial authority.** Mercaria's `tax_rates` engine is a second tax
  authority. This ADR does not touch Mercaria. Moving it onto Peable Tax, or
  retiring it, is a Mercaria decision, recorded as a follow-up in #201.
- **Alia cannot be the approval step.** It runs tools with no human
  confirmation. So no Peable tool that activates collection, approves,
  registers, files or pays may ever appear in Alia's catalog. An assistant
  gets read tools and draft-only writes. The owner confirms any draft in
  Orbit, under the owner's own session.
- **Oxy has no fiscal identity data,** and Oxy's `verified` flag is not legal
  identity. Peable must not treat an Oxy organization, its country or its
  verification as evidence of anything fiscal.
- **Oxy Files keeps no retention or legal hold.** A Peable File is never
  deleted while its row lives, so its Oxy reference stays and the bytes are not
  purged as unreferenced. A file can still be `blocked` or `lost`. When that
  happens the document shows as removed; it is never silently assumed to exist.

## Decision

### Boundaries

| Party | Owns | Never does |
|---|---|---|
| **Peable Tax** (`services/tax/*`) | The financial engine. Calculation and collection (ADR 0011–0013). Now also compliance records, the versioned rule set, assessments, the review queue, deadlines and history (`services/tax/compliance/*`). There is one implementation | Registers, files or pays with an authority. Infers liability from an incorporation address, a company number, a language or a currency |
| **Orbit** | The merchant interface: the Tax workspace, built with Bloom | Holds any decision logic of its own |
| **Oxy Files** | The bytes of protected documents (`tax_document` Files, private, never addressable by URL) | Decides what a document proves |
| **Alia** (future) | Explaining, and preparing drafts the owner confirms in Orbit | Approves, activates, submits or decides — and no tool for any of these exists |
| **The owner** (`billing:manage`) | Every onboarding fact, every review decision, and collection activation (ADR 0011 approval) | — |

The compliance code writes no `tax_settings` and no `tax_registrations`. It
calls no tax provider. Nothing it stores is read by the calculator. So no
compliance record, whether written by an owner, a service credential or an
assistant, can make Peable collect tax. Collection still means the owner adds
a Peable Tax registration and approves it, which is unchanged and has no
service-auth path.

### Data model (slice 1, migrations `0073` pre and `0074` post)

All of it is scoped to one merchant, meaning one application in one
environment. That is the tenant `tax_settings` already uses. Every repository
function filters by the merchant's internal id.

| Table | Object (`id`) | What it is |
|---|---|---|
| `tax_business_profiles` | `tax.business_profile` (singleton) | Entity type (with `unknown`), incorporation country and state, fiscal year end, customer and supply types. No government identifier (see below). `legal_name` is read from `tax_settings` |
| `tax_operating_locations` | `tax.operating_location` (`taxol_`) | Where the business actually operates. `head_office` and `fixed_establishment` are the owner's statement of establishment. Ended, never deleted |
| `tax_sales_destinations` | `tax.sales_destination` (`taxdest_`) | Where the owner says it sells. Actual sales come from `tax_transactions` |
| `tax_registration_declarations` | `tax.registration_declaration` (`taxrd_`) | Where the business stands with an authority, in the owner's words: `unknown`, `not_registered`, `application_pending`, `registered`, `rejected`, `ended`. Carries effective dates and filing frequency. `verification` is always `unverified`. May point at the `taxreg_` Peable collects under |
| `tax_compliance_documents` | `tax.document` (`taxdoc_`) | A `file_` of purpose `tax_document`. The composite key `(file_id, merchant_id, file_purpose)` points at `files`, so a document can only be one of the merchant's own tax-document files. At most one document per file |
| `tax_compliance_assessments` | `tax.assessment` (`taxasm_`) | Frozen: the rule set version, the exact inputs, their SHA-256, the results and who ran it |
| `tax_review_items` | `tax.review_item` (`taxrev_`) | The queue. At most one OPEN item per `(merchant, dedupe_key)`, enforced by a partial unique index, so a re-run keeps the item instead of duplicating it. A decision is a compare-and-swap on `status = 'open'` and records who decided and when |
| `tax_compliance_actions` | `tax.compliance_action` (`taxact_`) | Append-only history, written in each change's own transaction. It records field names and statuses, never a number's or a document's contents |

The issue's other states are modelled as **capabilities that report
`not_available`**, not as stored states: registration applications and
submissions, returns, remittances and official receipts. No table stores a
"filed" or "paid" state, because nothing can make one true yet.

**No government identifiers.** EIN, company numbers and VAT numbers are not
collected in this slice. No supported rule needs one, and none of them is
evidence of an obligation. The existing `tax_registrations.registration_number`
is unchanged. A later slice that needs identifiers stores them as protected
columns (`db/protectedColumns.ts`), kept out of the history.

### The rule set: versioned code with sources

`services/tax/compliance/ruleSet.ts` defines versions. Version `2026-11-03.1` is
the initial supported set:

| Rule | What it covers | Threshold | Sources | Effective |
|---|---|---|---|---|
| `eu_vat_b2c_cross_border` | EU VAT on cross-border B2C electronic services and distance sales (OSS) | Over EUR 10 000 in the current or preceding calendar year, for a supplier established in exactly one member state. A supplier established outside the EU has no threshold and owes VAT from the first sale (non-Union scheme) | European Commission OSS pages; Directive 2006/112/EC Art. 59c, 358a–369k | 2021-07-01 |
| `us_tx_sales_tax` | Texas sales and use tax: the remote-seller safe harbor | USD 500 000 total Texas revenue over the preceding twelve calendar months. Crossing it sets a permit deadline: the first day of the fourth month after. A declared location in Texas takes the seller out of the safe harbor and is escalated | Texas Comptroller, "Remote Sellers" (34 TAC §3.286) | 2019-10-01 |

Every other jurisdiction is **unsupported**. An assessment reports sales there,
opens a review item, and infers nothing. Every rule lists its coverage limits:

- only sales recorded in Peable Tax are visible;
- business and consumer customers are not told apart, so every sale counts as B2C (an over-count);
- only the threshold's own currency is counted, and other currencies are named rather than converted;
- domestic VAT in the establishment state, marketplace rules, return dates that depend on an assigned filing frequency, and Texas franchise tax are not assessed.

Every rule is marked `review.status: unreviewed`: it is encoded from official
sources but has not been signed off by a tax professional. Orbit says so above
every finding.

**Versioning and replay.** A published version is immutable. A change is a new
version beside the old one. An assessment stores its version and its exact
inputs. `GET …/assessments/:id/replay` re-runs those stored inputs through that
stored version and reports `matches`. A version that is no longer available
answers `rule_set_version_unavailable`; it is never silently replaced by the
current one. The evaluator (`evaluate.ts`) is a pure function and sums in
`bigint` / `numeric`.

### Assessment outcomes and escalation

Each jurisdiction gets one of these outcomes:

- `registration_declared`: the owner declares a registration in force. If
  Peable does not collect under an approved registration there, a
  `collection_not_configured` item is opened.
- `likely_required`: the rule indicates an obligation. An item is opened.
- `approaching_threshold`: at or above 80% of the threshold.
- `not_indicated`.
- `uncertain`: missing or contradictory facts. These include no declared
  establishment, several establishments, an `unknown` status, a pending
  application, unconverted currencies, or physical presence. An item is opened.
- `unsupported`.

Several findings are escalated regardless of outcome:

- sales after an ENDED registration;
- approved collection with no declared authority registration behind it;
- a pending application, which is ambiguous and never treated as registered.

Measured sales use the same netting as the summary report: originals add
`amount_net`, and reversals add their signed `amount_net`. Transaction counts
count sales, never reversals.

### Authority, tenant isolation and auditability

- **Merchant API** (`/v1/tax/*`, service credential): reads everything and runs
  assessments (`payments:write`, behind generic idempotency). Writes of
  onboarding facts and review decisions are **not mounted** on it.
- **Orbit** (`/v1/dashboard/applications/:id/tax/*`): `billing:read` to look.
  `billing:manage` for every write and every decision, the same oxy-api
  permission as the ADR 0011 approval. Dashboard writes run under
  `runIdempotent` and open the request context, so an event records the
  request that caused it.
- **Events:** `tax.assessment.created`, `tax.review_item.created` and
  `tax.review_item.updated`, each recorded in the change's transaction.
- **The first-party provider account** (Oxy's Stripe Tax) is untouched. This
  slice adds no way for any merchant to reach it. The ADR 0011 rule still holds:
  only official applications calculate on it, and only after owner approval.
- **Documents** are private Files and cannot be attached across merchants or
  across purposes. Their bytes are never forwarded. A removed file shows as
  `removed` and its checklist item as `unavailable`.

### Three kinds of obligation, kept apart

Orbit's capabilities list keeps three things in separate categories:

- `vat_sales_tax`: assessed for the supported rules.
- `corporate_income_tax`: `out_of_scope`. This includes Texas franchise tax, an entity-level tax with its own nexus test.
- `annual_company_filings`: `out_of_scope`.

A sales-tax finding is never presented as an income-tax or company-law fact.

## Implementation slices

| # | Milestone | What it needs to be live | State |
|---|---|---|---|
| 1 | Business onboarding | Tables, routes, Orbit Business, Registrations and Documents sections; a `tax_document` purpose; history | **Built in this change.** Live once deployed and Oxy's owner enters its facts |
| 2 | Tax workspace | Orbit sections for Overview, Review, Deadlines, History and Collection & reports (the existing settings, approval and report) | **Built.** Filing-period views come with 5 |
| 3 | Obligation assessment | Versioned rule set with sources, assessments, replay, review queue, events | **Built** for the two rules above. Each new jurisdiction is a new rule-set version, signed off by a tax professional before its review status becomes `reviewed` |
| 4 | Registration workflows | A provider or government integration, chosen only after its costs and responsibilities are written down. An authorized-submission action (owner, step-up). States: submitted, pending, rejected, accepted, with the official confirmation stored as a document. An idempotent submission ledger that tolerates ambiguous outcomes (submitted with no answer stays `pending` and is reconciled, never retried blindly) | **Proposed.** Shown as `not_available` |
| 5 | Returns and remittance | Filing periods from declared frequencies. Period reconciliation of payments, refunds and adjustments against `tax_transactions`. A return draft (not the CSV). Authorized submission. Payment instructions with idempotent remittance and official receipts. An attempted remittance stays `pending` until a receipt says otherwise | **Proposed.** Shown as `not_available` |
| 6 | External-business readiness | Per-entity authority across merchants (an Oxy organization as the legal entity). Retention policy and legal hold for tax documents (needs Oxy Files support). Supported-jurisdiction review sign-off. A tenant-isolation audit. A separate provider tax account per external business, so Oxy's first-party account never collects for others | **Proposed** |

Follow-ups recorded in #201, outside this repository: Mercaria's own tax
engine (one financial authority), and Alia read-only tools that may explain
and draft.

## Operating it: who owns what, and what stays manual

- **The business owner** (a `billing:manage` member of the application) enters
  the facts, decides every review item, and alone turns collection on. Peable
  does none of this for them, Oxy included.
- **Manual review stays mandatory** for every finding. The rules are
  unreviewed, business and consumer customers are not separated, sales outside
  Peable are invisible, and unconverted currencies are excluded. Registering
  with an authority, filing returns, paying tax, and keeping official
  confirmations all happen outside Peable. The confirmations are then uploaded
  as documents.
- **Peable engineering** owns the rule set. Adding or changing a rule means
  publishing a new version with its sources, getting a tax professional's
  sign-off, then marking it `reviewed`. Replays of old assessments must keep
  matching.
- **Oxy as first customer.** Its owner enters Oxy's facts in Orbit. No current
  Oxy registration is recorded or marked verified by this change. The Mention
  Plus checkout and its tax permissions are unchanged.
- **No live activity for testing.** Every fixture is synthetic. Nothing here
  makes a provider call, a charge or a government submission.

## Consequences

- The Tax workspace can tell an owner what the supported rules indicate, with
  evidence and sources. It cannot register, file, pay or turn collection on,
  and it says so in its capabilities instead of simulating any of them.
- Adding a jurisdiction is a reviewed rule-set version, never a data edit.
- Existing ADR 0011–0013 behaviour is unchanged: calculation, approval, quotes,
  renewals, reversals and Checkout v2's `automatic_tax`.
