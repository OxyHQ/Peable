# ADR 0025 — Review the inputs before finalizing an invoice

**Status:** proposed; opt-in implementation, no financial activation.
**Date:** 2026-11-13.
**Extends:** ADR 0018.

## Context

An application can prepare a draft in Peable, review it, and subsequently ask
Peable to finalize it. Finalization can number and issue the invoice, apply the
customer's balance, record events and owe an email. Checking the resulting
invoice after these effects cannot protect an approval of an earlier draft.

The existing line digest protects preparation against some line changes. It
does not bind all the financial inputs an external application reviewed.

## Decision

1. Retrieve accepts `include_finalization_revision=true`. Only that opt-in
   response includes `finalization_revision`, a SHA-256 revision while the
   invoice is a draft and `null` otherwise. Ordinary retrieve, list, events and
   mutation responses retain their previous shape. A repeatable-read read-only
   transaction captures the invoice, its rendering and expansions, and the
   inputs used to compute the revision.
2. Finalize accepts optional `expected_finalization_revision`. Existing callers
   without it keep their existing behavior. A conditional caller must send the
   exact revision it reviewed. An `auto_advance` argument may confirm the
   existing value but cannot override the approved draft; update and review it
   first. The revision is scoped by the authenticated merchant's invoice lookup,
   not a substitute for merchant authorization or an idempotency key.
3. One versioned canonical encoder hashes the invoice, customer and payment
   methods, merchant, raw draft lines, coupon, referenced catalog entries,
   credited lines, effective billing settings, test-clock instant, captured
   customer-location inputs and effective tax policy. Integer amounts and
   decimals remain exact strings, dates use ISO instants, object keys are
   sorted, and unsafe numeric inputs are refused. The domain is
   `peable-invoice-finalization/v1`. No client supplies or recomputes this hash.
4. Numbering counters, wall-clock ticks, generated tax evidence/calculation IDs
   and failure annotations are not financial inputs. They do not invalidate
   their own retry. Active registration changes across a start/expiry boundary
   do change the revision. A missing billing-settings row has the same effective
   defaults as the row created at first finalization; reading a revision creates
   no settings row.
5. Conditional preparation uses the captured catalog, coupon, credit lines,
   location and tax policy. It cannot silently reread a different policy or
   switch provider identity. Tax computation remains outside the financial
   transaction. Neutral evidence and calculation records may be written during
   preparation, including when finalization later conflicts. They neither issue
   an invoice nor apply money, and are excluded from the revision.
6. Final commit takes the invoice lock in a SERIALIZABLE transaction and
   captures/revalidates the inputs again before any finalization effects. That
   transaction's snapshot/lock is the linearization boundary. Concurrent
   independent catalog or tax changes may serialize after it and govern future
   invoices; this does not promise a conflict for every overlapping write.
   Invoice/item writers lock the invoice and check its draft status in their
   own transaction, so an editor waiting behind finalization cannot alter its
   now-open lines. Balance and numbering/settings reads and writes, invoice
   transition, tax commit, events and email outbox remain in the same commit.
7. A stale revision or serialization failure returns HTTP 409 with
   `invoice_finalization_conflict`, without transition, number allocation,
   balance application, financial journal, outbox/email or collection from
   that finalization. There is no automatic retry with the stale approval.
   Retrieve and review again. A lost response is reconciled by reading the
   existing invoice, not by creating a second one.

## Validation and limits

PostgreSQL tests cover stale lines, discounts, terms, customer inputs, balance,
settings and tax policy; line insertion/update/deletion and fiscal/balance
mutation while a tax calculation is held; final-transaction settings contention
and serialization rollback; and an editor waiting behind a successful finalize.
They assert the absence of numbering, balance application and emitted invoice
state on conflict, and preserve old callers and ordinary wire shapes.

This feature does not authorize a merchant, approve its tax setup, choose terms
or a billing cadence, or finalize/pay a production invoice. Consumers such as
Kaana must explicitly review those inputs and the deployment of this contract
before enabling their own finalization operation. An approved revision binds
inputs, not a promised tax-provider output amount; the issuer still validates
and reconciles the resulting final invoice under its existing tax rules.


## Accepted revision receipt

An opted-in retrieve also returns `accepted_finalization_revision`. It is null
on drafts and invoices finalized without the precondition. Conditional
finalization stores the exact accepted revision in the SAME transaction as
numbering, status, balance application and outbox effects. A refused or rolled
back attempt cannot leave a receipt. Later retrieve, including after a lost
finalize response, returns that stored value rather than recomputing a digest
from mutable tax settings or comparing amounts. A repeated finalize cannot
replace it. Ordinary retrieve, list, events and mutation responses still omit
both optional fields.

Migration 0130 adds one nullable column without default or backfill. Existing
invoices have no manufactured proof. A consumer must retain an unresolved
operation when the accepted revision is absent or differs; a matching customer
and total alone do not prove that the reviewed fiscal inputs were used.
