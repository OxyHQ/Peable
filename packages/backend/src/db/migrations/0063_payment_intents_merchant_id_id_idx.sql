-- oxy:deploy-phase=pre
-- Every list and search of payment intents walks `merchant_id = … order by id desc
-- limit n`. On the hot table, alone, and IF NOT EXISTS: build it CONCURRENTLY out
-- of band first and this is a no-op over it.
CREATE INDEX IF NOT EXISTS "payment_intents_merchant_id_id_idx" ON "payment_intents" USING btree ("merchant_id","id");
