-- oxy:deploy-phase=pre
-- `GET /v1/payment_intents?customer=`. On the hot table, so IF NOT EXISTS: build it
-- CONCURRENTLY out of band first and this is a no-op over it.
CREATE INDEX IF NOT EXISTS "payment_intents_customer_id_idx" ON "payment_intents" USING btree ("customer_id");
