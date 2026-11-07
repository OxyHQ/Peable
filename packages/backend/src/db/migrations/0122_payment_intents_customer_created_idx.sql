-- oxy:deploy-phase=pre
-- Risk rules (ADR 0022), part 2 of 3: the velocity facts read a customer's
-- payments of the last seven days as a range of `(customer_id, created_at)`.
-- On the hot table, alone, and IF NOT EXISTS: build it CONCURRENTLY out of band
-- first and this is a no-op over it.
CREATE INDEX IF NOT EXISTS "payment_intents_customer_id_created_at_idx" ON "payment_intents" USING btree ("customer_id","created_at");
