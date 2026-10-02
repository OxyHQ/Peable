# I08 private recurring reader candidate

Base: `72a92c1e4a42498dcd302137989e9a98e098be39` (draft #90). This milestone
adds an inactive, private reader/normalizer behind an injected read-only client.
No boot, registry, ingress, public API, schema/migration, credentials, SDK release,
provider network or financial operation changes. I08/#87 remains open.

## Contract and boundaries

`createPrivateStripeRecurringReader` takes trusted deployment/platform/mode/version
and connected-account scope matching an existing explicit binding. It requests the
existing pinned `STRIPE_API_VERSION` through four read-only client methods:
`retrieveSubscription`, `listSubscriptionItems`, `retrieveInvoice`, `listInvoiceLines`.
Only tests construct this reader. Its constant import loads the existing Stripe
client module (and its Stripe/config imports), but never calls `getStripeClient`
or constructs/configures a credentialed SDK client. No real SDK adapter is wired.
The injected client is trusted to honor scope/version; body validation is not
cryptographic platform-account or API-version attestation. Historical ingress
identity and `no_mapping` replay/import remain separate activation gates.

The installed Stripe 22.4.0 declaration files under `node_modules/stripe/esm/resources/`
are the shape evidence. Fixtures use `satisfies Pick<Stripe.Subscription/...>`.
`InvoiceLineItems.d.ts:72` has top-level `subscription`; its parent also names the
subscription. Lines105–112 explicitly allow inclusive `end >= start`, so invoice
periods now accept equality, with a recorded failing regression first. Subscription
periods retain `end > start`. Unknown results are parsed into whitelisted projections;
raw payloads, metadata, customer PII and provider error messages are not retained.
Safe nonnegative integer observed invoice amounts become canonical strings without
summing, allocating or awarding anything. Unsafe, fractional or negative values fail.

Pagination starts with a dedicated list call, ignoring embedded preview pages.
Every page is validated; maximum100 entries/page,20 pages and1000 total periods.
Duplicate IDs, repeated cursors, empty `has_more`, caps and inconsistent identities
reject the entire observation. Exhaustion emits `hasMorePeriods:false`; this means
only that the injected client exhausted its lists, not a remotely atomic snapshot.
One root reread compares observed root fields after pagination. It can detect a
changed status/amount/parent, but not changes hidden in intermediate pages, deletion
and recreation between reads, or a remote change followed by reversal. A future
real adapter/consistency contract must address these limits before activation.

Invoice coverage is deliberately narrow: an explicit subscription invoice parent,
unexpanded IDs, and each line's matching invoice/mode/subscription plus a
`subscription_item_details` parent with `proration:false`. Other invoice-item lines,
adjustments/prorations, expanded references, preview/null parents and unsupported
statuses are rejected; they are not attributed by metadata or inferred from amounts.
Empty exhausted lists remain valid observations, without asserting commercial rights.

A single two-second budget covers root, all pages and reread, additionally bounded
by the observer's upstream AbortSignal/deadline. An uncooperative client's Promise
is abandoned on abort and no subsequent request begins. This does not prove that a
future network transport cancels an already-issued HTTP request.

## Executed evidence

- RED: invoice point period rejected by previous schema (0pass/1fail; filtered tests).
- Final focal:42 reader cases +21 actual PostgreSQL observer cases =63pass/0fail.
- Full backend package:733pass/0fail,72files,2033 assertions.
- Backend typecheck/build and Biome lint (`--error-on-warnings`) passed.
- SQL composition: normalized invoice point period → actual mirror/internal outbox/
  processed event atomically; a new identical observation is unchanged; invalid
  pagination leaves event pending, revision/outbox unchanged. All reader/observer
  fixtures reject global `fetch`; no merchant dispatcher is invoked by this path.

Commands and SHA-256 hashes of final sources/logs are in `proof.json`. Tests run with
`bun run test` in `packages/backend`, never a bare Bun test. PG17.11 was owned by
this task's previous milestone: role `peable_i08`, loopback5573, sanitized URL
`postgres://peable_i08@127.0.0.1:5573/postgres`, data directory
`/tmp/inference-1519/i04-handoff-peable/pgdata`. The harness created and dropped a
fresh fully migrated DB per file. Final catalog contains only `postgres` (excluding
templates), then our server was stopped; cleanup log confirms no server running.
The unrelated I06 instance on5549 was untouched.

Two setup/fixture corrections preceded final checks: the first server start lacked
a writable Unix-socket directory (fixed with `-k` in task scratch); the new SQL
fixture initially passed an event ID to routing expecting an event row (corrected
via repository lookup). Neither was a product failure. The period RED is the
product regression. No migration or financial sandbox was executed for this tranche.

## Remaining gates

No complete BillingProvider contract, recurrent checkout/portal/cancel engine,
remote reader consistency/transport verification, persisted ingress platform identity,
binding importer, historical replay policy, MoR decision, lifecycle sandbox,
publication, consumer adoption or production activation is supplied by this change.
