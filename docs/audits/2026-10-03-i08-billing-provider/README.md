# I08 BillingProvider checkpoint — local source candidate

Source `efbe3c822185d8cf1eb0abed80be7a38c4525364` implements the five methods,
OxyServer scope-checked HTTP routes and `peable.billing` SDK namespace. The approved
scope and remaining commercial/rollout gates are in
[the cohort decision](../../integrations/i08-approved-recurring-cohort.md).

Executed: backend **758/758** across 74 files with real PostgreSQL, SDK **115/115**,
TypeScript/build/lint, SDK CJS/ESM/types build, normal migration generate and repeat
(no change). The migration rehearsal applied **21** migrations, repeated with **0**,
found the two billing tables and six FKs, then dropped its own database. Generated
long FK names produce PostgreSQL truncation notices; their names remain distinct.
No snapshot or migration journal was hand-written.

The 25 new backend cases cover 11 repository and 14 HTTP/domain cases. HTTP tests
run the **built SDK**, Express routes, provider adapter and SQL repositories.
Oxy mint/auth and Stripe responses are explicitly synthetic boundary seams;
OxyServer's scope guard remains real. There is no provider network or real payment.
Store/plan references and exact customer/price bindings are asserted. This is not
an Oxy payer identity mapping or an entitlement calculation.

RED evidence is explicit: ten repository cases initially reached unimplemented
repository stubs; the realistic `cs_test_...` fixture then reproduced two Checkout
failures in the first adapter regex. Fixing its object-specific grammar made both
pass. The first full run had two expected integration gates (new tables missing
from the closed census and an undeclared optional deployment variable), corrected
before the final 758/758 run. An earlier invocation used a filename argument after
`bun test src`, which adds patterns rather than narrowing them; it was interrupted.
Its empty owned harness database was removed through `dropTestDatabase`; no
foreign database or server was stopped.

PostgreSQL 17.11 is this agent's existing local instance at `127.0.0.1:5574`, role
`oxy_i01`. The harness creates its own `oxydb_test_*` database per file and drops
it. The server remains running. Exact rehearsal absence and zero remaining
harness databases are recorded after cleanup. URLs in fixtures are synthetic;
no key, bearer or live hosted URL is included in evidence.

Commands, from the repository (package commands use their own scripts):

```sh
bun install --minimum-release-age=0
bun run --cwd packages/shared-types build
bun run --cwd packages/sdk build
bun run --cwd packages/backend test --test-name-pattern 'I08 billing HTTP|billing ownership and durable claims'
bun run --cwd packages/backend test
bun run --cwd packages/sdk test
bun run --cwd packages/backend build
bun run --cwd packages/backend lint
bun run --cwd packages/backend db:generate
```

Database commands use `DATABASE_URL` and `TEST_DATABASE_URL` pointing at the
owned local administrator database; the application migration entrypoint creates
and migrates throwaway databases. The repeated rehearsal invokes that same
`db/migrate.ts main()` with `--target-database=<own-db> --phase=all`.

`PEABLE_BILLING_COHORT` is an explicit deployment JSON, absent by default:

```json
{
  "deployment": {"provider":"stripe","platformAccountId":"acct_APPROVED","livemode":false},
  "portalConfigurationRef":"bpc_APPROVED",
  "cohorts":[{"merchantId":"INTERNAL_MERCHANT","oxyAppId":"REGISTERED_APP","environment":"development","evidenceRef":"review:APPROVED"}]
}
```

It contains no credentials. Boot validates the account/mode and Portal configuration
before listening; every mutation repeats platform verification. Portal also checks
configuration on replay and around creation: no subscription updates, no immediate
cancellation, exact returned configuration, no `on_behalf_of`. Calls share the
existing configured SDK and pinned API version. Each SDK call has a 10-second
transport timeout and no automatic retries; the operation lease is 90 seconds.

Explicit customer/price/subscription import requires a trusted cohort and live
provider reads. New subscription resolution reads at most two Checkout entries,
requires `has_more=false` and exactly one entry, then matches its completed session
to the exact succeeded durable operation, owner, customer and price. Provider reads
are read-only; the resulting verified binding **does mutate local SQL**. Expired
hosted URLs cannot replay, but durable Checkout evidence remains usable for late
binding. No event metadata attributes an object to a store. These methods currently
support one quantity-one monthly or yearly recurring item; unsupported snapshots
fail closed.

Pending: technical review; real test-mode sandbox (Checkout vs Test Clock scenarios
reported separately); image CI; SDK publication/packed consumer; Mercaria adoption
and cohort activation. Mercaria's existing verified Stripe webhook stays the
transitional status/entitlement projector with its deduplication. Peable becomes
the cohort's mutator; this checkpoint does not claim consolidated ingress. The
previous private mirror's historical `no_mapping` limitation remains. Oxy's
transitional adapter, marketplace transfers, one-off payments and financial policy
are not replaced here. I08 stays open.

Primary wire references used for the adapter correction: [Stripe Checkout
retrieval](https://docs.stripe.com/api/checkout/sessions/retrieve) (`cs_test_...`)
and [Portal session creation](https://docs.stripe.com/api/customer_portal/sessions/create)
(`bps_...`, explicit configuration). No real provider call was needed to reproduce
the initial Checkout parser defect.
