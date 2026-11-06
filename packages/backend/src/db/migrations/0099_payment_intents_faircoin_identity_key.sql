-- oxy:deploy-phase=pre
-- ADR 0002 (amended 2026-11-06): every FairCoin address records the identity
-- key it was derived from, and a payment broadcast under a replaced key says so.
-- Hot table: this DDL alone, both columns nullable with no default (catalog
-- only); the CHECKs — the two new ones and the cancellation reasons widened by
-- `recipient_key_changed`, re-added by hand — are NOT VALID, so the ACCESS
-- EXCLUSIVE lock never scans. 0101 (post) validates them.
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_cancellation_reason_check";--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "faircoin_identity_public_key" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "faircoin_recipient_key_replaced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_faircoin_identity_key_check" CHECK (faircoin_identity_public_key is null or (rail = 'faircoin' and faircoin_identity_public_key ~ '^(0[23][0-9a-f]{64}|04[0-9a-f]{128})$')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_faircoin_key_replaced_check" CHECK ("payment_intents"."faircoin_recipient_key_replaced_at" is null or "payment_intents"."rail" = 'faircoin') NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_cancellation_reason_check" CHECK (cancellation_reason is null or cancellation_reason in ('abandoned', 'automatic', 'duplicate', 'fraudulent', 'recipient_key_changed', 'requested_by_customer', 'underpaid')) NOT VALID;