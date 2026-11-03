-- oxy:deploy-phase=pre
-- ADR 0015 §1 — one own account per merchant. On the hot table, so IF NOT
-- EXISTS: build it CONCURRENTLY out of band first and this is a no-op over it.
CREATE UNIQUE INDEX IF NOT EXISTS "connected_accounts_merchant_role_key" ON "connected_accounts" USING btree ("merchant_id") WHERE "connected_accounts"."role" = 'merchant';
