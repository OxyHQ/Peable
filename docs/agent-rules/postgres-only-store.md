<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# PostgreSQL is the only store

There is no `src/models/` and no `src/db.ts` — every route, service and test
reads and writes Postgres through the repositories in `src/db/**`, and nothing
reaches a driver directly.

**`DATABASE_URL` is REQUIRED to boot.** `config.ts` refuses to load without it
and `server.ts` calls `connectPostgres()` — which proves the connection with one
round trip — before anything listens. A task definition missing it crash-loops
with a message naming the variable, instead of serving requests that all 500.

Production uses the existing `oxypay` database on the shared `oxy-postgres` RDS
instance so the OxyPay-to-Peable product rename preserves every merchant and
payment record. The database name is an internal legacy identifier, not a
separate product. **No extensions** (an explicit empty list in
`src/db/migrate.ts`).

- **Every id is two ids, and confusing them is silent.** A public `pi_…` /
  `merch_…` / `link_…` / `cs_…` lives in `public_id` and is what the wire
  contracts call `id`; `id` itself is the internal primary key that other tables
  reference — never the public one. Both ids
  are on shipped contracts (`CheckoutSession.payment_intent` carries the
  `pi_…`, `WebhookDelivery.event_id` / `webhook_endpoint_id` the `evt_…` /
  `we_…`), which is why `listDeliveriesForMerchant` joins the public ids in
  rather than the DTO emitting the internal ones, and why `findIntentById` (by primary key) is a
  DIFFERENT function from `findIntentByPublicId`. The socket room is keyed by
  the PUBLIC id — keying `emitIntentUpdate` by the internal one would emit into
  a room nobody is in and lose every realtime update silently.

- **Schema decisions live in `packages/backend/src/db/schema/CONVENTIONS.md`**
  and that file is binding. Read it before touching a table; it records what
  each decision is AND why the obvious alternative is wrong, including three
  CHECK constraints that look obvious and would refuse a legal write.
- **Migrations:** `bun run db:generate` writes the SQL, and every generated file
  needs exactly one `-- oxy:deploy-phase=pre|post` marker — there is no default.
  `bun run db:migrate -- --target-database=<name> --phase=<pre|post|all>` is the
  ONLY thing that applies it; `drizzle-kit migrate` is a devDependency and cannot
  reach the production image. `--phase=all` is for a from-zero genesis, never a
  normal release.
- **New migrations keep their locks short.** `oxypay` lives on the shared
  `oxy-postgres` instance, so CI runs `bun run --cwd packages/backend
  db:check-locks` (`@oxy.so/db`'s `oxy-db-check-migration-locks`): constraints
  on existing tables go in `NOT VALID` and are validated later, and hot-table
  DDL sits alone in its migration. The script's `--after` is the baseline (older
  migrations are not re-judged) and `--hot-tables` names the busy tables.
- **The runtime image runs TypeScript source under Bun**, so migrations live
  under `src/db/migrations/` and are copied into the image with everything else
  in `src/`. Do not move them to a package-root `drizzle/` folder without
  changing the Dockerfile.
- **Tests need a real server.** `docker compose -f docker-compose.postgres.yml
  up -d`, then `TEST_DATABASE_URL=postgres://peable:peable@localhost:5439/postgres`
  AND `DATABASE_URL=postgres://peable:peable@localhost:5439/peable`. The second
  is needed because `config.ts` refuses to load without it — including in tests
  that never touch the database — and is NOT what the suites connect to: each
  test FILE gets its own throwaway, fully-migrated database via
  `useGatewayDatabase()` (`src/__tests__/helpers/gatewayTestDatabase.ts`), which
  also points `getDb()` at it so production code works unchanged. Seed state
  with the `seedX()` helpers rather than raw inserts — they go through the real
  repositories, so every invariant a repository enforces runs on seeded rows.
  `db/__tests__/schemaGates.realdb.test.ts` turns a missing `TEST_DATABASE_URL`
  into a red build when `CI` is set.

