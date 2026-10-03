# I08 inactive recurring observations

Base: `d77782b730e6d7657cfe4892ae1f8956b4074cbb` (Peable #89, on #88).
Local implementation and validation only; Peable #87 / Oxy #1519 remain open.
This is not a recurring payment engine, provider integration or commercial approval.

## What exists

Two additive tables, generated migration `0019_familiar_darkhawk`, marked `pre`:

- `recurring_mirrors`: explicit internal binding plus nullable snapshot, local
  revision and observation time. Global uniqueness covers provider, platform
  account, connected-account scope (NULLS NOT DISTINCT), mode, kind and object
  reference. Merchant and environment do not partition that identity. A composite
  foreign key binds merchant/application/environment to the existing merchant.
- `recurring_observation_outbox`: durable internal observations, unique by mirror
  and revision, referencing the source provider event. No dispatcher consumes it.

`bindRecurringObject` is an internal repository function. Its only callers are
fixtures. It reads application/environment from the existing merchant and checks
against explicit deployment identity. It accepts an opaque provenance reference,
not merchant provider credentials. It never reads event metadata. Rebinding to
another merchant/environment or replacing provenance fails. **Identity is
insert-only through the repository API; no database trigger makes arbitrary SQL
updates immutable.** The observation update whitelists only snapshot, revision
and observedAt. Foreign keys and uniqueness independently constrain SQL ownership.

A future approved importer must obtain platform account/mode from authenticated
Peable deployment evidence and merchant/application/environment from Oxy-backed
merchant registration; its attribution source, access control and references need
review before activation. There is no public binding API or importer in this change.

The strict Zod snapshot is a whitelist: object identity, API/schema version,
subscription status/cancellation flag or invoice status/currency/base-unit amount
strings, and periods by item/line reference. It stores no raw payload, customer
name, email, address, IP, card details or secret. Invoice subscription references
require a binding with the same merchant/application/environment/provider scope;
a previously observed invoice cannot silently change its subscription reference.

`RecurringReader` is a read-only, injected trusted seam, implemented only by a
local test stub here. It must return all normalized periods with `hasMorePeriods:
false`, unique item references, valid bounded periods and the configured version.
Validation detects declared incompleteness and malformed snapshots; it cannot
prove that a remote provider was fully paginated or that a reader is truthful.
No Stripe read adapter or remote call is implemented. Provider freshness and
normalization across API versions remain an integration contract to prove.

## Transaction and replay

The observer re-reads the stored event by id, locks it, checks processedAt,
provider/mode/version, finds an existing exact binding and locks that mirror.
It performs the bounded read under that lock, validates the snapshot and invoice
parent, then compares canonical JSON with ordinal keys and sorted item references.
It captures observedAt AFTER reading. Event timestamps and event ids never order
state; revision is local, allocated under the row lock.

A changed snapshot, its outbox row and event processedAt commit together. A new
event with unchanged normalized state marks that event processed without a new
revision/outbox. Replaying an already processed event does not call the reader.
Timeout aborts the signal and rolls back; a reader that ignores cancellation may
finish its read later but cannot write through this observer. Read timeout is
bounded to 1–10000 ms (default 2000); the injected reader must remain read-only.
Failures return a generic code without retaining provider exception text or PII.

Unknown bindings return `unmatched`, without attribution, snapshot, outbox or
processedAt. This module schedules no retries. Processing another known object
can proceed; no new drain or polling loop is introduced.

## Deliberately inactive routing and historical events

`processProviderEvent(event, options)` is the sole optional internal entry.
No production caller, boot path or existing drain supplies options. Without
options the previous behavior stays intact: recurring events become `no_mapping`
and are marked processed. Existing processed history is not silently replayed.
A future activation must coordinate routing across all workers and plan an
explicit, authorized backfill/reconciliation; enabling a competing observer
alongside the legacy drain would not establish delivery completeness.

**The stored event does not attest its platform account or Oxy environment.**
`options.deployment` and binding provenance are trusted internal inputs. They are
not cryptographic proof of which platform account received an old platform-scope
event. Before live activation, ingress identity/provenance must be persisted or
otherwise established unambiguously, including key/account changes and supported
API versions. This change does not autoattribute historical events.

ADR0009 remains binding: Peable holds provider credentials; merchants supply
none; no `provider_connections`. MoR and recurring contracts remain release gates.
No scheduler, charge, portal, mandate, retry/dunning policy, proration, entitlement,
public webhook event, SDK change, marketplace transfer or one-off flow is added.

## Executed evidence

Own PostgreSQL 17.11 on loopback5573, role `peable_i08`, no password, directory
`/tmp/inference-1519/i04-handoff-peable/pgdata`. Maintenance URL:
`postgres://peable_i08@127.0.0.1:5573/postgres`. Test databases were created/dropped
by `useGatewayDatabase` / `createSuiteDatabase`. Separate migration verification
used `i08_mirror_20261003`, then dropped it. `cleanup.txt` shows only maintenance
DB remaining and the dedicated server stopped; shared I06 server was untouched.

- First RED: new observer intentionally returned unmatched. Fourteen new assertions
  failed; binding and unknown-object tests passed. The package script also ran
  existing tests (its `bun test src` includes the entire src tree), exposing the
  exact schema census needing the two new tables: 671 pass / 15 fail overall.
- First implementation: 15/16 focal passed. JSONB key reordering exposed a duplicate
  observation; canonical comparison repaired it (`jsonb-red.txt`). A later Bun
  rejects-matcher mistake was fixed by executing the Drizzle query as a Promise;
  it was a fixture error, not a runtime ownership failure.
- Final focal: 20/20, including concurrent replay, distinct-event lock barrier,
  unchanged JSONB readback, reversed/equal event times, FK ownership, invoice-parent
  ownership, invalid identity/version/partial/PII snapshots, unknown binding,
  timeout/retry and SQL outbox failure rolling back state+processedAt.
- Full backend: 690/690 across 71 files. Only a test `import type` cleanup followed;
  executable code is unchanged. Backend build and final typecheck pass; Biome
  checks five new source/test files with zero warnings.
- Genesis migration: 20 applied. Repeat: zero pending. Exact 15-table census passes.

Every observation case asserts zero fetch calls. Provider stub only, no provider
sandbox, persistent credentials or real money. Commands, source and log hashes
are in `proof.json`. The final APIs remain candidates, not deployed or published.
