-- oxy:deploy-phase=pre
-- ADR 0021 D9: a recipient's FairCoin address pool. An output records the index
-- its address derives at, and an address whose payment was cancelled and that
-- the chain shows never received anything can be handed to a later payment
-- (`recycled_at` on the row it leaves). The address uniqueness becomes "one
-- HOLDER per address": unique among outputs not recycled. The running image
-- never recycles, so swapping the index under it changes nothing it does.
-- payment_intent_outputs is not a hot table; nullable columns, no defaults; the
-- CHECK is NOT VALID here (added by hand) and validated in 0106 (post).
DROP INDEX "payment_intent_outputs_network_address_key";--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" ADD COLUMN "derivation_index" integer;--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" ADD COLUMN "recycled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payment_intent_outputs_recipient_pool_idx" ON "payment_intent_outputs" USING btree ("recipient_account_id","network","derivation_index") WHERE "payment_intent_outputs"."recycled_at" is null and "payment_intent_outputs"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intent_outputs_network_address_key" ON "payment_intent_outputs" USING btree ("network","address") WHERE "payment_intent_outputs"."recycled_at" is null;--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" ADD CONSTRAINT "payment_intent_outputs_derivation_index_check" CHECK (derivation_index is null or derivation_index >= 1) NOT VALID;