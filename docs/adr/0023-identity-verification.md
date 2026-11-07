# ADR 0023 — Identity verification: Orbit keeps the verdict, the provider keeps the person

**Status:** accepted, built (Orbit Phase 8, item "Identity").
**Date:** 2026-11-07.
**Builds on:** ADR 0014 (Orbit wire), 0016 (Orbit owns its objects), 0017 (test and live in one deployment), and the provider boundary (`docs/integrations/payment-provider-boundary.md`).

## Context

Merchants on Orbit ask the question Stripe Identity answers: is this person who
they say they are? A hosted flow photographs a government ID, optionally a
selfie matched against it and an ID number, and gives a verdict. Stripe is the
one contracted provider and offers it; Orbit's job is the Stripe-shaped API
(`identity.verification_session`, `identity.verification_report`), the
merchant's events and Orbit's screen — without becoming a second store of
people's identity documents.

That last point decides the design. A copy of a passport scan, a date of birth
or a document number in Peable's database would be a liability with no
product use: the provider already holds them under its own retention and
redaction, and a merchant that needs them can ask at the moment it needs them.

## Decision

### D1 — What Orbit stores

`verification_sessions` (`vs_…`): the merchant's CONFIGURATION — `type`
(`document` | `id_number`), `options` (allowed document types, live capture,
matching selfie, ID number), `return_url`, `client_reference_id`, `metadata` —
and the provider's VERDICT — `status`, whether the last attempt failed and its
error CODE, the redaction status — plus the provider binding
(`provider`, `provider_object_id`). `livemode` is the merchant's, read in the
statement (ADR 0017).

`verification_reports` (`vr_…`): one row per provider report, holding each
check's OUTCOME — `document`, `id_number`, `selfie`: `verified` / `unverified`
and an error code — the report's type and the options it ran with. A provider
report is immutable, so it is recorded once (`unique(provider,
provider_object_id)`, insert-or-nothing).

### D2 — What Orbit never stores

- **The person's data**: names, dates of birth, addresses, document and ID
  numbers, document type and issuing country, emails, phones. No column can
  hold them; `verified_outputs` on a retrieve with
  `expand[]=verified_outputs` (and `verified_outputs.dob` /
  `verified_outputs.id_number`, as on Stripe) is read LIVE from the provider
  for that answer, sent with `Cache-Control: no-store`, and never written. It
  is `null` before `verified` and after a redaction, and never on a list, an
  event, or Orbit's dashboard (the dashboard refuses the expansion).
- **Images and files**: the provider's report names the File ids of the
  document and selfie images; they never leave the adapter. Orbit holds no
  document bytes — identity verification adds no `files` purpose.
- **The person's single-use credentials**: the hosted `url` (48 h) and the
  modal's `client_secret` (24 h) are passed through on the create answer and on
  a retrieve while `requires_input`. They are never a column, never on a list,
  never in an event. (The generic idempotency layer replays a create's stored
  answer for 24 hours, as it does for every `client_secret`; that store is
  `no-store` on the way out and expires.)
- **The provider's prose**: `last_error.reason` and each check's
  `error.reason` are Orbit's own sentence for the code
  (`VERIFICATION_ERROR_REASONS`), the rule `last_payment_error` follows. An
  unknown code is a failure without a code, never a guess.
- **The merchant's reference at the provider**: the provider is sent the type,
  the options, the return URL and Orbit's correlation id
  (`peable_verification_session_id`) — never `client_reference_id` or the
  merchant's metadata.

The adapter (`services/providers/stripe/identity.ts`) is the firewall: the
provider interface (`IdentityVerifyingProvider` in `provider.ts`) carries
verdicts only, and `ProviderVerifiedOutputs` exists only for the live read.

### D3 — Provider first, row second

Unlike a payment (row first, so a crash leaves something a retry finishes), a
session is created at the provider FIRST under `vs:<public id>`, then the row
and its `identity.verification_session.created` event in one transaction. A
provider that refuses (Identity not enabled) must not leave an Orbit session
nobody can ever complete; an orphaned provider session moves no money, holds
nothing until a person opens its URL, and expires. `provider_object_id` is
therefore NOT NULL. A provider event that arrives in the window before the row
exists is `unmatched` and retried by the drain, never dropped.

### D4 — One path for every change, and the events it records

`applyVerificationSnapshot` (`services/identity/verificationSessions.ts`) is
the ONE place a provider session becomes a change: the drain (every
`identity.verification_session.*` provider event means "re-read it", as with
SetupIntents), a retrieve that reconciles a non-terminal session, a cancel and
a redaction all go through it. In one transaction it records the newest
report's outcomes, writes the status as a compare-and-swap on the status it
read (`verified` and `canceled` are terminal; an illegal move is
`irreconcilable` and left failed for an operator), performs the erasure a
redaction owes, and records Orbit's event through `recordEvent`:
`processing`, `verified`, `requires_input`, `canceled` when the status moves;
`requires_input` again for a new failure without a move; `redacted` once when
the provider finishes erasing. `created` is recorded at create.

### D5 — Modes (ADR 0017)

Creating a session is a NEW operation: `selectProvider('stripe',
environment)` picks the credential's mode. Everything after — retrieve,
update, cancel, redact, verified outputs, the drain — resolves by the row's
`livemode` (`selectStoredProvider`). A mode with no key, or a provider account
without Identity (the adapter maps Stripe's permission refusal and "not
activated" answers to `IDENTITY_UNAVAILABLE_CODE`), is 503
`identity_unavailable`; nothing falls through to the other key. The drain
refuses an event of the other mode (`refuseCrossMode`).

### D6 — Redaction

`POST …/redact` (Stripe's) is irreversible erasure. The provider redacts the
session and its reports over up to four days (`redaction.status`
`processing` → `redacted`, a `redacted` event). Orbit does not wait: in the
same transaction it erases the session's `metadata` and `client_reference_id`
— a CHECK (`verification_sessions_redacted_holds_no_reference_check`) keeps a
redacted row from holding them — and the same two fields in every stored
`identity.verification_session.*` event of that session
(`redactVerificationSessionEvents`, the one write to an event after its
insert, because an event is re-sent byte for byte for 30 days). The outcome
rows stay: they hold nothing about the person. A `processing` session cannot
be redacted (409); a `requires_input` one is canceled by the provider.

### D7 — Who may do it

The merchant API: reads `payments:read`, writes `payments:write`, every POST
idempotent. Orbit: reads are `read`; create, update, cancel and redact are
`money` (`billing:manage`) — sending people through identity checks, and
erasing what they submitted, is account and compliance work, not
configuration. Orbit shows the verdict and each check's outcome; it never
shows the person's data.

## Consequences

- Live use needs Stripe Identity activated on the live Stripe account, and the
  platform webhook endpoint subscribed to `identity.verification_session.*`
  (owner actions; nothing here changes the Stripe dashboard). Until then a
  production merchant gets 503 `identity_unavailable`.
- Not built: `provided_details` and the email / phone checks (they would send
  the person's contact data from Orbit), `related_customer` /
  `related_person`, dashboard-built `verification_flow`s, and a browser SDK
  for the in-page modal (`client_secret` is passed through for a merchant that
  uses the provider's own).
- A merchant who needs the verified data must read it at the moment of need,
  and must redact when their own retention ends: Orbit has nothing to purge
  but the reference it erases.
